"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { CatalogTheme } from "@/lib/catalog-types";
import { useSound } from "./sound-client";

const collectionDetails: Record<string, { description: string; tone: string }> = {
  all: { description: "Every genre. A little surprise.", tone: "lilac" },
  pop: { description: "Big hooks and familiar favourites.", tone: "rose" },
  rock: { description: "Great riffs. Even greater records.", tone: "peach" },
  "hip-hop": { description: "Bars, beats and heavy hitters.", tone: "gold" },
  rnb: { description: "Smooth vocals and a little soul.", tone: "mauve" },
  electronic: { description: "Club energy. After-hours favourites.", tone: "blue" },
  country: { description: "Good stories with a little twang.", tone: "sand" },
  jazz: { description: "A little swing. A little late night.", tone: "mint" },
  folk: { description: "Acoustic sounds, timeless stories.", tone: "sage" },
};

export function CollectionIcon({ kind = "all" }: { kind?: string }) {
  const artist = kind.startsWith("artist:") || kind === "artist";
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {artist ? <><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></> : kind === "pop" ? <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/><path d="m19 3 1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z"/></> : kind === "rock" ? <><path d="m14 10 6-6m-1-1 2 2M10 8c-1 2 0 4-2 4-3 0-5 3-4 6 1 3 5 4 7 1 1-1 0-3 2-3 3-1 3-4 1-6-1-1-3-2-4-2Z"/><circle cx="10" cy="14" r="1.5"/></> : kind === "hip-hop" ? <><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8M10 7h4M10 10h4"/></> : kind === "rnb" ? <path d="M20.2 5.8a5 5 0 0 0-7.1 0L12 7l-1.1-1.2a5 5 0 0 0-7.1 7.1L12 21l8.2-8.1a5 5 0 0 0 0-7.1Z"/> : kind === "electronic" ? <path d="M3 9v6M7 5v14M12 2v20M17 7v10M21 10v4"/> : kind === "country" ? <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"/> : kind === "jazz" ? <><path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="5.5" cy="18.5" rx="3.5" ry="2.5"/><ellipse cx="16.5" cy="16.5" rx="3.5" ry="2.5"/></> : kind === "folk" ? <><path d="M20 3C9 2 3 8 5 15c1 4 7 5 11 0 3-4 4-9 4-12ZM3 22 15 10M9 16h5M9 16v-5"/></> : <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M6 10a6 6 0 0 1 4-4m4 12a6 6 0 0 0 4-4"/></>}
  </svg>;
}

function details(theme?: CatalogTheme) {
  return theme?.id.startsWith("artist:") ? { description: "Your favourite artist, on repeat.", tone: "lilac" } : collectionDetails[theme?.id || "all"] || { description: "A collection worth getting lost in.", tone: "lilac" };
}

export function CollectionPicker({ themes, selected, disabled, onSelect }: { themes: CatalogTheme[]; selected?: CatalogTheme; disabled: boolean; onSelect: (theme: CatalogTheme) => void }) {
  const listId = useId();
  const labelId = `${listId}-label`;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [placement, setPlacement] = useState<"above" | "below">("below");
  const [maxHeight, setMaxHeight] = useState(320);
  const typeahead = useRef({ value: "", at: 0 });
  const sound = useSound();
  const options = selected && !themes.some(theme => theme.id === selected.id) ? [selected, ...themes] : themes;
  const expanded = open && !disabled && options.length > 0;
  const current = selected || themes[0];
  const description = details(current);

  function position() {
    const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
    const below = window.innerHeight - rect.bottom - 20, above = rect.top - 20;
    const side = below < 340 && above > below ? "above" : "below";
    setPlacement(side); setMaxHeight(Math.max(130, Math.min(320, (side === "above" ? above : below) - 79)));
  }
  function show(index = options.findIndex(theme => theme.id === current?.id)) {
    if (disabled) return;
    position(); setHighlighted(Math.max(0, index)); setOpen(true);
  }
  function choose(index: number) {
    const theme = options[index]; if (!theme || disabled) return;
    sound.unlock(); sound.play("select"); onSelect(theme); setOpen(false); trigger.current?.focus();
  }
  function keys(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === "Escape") { if (expanded) event.preventDefault(); setOpen(false); return; }
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (expanded) choose(highlighted); else show(); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!expanded) { show(event.key === "End" ? options.length - 1 : event.key === "Home" ? 0 : undefined); return; }
      setHighlighted(index => event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length); return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now(), letter = event.key.toLocaleLowerCase();
      const search = now - typeahead.current.at < 700 ? typeahead.current.value + letter : letter;
      const match = options.findIndex(theme => theme.label.toLocaleLowerCase().startsWith(search));
      typeahead.current = { value: search, at: now };
      if (match >= 0) { event.preventDefault(); if (!expanded) show(match); else setHighlighted(match); }
    }
  }
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside); window.addEventListener("resize", position);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", position); };
  }, [expanded]);
  useEffect(() => {
    if (expanded) root.current?.querySelector<HTMLElement>(`[data-option-index="${highlighted}"]`)?.scrollIntoView({ block: "nearest" });
  }, [expanded, highlighted]);

  return <div className="collection-picker" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <span id={labelId} className="sr-only">Pick a collection</span>
    <button id="theme" ref={trigger} type="button" role="combobox" className={`collection-control collection-trigger ${expanded ? "is-open" : ""}`} aria-labelledby={`${labelId} ${listId}-value`} aria-expanded={expanded} aria-haspopup="listbox" aria-controls={expanded ? listId : undefined} aria-activedescendant={expanded ? `${listId}-option-${highlighted}` : undefined} disabled={disabled} onClick={() => expanded ? setOpen(false) : show()} onKeyDown={keys}>
      <span className={`field-icon tone-${description.tone}`}><CollectionIcon kind={current?.id}/></span>
      <span className="collection-field-copy"><strong id={`${listId}-value`}>{current?.label || "Choose your collection"}</strong><small>{disabled && !current ? "Getting your music ready…" : description.description}</small></span>
      <svg className="picker-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    {expanded && <div className={`collection-menu picker-menu placement-${placement}`}>
      <div className="picker-menu-heading"><span>FIND YOUR MOOD</span><small>A good run starts with good music.</small></div>
      <div id={listId} role="listbox" aria-label="Music collections" className="collection-options" style={{ maxHeight }}>
        {options.map((theme, index) => { const info = details(theme), chosen = current?.id === theme.id; return <button key={theme.id} id={`${listId}-option-${index}`} data-option-index={index} type="button" role="option" aria-selected={chosen} tabIndex={-1} className={`picker-option collection-option ${highlighted === index ? "is-highlighted" : ""} ${chosen ? "is-selected" : ""}`} onMouseDown={event => event.preventDefault()} onPointerMove={() => setHighlighted(index)} onClick={() => choose(index)}>
          <span className={`option-icon tone-${info.tone}`}><CollectionIcon kind={theme.id}/></span><span className="picker-option-copy"><strong>{theme.label}</strong><small>{info.description}</small></span><span className="option-check" aria-hidden="true">{chosen ? "✓" : ""}</span>
        </button>; })}
      </div>
      <div className="picker-menu-foot"><span><kbd>↑</kbd><kbd>↓</kbd> to explore</span><span><kbd>↵</kbd> to choose</span></div>
    </div>}
  </div>;
}
