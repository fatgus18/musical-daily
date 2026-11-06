import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const versions = name => Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${name}`)).map(([, entry]) => entry.version);

// A lock generated over an existing Windows node_modules tree can omit these
// optional packages. It installs locally, then fails on Vercel's Linux builder.
for (const [parent, native] of [
  ["next", "@next/swc-linux-x64-gnu"],
  ["lightningcss", "lightningcss-linux-x64-gnu"],
  ["@tailwindcss/oxide", "@tailwindcss/oxide-linux-x64-gnu"],
  ["libsql", "@libsql/linux-x64-gnu"],
]) {
  test(`the lock includes matching Linux native packages for ${parent}`, () => {
    assert.ok(versions(parent).length, `${parent} must be installed`);
    for (const version of versions(parent)) assert.ok(versions(native).includes(version), `${native}@${version} is missing; regenerate the lock without an existing node_modules tree`);
  });
}
