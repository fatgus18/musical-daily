import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apps = ["musical-daily", "blackjack-music", "tempo-trap", "artist-encore", "double-or-drop"];
const files = [["account-client.tsx", "src/components/account-client.tsx"], ["account-requests.ts", "src/components/account-requests.ts"], ["account-client.css", "src/app/account-client.css"]];
const check = process.argv.includes("--check");
const mismatches = [];
for (const app of apps) for (const [sourceName, destinationName] of files) {
  const source = resolve(root, "shared/account-ui", sourceName);
  const destination = resolve(root, app, destinationName);
  if (check) {
    try { if (!readFileSync(source).equals(readFileSync(destination))) mismatches.push(`${app}/${destinationName}`); }
    catch { mismatches.push(`${app}/${destinationName}`); }
  } else { mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination); }
}
if (mismatches.length) { console.error(`Account UI differs. Run node scripts/sync-account-ui.mjs:\n${mismatches.join("\n")}`); process.exitCode = 1; }
else console.log(check ? "Account UI matches in all five apps." : "Synced account UI to all five apps.");
