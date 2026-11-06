import { readFileSync } from "node:fs";

/** Optional existing CLI-authenticated cookie, constrained to this deployment. */
export function previewAuth(baseURL: string) {
  const file = process.env.VERCEL_TEST_COOKIE_FILE;
  if (!file) return undefined;
  const host = new URL(baseURL).hostname;
  const cookies = readFileSync(file, "utf8").split(/\r?\n/).flatMap(line => {
    if (!line || line.startsWith("#") && !line.startsWith("#HttpOnly_")) return [];
    const fields = line.replace(/^#HttpOnly_/, "").split("\t");
    if (fields.length !== 7 || fields[0].replace(/^\./, "") !== host || fields[5] !== "_vercel_jwt") return [];
    return [{ name: fields[5], value: fields[6], domain: host, path: fields[2], secure: true, httpOnly: true,
      expires: Number(fields[4]) || -1, sameSite: "Lax" as const }];
  });
  if (!cookies.length) throw new Error("The CLI cookie file has no authentication for this deployment.");
  return { cookies, origins: [] };
}
