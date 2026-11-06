import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { catalogVersion, validateCatalog, MAX_CATALOG_BYTES } from "./catalog.ts";
import type { Catalog, CatalogSource, CatalogTrack } from "./catalog-types.ts";
import { persistArtistCatalog } from "./catalog-storage.ts";

async function atomic(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, "utf8"); await rename(temporary, path);
}

/** Artist packs do not replace the broad library pointer. All saved versions remain immutable. */
export async function publishCatalog(tracks: CatalogTrack[], sources: CatalogSource[], output?: string, makeCurrent = true): Promise<Catalog> {
  const uniqueSources = [...new Map(sources.map(source => [source.id, source])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const catalog: Catalog = { schema: 1, version: catalogVersion(tracks, uniqueSources), createdAt: new Date().toISOString(), tracks, sources: uniqueSources };
  validateCatalog(catalog);
  // Runtime discovery writes durable snapshots, never the read-only function bundle.
  // Maintenance commands pass an explicit output directory for checked-in releases.
  if (!makeCurrent && output === undefined) return persistArtistCatalog(catalog);
  output ??= process.env.DOUBLE_DROP_CATALOG_DIR || resolve(process.cwd(), "data");
  const json = JSON.stringify(catalog) + "\n";
  if (Buffer.byteLength(json) > MAX_CATALOG_BYTES) throw new Error("Catalog metadata exceeds the deployment memory budget.");
  const file = resolve(output, "catalog-releases", `${catalog.version}.json`);
  let exists = false;
  try { const previous = JSON.parse(await readFile(file, "utf8")) as Catalog; validateCatalog(previous); exists = true; catalog.createdAt = previous.createdAt; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!exists && !makeCurrent) {
    // Never evict a pinned run to make room for provider browsing. Maintenance prunes
    // only unreferenced releases; while full, already-loaded collections still work.
    const directory = resolve(output, "catalog-releases");
    await mkdir(directory, { recursive: true });
    const budget = Number(process.env.DOUBLE_DROP_CATALOG_DISK_BUDGET_BYTES || 256 * 1024 * 1024);
    if (!Number.isSafeInteger(budget) || budget < 1024 * 1024) throw new Error("Invalid catalog disk budget.");
    const files = (await readdir(directory)).filter(name => /^[a-f0-9]{16}\.json$/.test(name));
    const sizes = await Promise.all(files.map(name => stat(resolve(directory, name)).then(info => info.size)));
    if (sizes.reduce((sum, bytes) => sum + bytes, 0) + Buffer.byteLength(json) > budget) throw Object.assign(new Error("Artist collection storage is full. Existing collections remain available; maintenance is required."), { status: 503 });
  }
  if (!exists) await atomic(file, json);
  if (makeCurrent) await atomic(resolve(output, "catalog-releases.json"), JSON.stringify({ schema: 1, current: catalog.version }, null, 2) + "\n");
  return catalog;
}
