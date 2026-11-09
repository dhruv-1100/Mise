import type { NextConfig } from "next";

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // Not stricter: YouTube's embedded player refuses to play with no referrer.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Named features only. Cook mode needs screen-wake-lock, the player needs the
  // ones on its iframe's `allow`, and neither is listed here.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // The directives that need no nonce. A script-src policy would, and nonces
  // force every page into dynamic rendering. No form-action either: Chrome
  // applies it to redirects, which would block the sign-in hand-off to Google.
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  },
];

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source, not build output — Next
  // compiles them in-place so there is no build-ordering problem.
  transpilePackages: ["@mise/scaling", "@mise/schema"],

  // @grpc/grpc-js is a native-ish Node library. Marking it external keeps the
  // bundler from trying to trace and rewrite it, which it does badly.
  serverExternalPackages: ["@grpc/grpc-js"],

  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
