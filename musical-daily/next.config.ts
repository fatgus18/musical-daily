import type { NextConfig } from "next";
import { resolve } from "node:path";
const config: NextConfig = { poweredByHeader: false, transpilePackages: ["@musical-daily/accounts"], turbopack: { root: resolve(process.cwd(), "..") } };
export default config;
