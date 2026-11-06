import type { NextConfig } from "next";
import path from "node:path";
const config: NextConfig = {
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
  transpilePackages: ["@musical-daily/accounts"],
  outputFileTracingRoot: path.resolve(process.cwd(), ".."),
  turbopack: { root: path.resolve(process.cwd(), "..") },
  poweredByHeader: false,
  outputFileTracingIncludes: { "/api/*": ["./data/catalog-releases/*.json"] },
  async headers() { return [{ source: "/(.*)", headers: [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
  ] }]; },
};
export default config;
