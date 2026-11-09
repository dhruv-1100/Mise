import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

const { enveloped } = await import("../lib/api");
const { ExtractorError } = await import("../lib/extractor");

describe("enveloped", () => {
  it("passes a response through untouched", async () => {
    const response = await enveloped(async () => NextResponse.json({ ok: true }))();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("turns an unexpected exception into the envelope without leaking it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await enveloped(async () => {
      throw new Error("password authentication failed for user mise_app");
    })();

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("internal_error");
    expect(body.detail).not.toContain("mise_app");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("reports an extractor outage as unavailable, not missing", async () => {
    const response = await enveloped(async () => {
      throw new ExtractorError("unavailable", "down");
    })();

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("unavailable");
  });

  it("carries the retry hint on backpressure", async () => {
    const response = await enveloped(async () => {
      throw new ExtractorError("queue_full", "busy", 30);
    })();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("does not swallow Next's own control flow", async () => {
    await expect(
      enveloped(async () => {
        notFound();
      })(),
    ).rejects.toThrow();
  });
});
