import { describe, expect, it } from "vitest";

import { splitStatements } from "../scripts/migrate.mjs";

/**
 * The splitter is the one piece of the migration runner that can be wrong
 * quietly. A bad split does not throw — it sends half a statement to Postgres,
 * or silently drops the second half of a DO block, and the schema ends up
 * subtly different from what the file says.
 */
describe("splitStatements", () => {
  it("splits plain statements", () => {
    expect(splitStatements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("does not need a trailing semicolon", () => {
    expect(splitStatements("SELECT 1")).toEqual(["SELECT 1"]);
  });

  it("drops transaction control, which the caller supplies itself", () => {
    expect(splitStatements("BEGIN; SELECT 1; COMMIT;")).toEqual(["SELECT 1"]);
  });

  it("keeps a dollar-quoted body whole", () => {
    // The exact shape migration 0002 uses for CREATE DOMAIN. Split naively on
    // ";" this becomes four broken fragments.
    const sql = `
      DO $$
      BEGIN
        CREATE DOMAIN d AS text CHECK (VALUE ~ '^x$');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END
      $$;
      SELECT 1;
    `;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("duplicate_object");
    expect(statements[0]!.endsWith("$$")).toBe(true);
    expect(statements[1]).toBe("SELECT 1");
  });

  it("handles a tagged dollar quote", () => {
    const statements = splitStatements("DO $body$ SELECT 1; SELECT 2; $body$; SELECT 3;");
    expect(statements).toHaveLength(2);
    expect(statements[1]).toBe("SELECT 3");
  });

  it("ignores semicolons inside string literals", () => {
    const statements = splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;");
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("'a;b'");
  });

  it("handles an escaped quote inside a literal", () => {
    const statements = splitStatements("SELECT 'it''s; fine'; SELECT 2;");
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe("SELECT 'it''s; fine'");
  });

  it("strips line comments, semicolons and all", () => {
    const statements = splitStatements("-- a comment; with a semicolon\nSELECT 1;");
    expect(statements).toEqual(["SELECT 1"]);
  });

  it("strips nested block comments", () => {
    const statements = splitStatements("/* outer /* inner; */ still comment; */ SELECT 1;");
    expect(statements).toEqual(["SELECT 1"]);
  });

  it("produces no empty statements from trailing whitespace", () => {
    expect(splitStatements("SELECT 1;\n\n  \n")).toEqual(["SELECT 1"]);
  });
});
