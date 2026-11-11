"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { withBasePath } from "@/lib/app-path";
import type { CatalogTheme } from "@/lib/catalog-types";
import { CollectionIcon } from "./collection-picker";

interface Artist { id: string; name: string; image?: string; url?: string; genre?: string }
interface Coverage { hasMore?: boolean; message?: string; loadedReleases?: number; releaseCount?: number }
interface ArtistPack { theme: CatalogTheme; catalogVersion: string; artist: Artist; coverage?: Coverage }

export function ArtistCollectionSearch({ disabled, onSelect, selected, onLoadingChange }: { disabled: boolean; onSelect: (theme: CatalogTheme, version?: string) => void; selected: string | null; onLoadingChange: (busy: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [local, setLocal] = useState<CatalogTheme[]>([]);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [loadingArtist, setLoadingArtist] = useState<Artist | null>(null);
  const [pack, setPack] = useState<ArtistPack | null>(null);
  const [opened, setOpened] = useState(false);
  const [placement, setPlacement] = useState<"above" | "below">("below");
  const [maxHeight, setMaxHeight] = useState(340);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const suppressFocusOpen = useRef(false);
  const loadAbort = useRef<AbortController | null>(null);
  const expanded = opened && query.trim().length >= 2 && !disabled && !loadingArtist;
  function position() {
    const rect = root.current?.querySelector(".search-input")?.getBoundingClientRect(); if (!rect) return;
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop || 0;
    const bottom = top + (viewport?.height || innerHeight);
    const below = bottom - rect.bottom - 12, above = rect.top - top - 12;
    const side = below < 340 && above > below ? "above" : "below";
    setPlacement(side); setMaxHeight(Math.max(64, Math.min(360, (side === "above" ? above : below) - 10)));
  }
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { if (expanded) { event.preventDefault(); event.stopPropagation(); } setOpened(false); if (document.activeElement !== input.current) { suppressFocusOpen.current = true; input.current?.focus(); } return; }
    const inInput = event.target === input.current;
    if (!(event.key === "ArrowDown" || event.key === "ArrowUp" || (!inInput && (event.key === "Home" || event.key === "End")))) return;
    if (query.trim().length < 2 || disabled || loadingArtist) return;
    event.preventDefault(); position(); setOpened(true);
    requestAnimationFrame(() => {
      const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>(".artist-results button:not(:disabled)") || [])];
      if (!buttons.length) return;
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index < 0 ? event.key === "ArrowUp" ? buttons.length - 1 : 0 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    });
  }
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpened(false); };
    document.addEventListener("pointerdown", outside); window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", position); window.visualViewport?.removeEventListener("resize", position); };
  }, [expanded]);
  useEffect(() => () => { loadAbort.current?.abort(); loadAbort.current = null; onLoadingChange(false); }, [onLoadingChange]);
  useEffect(() => {
    if (query.trim().length < 2) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true); setError("");
      const results = await Promise.allSettled([
        fetch(withBasePath(`/api/themes?q=${encodeURIComponent(query.trim())}`), { signal: abort.signal }).then(async response => { if (!response.ok) throw new Error(); const data = await response.json() as { themes: CatalogTheme[] }; if (!abort.signal.aborted) setLocal(data.themes); return data; }),
        fetch(withBasePath(`/api/artists?q=${encodeURIComponent(query.trim())}`), { signal: abort.signal }).then(async response => { if (!response.ok) throw new Error(); const data = await response.json() as { artists: Artist[] }; if (!abort.signal.aborted) setArtists(data.artists); return data; }),
      ]);
      if (abort.signal.aborted) return;
      setLocal(results[0].status === "fulfilled" ? results[0].value.themes : []);
      setArtists(results[1].status === "fulfilled" ? results[1].value.artists : []);
      if (results.every(result => result.status === "rejected")) setError("Artist search is unavailable. Try again in a moment.");
      else if (results[1].status === "rejected") setError("Live lookup is taking a break. Shared-library artists are still available.");
      setSearching(false);
    }, 300);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [query]);

  async function load(artist: Artist, more = false) {
    if (disabled || loadingArtist) return;
    const abort = new AbortController(); loadAbort.current = abort; setLoadingArtist(artist); setError(""); setOpened(false); onLoadingChange(true);
    const timeout = setTimeout(() => abort.abort(), 65000);
    try {
      const response = await fetch(withBasePath("/api/artists"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ artistId: artist.id, continue: more }), signal: abort.signal });
      const data = await response.json() as ArtistPack & { error?: string };
      if (!response.ok) throw new Error(data.error || "This artist’s collection could not load. Please retry.");
      if (loadAbort.current !== abort) return;
      setPack(data); onSelect(data.theme, data.catalogVersion); setQuery(""); setLocal([]); setArtists([]);
    } catch (failure) {
      if (loadAbort.current === abort) setError(abort.signal.aborted ? "That collection took too long to load. Try again; cached releases are kept." : failure instanceof Error ? failure.message : "Could not load this artist.");
    } finally { clearTimeout(timeout); if (loadAbort.current === abort) { setLoadingArtist(null); loadAbort.current = null; onLoadingChange(false); } }
  }
  return <div className="artist-search" ref={root} onKeyDown={keys} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpened(false); }}>
    <label className="sr-only" htmlFor="artist-search">Or find an artist</label>
    <div className={`search-input collection-control ${expanded ? "is-open" : ""} ${disabled || loadingArtist ? "is-disabled" : ""}`}><span className="field-icon tone-lilac"><CollectionIcon kind="artist"/></span><div className="artist-input-copy"><input ref={input} id="artist-search" autoComplete="off" placeholder={selected ? "Find another artist…" : "Find any artist…"} value={query} disabled={disabled || Boolean(loadingArtist)} onFocus={() => { position(); if (suppressFocusOpen.current) { suppressFocusOpen.current = false; return; } if (query.trim().length >= 2) setOpened(true); }} onChange={event => { position(); setOpened(true); setQuery(event.target.value); setLocal([]); setArtists([]); setError(""); setSearching(event.target.value.trim().length >= 2); }} /><small>{selected ? `${selected} is your current collection.` : "Your favourites, on repeat."}</small></div>{query ? <button className="artist-search-clear" aria-label="Clear artist search" disabled={Boolean(loadingArtist)} onClick={() => { setQuery(""); setSearching(false); setOpened(false); input.current?.focus(); }}>×</button> : <svg className="artist-search-glass" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>}</div>
    {expanded && <div className={`artist-results picker-menu placement-${placement}`} role="region" aria-label="Artist search results" style={{ maxHeight }}>{searching && <p className="picker-status" role="status"><span className="search-pulse" aria-hidden="true"/>Finding your favourites…</p>}
      {artists.length > 0 && <span className="search-section-label">EXPLORE AN ARTIST</span>}
      {artists.map(artist => <button className="picker-option artist-result" disabled={disabled || Boolean(loadingArtist)} key={artist.id} onMouseDown={event => event.preventDefault()} onClick={() => { input.current?.blur(); void load(artist); }}><ArtistAvatar name={artist.name} image={artist.image}/><span className="picker-option-copy"><strong>{artist.name}</strong><small>{artist.genre || "Their songs. Your instincts."}</small></span><span className="artist-result-tag">Explore <span aria-hidden="true">↗</span></span></button>)}
      {local.length > 0 && <span className="search-section-label">QUICK PICKS</span>}
      {local.map(item => <button className="picker-option artist-result" disabled={disabled || Boolean(loadingArtist)} key={item.id} onMouseDown={event => event.preventDefault()} onClick={event => { onSelect(item); setPack(null); setQuery(""); setOpened(false); if (event.detail > 0 && window.matchMedia("(pointer: coarse)").matches) input.current?.blur(); else input.current?.focus(); }}><ArtistAvatar name={item.label}/><span className="picker-option-copy"><strong>{item.label}</strong><small>{item.trackCount.toLocaleString("en-US")} songs to play with</small></span><span className="artist-result-tag ready">Ready <span aria-hidden="true">↗</span></span></button>)}
      {!searching && !artists.length && !local.length && !error && <p>No matches yet. Try another spelling or a genre.</p>}
    </div>}
    {loadingArtist && <p className="artist-load-status" role="status">Finding {loadingArtist.name}’s songs… Larger discographies can take a moment.</p>}
    {error && <p className="artist-load-status artist-load-error" role="alert">{error}</p>}
    {pack && selected === pack.theme.label && !loadingArtist && <div className="artist-coverage"><span>{pack.theme.trackCount.toLocaleString("en-US")} songs ready</span>{pack.coverage?.hasMore && <button className="text-button" disabled={disabled} onClick={() => void load(pack.artist, true)}>Load more releases ↻</button>}{pack.coverage?.message && <small>{pack.coverage.message}</small>}</div>}
  </div>;
}

function ArtistAvatar({ name, image }: { name: string; image?: string }) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  return <span className="option-icon artist-avatar tone-lilac" aria-hidden="true"><span>{name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("")}</span>{image && image !== failedImage && <img src={withBasePath(image)} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedImage(image)}/>}</span>;
}
