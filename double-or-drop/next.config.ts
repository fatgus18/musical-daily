import type { NextConfig } from "next";
import { resolve } from "node:path";

const config: NextConfig = {
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
  poweredByHeader: false,
  transpilePackages: ["@musical-daily/accounts"],
  turbopack: { root: resolve(process.cwd(), "..") },
  outputFileTracingRoot: resolve(process.cwd(), ".."),
  outputFileTracingIncludes: { "/api/*": ["./data/catalog-releases.json", "./data/catalog-releases/*.json"] },
  outputFileTracingExcludes: { "/api/*": ["./data/*.sqlite*", "./data/runtime/**"] },
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ] }];
  },
};
export default config;
