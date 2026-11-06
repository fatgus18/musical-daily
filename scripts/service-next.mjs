import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { serviceEnvironment } from "./service-config.mjs";

const [name, command, ...extra] = process.argv.slice(2);
if (!["build", "dev", "start"].includes(command)) throw new Error("Usage: service-next.mjs <service> <build|dev|start> [Next.js arguments]");
const env = serviceEnvironment(name);
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, name);
const requireFromService = createRequire(resolve(directory, "package.json"));
const args = [requireFromService.resolve("next/dist/bin/next"), command, ...extra];
if (command !== "build" && env.PORT && !extra.some(value => value === "-p" || value === "--port")) args.push("--port", env.PORT);
const child = spawn(process.execPath, args, { cwd: directory, env, stdio: "inherit" });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { child.kill(signal); });
