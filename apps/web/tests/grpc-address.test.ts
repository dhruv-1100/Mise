import { describe, expect, it } from "vitest";

import { isLoopback } from "../lib/grpc-address";

/**
 * This decides whether the gRPC channel uses TLS, and it fails silently in one
 * direction: an insecure channel to a TLS endpoint reports UNAVAILABLE, which
 * is indistinguishable from the extractor being down. Worth pinning both ways.
 */
describe("isLoopback", () => {
  it.each([
    "127.0.0.1:50051",
    "localhost:50051",
    "[::1]:50051",
    "0.0.0.0:50051",
    // 127.0.0.0/8 is all loopback, not just .1 — a docker-compose setup can
    // legitimately land on 127.0.0.2.
    "127.0.0.2:50051",
    "127.255.255.254:8080",
  ])("treats %s as local, so the channel stays insecure", (address) => {
    expect(isLoopback(address)).toBe(true);
  });

  it.each([
    // The shape Cloud Run actually hands out.
    "mise-extractor-abc123-uc.a.run.app:443",
    "mise-extractor-abc123-uc.a.run.app",
    "10.0.0.5:50051",
    "example.com:50051",
    // Near-misses that must not be mistaken for loopback.
    "127.0.0.1.example.com:443",
    "notlocalhost:50051",
    "localhost.evil.com:443",
    "1270.0.1:50051",
  ])("treats %s as remote, so the channel gets TLS", (address) => {
    expect(isLoopback(address)).toBe(false);
  });

  it("defaults to remote for anything it cannot parse", () => {
    // Failing closed matters: an unparseable address getting an insecure
    // channel would be the one mistake with security consequences.
    expect(isLoopback("")).toBe(false);
    expect(isLoopback(":::")).toBe(false);
  });
});
