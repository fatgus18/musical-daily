import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Compatibility entry point. Both games now consume dated shared-catalog releases.
const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../music-catalog/src/cli.ts", import.meta.url)), "maintain", ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;