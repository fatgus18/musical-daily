"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { PublicTrackCard } from "@/lib/puzzle";
import { withBasePath } from "@/lib/app-path";

/** A failed CDN image gets a bounded, board-validated replacement lookup. */
export function TrackArtwork({ track, query }: { track: PublicTrackCard; query: string }) {
  const [replacement, setReplacement] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const attempts = useRef(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const url = replacement || track.albumArtUrl;

  async function repair() {
    if (attempts.current >= 2 || request.current) { setFailed(true); return; }
    attempts.current += 1;
    const controller = new AbortController();
    request.current = controller;
    try {
      const params = new URLSearchParams(query);
      params.set("trackId", track.id);
      if (url) params.set("failedUrl", url);
      const response = await fetch(withBasePath(`/api/artwork?${params}`), { signal: controller.signal });
      if (!response.ok) throw new Error("Artwork unavailable");
      const data = await response.json() as { albumArtUrl?: string };
      if (!data.albumArtUrl || data.albumArtUrl === url) setFailed(true);
      else { setReplacement(data.albumArtUrl); setFailed(false); }
    } catch { if (!controller.signal.aborted) setFailed(true); }
    finally { if (request.current === controller) request.current = null; }
  }

  if (!url || failed) return <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#a78bfa]/30 to-neutral-900 text-2xl" role="img" aria-label={`${track.title} cover temporarily unavailable`}>♪</div>;
  return <Image src={withBasePath(url)} alt={`${track.title} cover`} width={80} height={80} unoptimized onError={() => void repair()} className="h-full w-full object-cover transition duration-300 group-hover:scale-105" loading="lazy" />;
}
