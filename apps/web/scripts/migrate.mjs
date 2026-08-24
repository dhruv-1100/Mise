/**
 * Migration runner.
 *
 * Applies every unapplied file in apps/extractor/migrations/ in filename order,
 * each inside a single transaction, and records what it applied.
 *
 *   pnpm --filter @mise/web migrate         # apply
 *   pnpm --filter @mise/web migrate --dry   # list what would run, touch nothing
 *
 * Two things about this file are deliberate and worth reading before changing.
 *
 * WHY IT IS NOT psql. Postgres listens on 5432, and a lot of the places this
 * needs to run from — CI runners, corporate networks, the sandbox it was
 * written in — allow only 443 outbound. @neondatabase/serverless carries SQL
 * over HTTPS, so the runner reaches the database from anywhere the application
 * itself can. The .sql files stay plain SQL and remain psql-compatible for
 * anyone who has the port.
 *
 * WHY IT LIVES IN apps/web. The migrations describe tables that only the web
 * app reads and writes; the extractor's state is in Redis. The .sql files stay
 * under apps/extractor/migrations/ because that is where CLAUDE.md says
 * migrations live and where 0001 already is. Moving them is a bigger decision
 * than this phase should make quietly.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { neon } from "@neondatabase/serverless";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "extractor", "migrations");
const DRY = process.argv.includes("--dry");

/**
 * Split a migration into individual statements.
 *
 * Neon's HTTP endpoint uses the extended query protocol, which carries exactly
 * one statement per request — so the file has to be split rather than sent
 * whole. Splitting SQL on ";" is famously wrong, and this handles the three
 * ways it goes wrong in the migrations we actually write:
 *
 *   - dollar-quoted bodies ($$ ... $$, $tag$ ... $tag$), which contain
 *     semicolons and are how DO blocks and functions are written
 *   - single-quoted literals containing ';' or '$'
 *   - line and block comments, which contain anything at all
 *
 * BEGIN/COMMIT are recognised and dropped: the caller wraps the whole file in
 * one transaction already, and a nested BEGIN inside it is an error. They stay
 * in the .sql files so those files are still correct under psql.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = "";
  let i = 0;

  while (i < sql.length) {
    const rest = sql.slice(i);

    // Line comment: runs to end of line.
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }

    // Block comment. Postgres nests these; so does this.
    if (rest.startsWith("/*")) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) { depth++; i += 2; }
        else if (sql.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      continue;
    }

    // Single-quoted literal. '' is an escaped quote, not a close-then-open.
    if (rest.startsWith("'")) {
      current += "'";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { current += "''"; i += 2; continue; }
        if (sql[i] === "'") { current += "'"; i++; break; }
        current += sql[i];
        i++;
      }
      continue;
    }

    // Dollar quote: $$ or $tag$. Everything up to the matching close is opaque.
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar !== null) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      const end = close === -1 ? sql.length : close + tag.length;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    if (sql[i] === ";") {
      statements.push(current);
      current = "";
      i++;
      continue;
    }

    current += sql[i];
    i++;
  }
  statements.push(current);

  return statements
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !/^(BEGIN|COMMIT|END)$/i.test(s));
}

function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const body = readFileSync(join(MIGRATIONS, name), "utf8");
      return { name, body, checksum: createHash("sha256").update(body).digest("hex") };
    });
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    console.error("  terraform -chdir=infra output -raw database_url_pooled");
    process.exit(1);
  }

  const sql = neon(url, { fullResults: true });

  await sql.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await sql.query("SELECT name, checksum FROM schema_migrations");
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));

  let ran = 0;
  for (const file of migrationFiles()) {
    const seen = applied.get(file.name);

    if (seen !== undefined) {
      // An applied migration that has since been edited is a real problem: this
      // database and a fresh one no longer agree, and nothing else will tell
      // you. Loud and non-fatal — the fix is a new migration, not a rerun.
      if (seen !== file.checksum) {
        console.warn(`!  ${file.name} was edited after it was applied`);
        console.warn("   This database and a fresh one now differ. Write a new migration.");
      } else {
        console.log(`.  ${file.name}`);
      }
      continue;
    }

    const statements = splitStatements(file.body);
    if (DRY) {
      console.log(`?  ${file.name} — would run ${statements.length} statement(s)`);
      ran++;
      continue;
    }

    // One HTTP request, one transaction: the file applies whole or not at all,
    // and the bookkeeping row commits with it. A migration that succeeded but
    // was not recorded would be re-applied on the next run.
    await sql.transaction((txn) => [
      ...statements.map((s) => txn.query(s)),
      txn.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
        file.name,
        file.checksum,
      ]),
    ]);

    console.log(`+  ${file.name} — ${statements.length} statement(s)`);
    ran++;
  }

  console.log(ran === 0 ? "\nup to date" : `\n${DRY ? "would apply" : "applied"} ${ran}`);
}

// Importable for tests without running anything.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nmigration failed: ${err.message}`);
    process.exit(1);
  });
}
