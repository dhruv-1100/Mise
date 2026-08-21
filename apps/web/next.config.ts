import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source, not build output — Next
  // compiles them in-place so there is no build-ordering problem.
  transpilePackages: ["@mise/scaling", "@mise/schema"],

  // @grpc/grpc-js is a native-ish Node library. Marking it external keeps the
  // bundler from trying to trace and rewrite it, which it does badly.
  serverExternalPackages: ["@grpc/grpc-js"],
};

export default nextConfig;
