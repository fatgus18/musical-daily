import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apps = ["musical-daily", "blackjack-music", "tempo-trap", "artist-encore", "double-or-drop"];
const files = [["display-client.tsx", "src/components/display-client.tsx"], ["display-preferences.ts", "src/components/display-preferences.ts"], ["display.css", "src/app/display.css"]];
const check = process.argv.includes("--check"), mismatches = [];
for (const app of apps) for (const [sourceName, destinationName] of files) {
  const source = resolve(root, "shared/display", sourceName), destination = resolve(root, app, destinationName);
  if (check) { try { if (!readFileSync(source).equals(readFileSync(destination))) mismatches.push(`${app}/${destinationName}`); } catch { mismatches.push(`${app}/${destinationName}`); } }
  else { mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination); }
}
if (mismatches.length) { console.error(`Run node scripts/sync-display.mjs:\n${mismatches.join("\n")}`); process.exitCode = 1; }
else console.log(check ? "Display preferences match across all five apps." : "Synced display preferences to all five apps.");
