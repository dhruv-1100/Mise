import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source, not build output — Next
  // compiles them in-place so there is no build-ordering problem.
  transpilePackages: ["@mise/scaling", "@mise/schema"],
};

export default nextConfig;
