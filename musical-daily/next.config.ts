import type { NextConfig } from "next";
import { resolve } from "node:path";
const config: NextConfig = {
  poweredByHeader: false,
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
  transpilePackages: ["@musical-daily/accounts", "@musical-daily/database"],
  turbopack: { root: resolve(process.cwd(), "..") },
  outputFileTracingRoot: resolve(process.cwd(), ".."),
  outputFileTracingExcludes: { "/api/*": ["./data/*.sqlite*", "./.env*"] },
};
export default config;
