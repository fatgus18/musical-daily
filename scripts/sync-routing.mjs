import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apps = ["musical-daily", "blackjack-music", "tempo-trap", "artist-encore", "double-or-drop"];
const source = resolve(root, "shared/routing/app-path.ts");
const check = process.argv.includes("--check");
const mismatches = [];
for (const app of apps) {
  const destination = resolve(root, app, "src/lib/app-path.ts");
  if (check) {
    try { if (!readFileSync(source).equals(readFileSync(destination))) mismatches.push(`${app}/src/lib/app-path.ts`); }
    catch { mismatches.push(`${app}/src/lib/app-path.ts`); }
  } else {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}
if (mismatches.length) {
  console.error(`Routing helpers differ. Run node scripts/sync-routing.mjs:\n${mismatches.join("\n")}`);
  process.exitCode = 1;
} else console.log(check ? "Routing helpers match in all five apps." : "Synced routing helpers to all five apps.");
