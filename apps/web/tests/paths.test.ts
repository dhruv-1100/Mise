import { describe, expect, it } from "vitest";

import { safeNextPath } from "../lib/paths";

describe("safeNextPath", () => {
  it("keeps an ordinary same-site path", () => {
    expect(safeNextPath("/r/5BYEBHVCs6M")).toBe("/r/5BYEBHVCs6M");
    expect(safeNextPath("/me")).toBe("/me");
    expect(safeNextPath("/r/abc/edit?x=1")).toBe("/r/abc/edit?x=1");
  });

  it("falls back when nothing was asked for", () => {
    expect(safeNextPath(undefined)).toBe("/me");
    expect(safeNextPath("")).toBe("/me");
    expect(safeNextPath(undefined, "/")).toBe("/");
  });

  // Each of these is a working open redirect against a naive startsWith("/")
  // check, which is exactly what this function replaced.
  it.each([
    ["absolute http", "http://evil.example/"],
    ["absolute https", "https://evil.example/"],
    ["protocol-relative", "//evil.example/"],
    ["protocol-relative with path", "//evil.example/signin"],
    ["backslash pair", "/\\evil.example"],
    ["backslash escape", "\\\\evil.example"],
    ["embedded scheme", "/redirect?to=https://evil.example"],
    ["no leading slash", "evil.example"],
    ["scheme-ish", "javascript:alert(1)"],
  ])("refuses %s", (_label, hostile) => {
    expect(safeNextPath(hostile)).toBe("/me");
  });
});
