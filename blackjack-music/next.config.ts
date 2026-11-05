import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  transpilePackages: ["@musical-daily/accounts"],
  outputFileTracingRoot: path.resolve(process.cwd(), ".."),
  outputFileTracingIncludes: { "/api/*": ["./data/catalog-releases/*.json", "./data/artwork.json"] },
  outputFileTracingExcludes: { "/api/*": ["./data/runtime/**", "./data/*.sqlite*", "./.env*"] },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "i.scdn.co" }],
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    root: path.resolve(process.cwd(), ".."),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
