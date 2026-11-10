import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apps = ["musical-daily", "blackjack-music", "tempo-trap", "artist-encore", "double-or-drop"];
const files = ["pixel-system.css", "arcade-system.css"];
const check = process.argv.includes("--check");
const mismatches = [];
for (const app of apps) for (const file of files) {
  const source = resolve(root, "shared/design", file);
  const destination = resolve(root, app, "src/app", file);
  if (check) {
    try {
      if (!readFileSync(source).equals(readFileSync(destination))) mismatches.push(`${app}/${file}`);
    } catch { mismatches.push(`${app}/${file}`); }
  } else {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}
if (mismatches.length) {
  console.error(`Design foundation differs in ${mismatches.join(", ")}. Run node scripts/sync-design.mjs.`);
  process.exitCode = 1;
} else console.log(check ? "Design foundation matches across all five apps." : "Synced the design foundation to all five apps.");
