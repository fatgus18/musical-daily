import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apps = ["musical-daily", "blackjack-music", "tempo-trap", "artist-encore", "double-or-drop"];
const files = [
  ["musical-daily.svg", "public/brand/musical-daily.svg"],
  ["musical-daily-brand.tsx", "src/components/musical-daily-brand.tsx"],
  ["musical-daily-brand.css", "src/app/musical-daily-brand.css"],
];
const check = process.argv.includes("--check");
const mismatches = [];
for (const app of apps) {
  for (const [sourceName, destinationName] of files) {
    const source = resolve(root, "shared/brand", sourceName);
    const destination = resolve(root, app, destinationName);
    if (check) {
      try {
        if (!readFileSync(source).equals(readFileSync(destination))) mismatches.push(`${app}/${destinationName}`);
      } catch { mismatches.push(`${app}/${destinationName}`); }
    } else {
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
  }
}
if (mismatches.length) {
  console.error(`Brand files differ. Run node scripts/sync-brand.mjs:\n${mismatches.join("\n")}`);
  process.exitCode = 1;
} else console.log(check ? "The Musical Daily brand is identical in all five apps." : "Synced Musical Daily branding to all five apps.");
