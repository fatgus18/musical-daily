// SVGs are the editable source; checked-in raster copies need no runtime service.
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";

const fromTempo = createRequire(new URL("../tempo-trap/package.json", import.meta.url));
const sharp = createRequire(fromTempo.resolve("next/package.json"))("sharp");
const check = process.argv.includes("--check");
const mismatches = [];
for (const app of ["blackjack-music", "tempo-trap", "artist-encore", "double-or-drop"]) {
  const directory = new URL(`../${app}/src/app/`, import.meta.url);
  const source = await readFile(new URL("icon.svg", directory));
  const background = source.toString("utf8").match(/<rect\b[^>]*\bfill="(#[a-fA-F0-9]{6})"/)?.[1];
  if (!background) throw new Error(`${app}: expected a solid background rectangle in icon.svg`);
  for (const [name, size] of [["icon.png", 64], ["apple-icon.png", 180]]) {
    const raster = sharp(source, { density: 288 }).resize(size, size);
    // Home-screen launchers apply their own corner mask to an opaque square.
    if (name === "apple-icon.png") raster.flatten({ background });
    const image = await raster.png().toBuffer();
    const destination = new URL(name, directory);
    if (check) {
      const current = await readFile(destination).catch(() => null);
      if (!current?.equals(image)) mismatches.push(`${app}/src/app/${name}`);
    } else await writeFile(destination, image);
  }
}
if (mismatches.length) throw new Error(`Run node scripts/sync-game-icons.mjs to update:\n${mismatches.join("\n")}`);
console.log(check ? "All four games' icon formats match their SVGs." : "Generated browser PNG and Apple icons for all four games.");
