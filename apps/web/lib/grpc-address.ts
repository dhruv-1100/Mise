/**
 * Where the extractor is, and therefore how to talk to it.
 *
 * Deliberately a separate module from lib/extractor.ts, which is `server-only`
 * and pulls in @grpc/grpc-js. This is pure string logic with no imports, so it
 * can be unit tested — and it is the kind of logic that fails silently in one
 * direction, which is exactly what CLAUDE.md says this suite is for.
 */

/**
 * Is this address on this machine?
 *
 * Decides transport security, and the choice is made from the address rather
 * than from NODE_ENV. NODE_ENV describes how the bundle was built, not where
 * the extractor is: `next dev` pointed at the deployed Cloud Run service must
 * still use TLS, and a production build talking to a sidecar on loopback must
 * not. Keying on the thing that actually determines the answer removes a whole
 * category of "works locally, fails deployed".
 */
export function isLoopback(address: string): boolean {
  // Strip the port. A bracketed IPv6 host ("[::1]:50051") keeps its brackets,
  // so the bracket form has to be handled before splitting on ":".
  const host = address.startsWith("[")
    ? address.slice(1, address.indexOf("]"))
    : (address.split(":")[0] ?? "");

  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    // The whole 127.0.0.0/8 block, not just 127.0.0.1.
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}
