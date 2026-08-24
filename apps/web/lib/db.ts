import "server-only";

import { neon } from "@neondatabase/serverless";
import type { Pool } from "pg";

/**
 * The database seam.
 *
 * Hand-written SQL over Neon's HTTP driver. No ORM, for the same reason
 * packages/schema is hand-written zod rather than generated: the queries here
 * are few, they are the contract, and an ORM would hide the one thing worth
 * looking at.
 *
 * WHY HTTP AND NOT A TCP POOL. @neondatabase/serverless can speak either. The
 * HTTP path carries SQL over HTTPS on 443, which matters twice: serverless
 * functions on Vercel are short-lived and would otherwise exhaust Postgres'
 * connection limit holding sockets open, and 5432 is blocked on a lot of
 * networks. The cost is that a transaction has to be expressed as one batched
 * `transaction()` call rather than held open across awaits. Nothing here needs
 * an interactive transaction; if something ever does, that is the moment to
 * reach for the WebSocket Pool, not before.
 */

const url = process.env.DATABASE_URL;

/**
 * Absence of DATABASE_URL is a normal state, not a crash.
 *
 * The public surface — paste a URL, get a recipe — has no accounts in it and
 * must keep working when the database is unreachable or unconfigured. Every
 * caller here goes through `requireDb()`, which fails loudly at the point of
 * use, so an unconfigured deployment degrades to "signed out" instead of a
 * 500 on the home page.
 */
const client = url === undefined ? null : neon(url, { fullResults: true });

export const isConfigured = client !== null;

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

function requireDb() {
  if (client === null) {
    throw new Error("DATABASE_URL is not set; accounts are unavailable");
  }
  return client;
}

/**
 * Run a parameterised query.
 *
 * `params` is the only way values reach SQL in this file and everything that
 * imports it. There is no string interpolation of user input anywhere in the
 * codebase, and there should never be one.
 */
export async function query<Row>(text: string, params: unknown[] = []): Promise<QueryResult<Row>> {
  const result = await requireDb().query(text, params);
  return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
}

/** The single row, or null. Throws if the query returned more than one. */
export async function queryOne<Row>(text: string, params: unknown[] = []): Promise<Row | null> {
  const { rows } = await query<Row>(text, params);
  if (rows.length > 1) {
    throw new Error(`expected at most one row, got ${rows.length}`);
  }
  return rows[0] ?? null;
}

/**
 * The same client, shaped for @auth/pg-adapter.
 *
 * The adapter is typed against `pg`'s Pool but only ever calls
 * `client.query(sql, params)` and reads `.rows` / `.rowCount` off the result —
 * verified by reading its source, not assumed. Neon's HTTP client with
 * `fullResults: true` returns exactly that shape, confirmed against the live
 * database before this was written. `pg` itself is a types-only devDependency
 * here; no TCP driver is bundled.
 *
 * The cast is the honest expression of that: a structural match the type system
 * cannot see, narrowed to one line with the reasoning next to it.
 */
export function adapterClient(): Pool {
  return requireDb() as unknown as Pool;
}
