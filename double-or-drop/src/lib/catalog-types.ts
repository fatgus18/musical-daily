/** Values and provenance stay on the server until the comparison is answered. */
export type Metric = "streams" | "duration" | "tempo" | "year";

export interface MetricValue {
  /** Streams: count; duration: seconds; tempo: BPM; year: original release year. */
  value: number;
  sourceUrl: string;
  asOf?: string;
  quality?: string;
}

export interface CatalogTrack {
  id: string;
  title: string;
  artist: string;
  primaryArtist?: string;
  artwork: string;
  sourceUrl: string;
  /** Optional verified provider preview; no audio bytes are copied into the catalog. */
  previewUrl?: string;
  previewSourceUrl?: string;
  metrics: Partial<Record<Metric, MetricValue>>;
  genre?: string;
  /** Included only when an original release year is explicitly evidenced. */
  decade?: number;
  popularity?: number;
  languageSource?: string;
}

export interface CatalogSource {
  id: string;
  url: string;
  note: string;
}

export interface Catalog {
  schema: 1;
  version: string;
  createdAt: string;
  tracks: CatalogTrack[];
  sources: CatalogSource[];
}

export interface CatalogTheme {
  id: string;
  label: string;
  trackCount: number;
  metrics: Metric[];
}
