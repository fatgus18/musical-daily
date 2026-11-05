"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ContrastToggle } from "./display-client";
import { DEFAULT_SOUND, MusicalSoundEngine, SOUND_STORAGE_KEY, soundPreferences, type MusicProfile, type SoundCue, type SoundPreferences } from "./sound-engine";

interface SoundContextValue { play: (cue: SoundCue) => void; unlock: () => void; setMusic: (active: boolean) => void; setPreviewing: (active: boolean) => void }
const SoundContext = createContext<SoundContextValue>({ play: () => {}, unlock: () => {}, setMusic: () => {}, setPreviewing: () => {} });
export const useSound = () => useContext(SoundContext);
export function useBackgroundMusic(active: boolean) {
  const { setMusic } = useSound();
  useEffect(() => { setMusic(active); return () => setMusic(false); }, [active, setMusic]);
}

function Speaker({ muted }: { muted: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M11 4 5 9H2v6h3l6 5V4Z"/>{muted ? <path d="m16 9 6 6m0-6-6 6"/> : <><path d="M15 8a6 6 0 0 1 0 8"/><path d="M18 4a11 11 0 0 1 0 16"/></>}</svg>;
}

export function SoundProvider({ children, music = false, musicProfile = "game" }: { children: React.ReactNode; music?: boolean; musicProfile?: MusicProfile }) {
  const engine = useRef<MusicalSoundEngine | null>(null);
  const musicWanted = useRef(false);
  const previewing = useRef(false);
  const preferences = useRef(DEFAULT_SOUND);
  const [settings, setSettings] = useState(DEFAULT_SOUND);
  const [opened, setOpened] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const update = useCallback((next: SoundPreferences) => {
    const safe = soundPreferences(next); preferences.current = safe; setSettings(safe); engine.current?.configure(safe);
    try { localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(safe)); } catch { /* Sound controls still work in private mode. */ }
    // A harmless preference cookie also shares mute/volume across apps on the same hostname (including localhost ports).
    try { document.cookie = `md_sound=${encodeURIComponent(JSON.stringify(safe))}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`; } catch { /* Cookie restrictions must not disable controls. */ }
  }, []);
  const unlock = useCallback(() => engine.current?.unlock(), []);
  const play = useCallback((cue: SoundCue) => engine.current?.play(cue), []);
  const setMusic = useCallback((active: boolean) => { musicWanted.current = active; engine.current?.setMusic(active); }, []);
  const setPreviewing = useCallback((active: boolean) => { previewing.current = active; engine.current?.setPreviewing(active); }, []);

  useEffect(() => {
    const audio = new MusicalSoundEngine(musicProfile); engine.current = audio;
    let saved = DEFAULT_SOUND;
    const read = () => {
      try {
        const cookie = document.cookie.split("; ").find(value => value.startsWith("md_sound="))?.slice(9);
        return soundPreferences(JSON.parse(cookie ? decodeURIComponent(cookie) : localStorage.getItem(SOUND_STORAGE_KEY) || "null"));
      } catch { return DEFAULT_SOUND; }
    };
    saved = read();
    preferences.current = saved; audio.configure(saved); audio.setVisible(document.visibilityState === "visible");
    audio.setMusic(musicWanted.current); audio.setPreviewing(previewing.current);
    const frame = requestAnimationFrame(() => setSettings(saved));
    const onClick = (event: MouseEvent) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      if (event.target.closest('[data-sound="off"]')) return;
      // The lobby can start on a genuine click anywhere, without requiring a
      // particular control. A scroll or synthetic event never unlocks audio.
      if (music) audio.unlock();
      const target = event.target.closest<HTMLElement>('button,a[href],summary,[role="button"],input[type="checkbox"],input[type="radio"]');
      if (!target || target.closest('[data-sound="off"]') || target.matches(':disabled,[aria-disabled="true"]')) return;
      audio.unlock(); audio.play(target.matches('input,[aria-pressed]') ? "select" : "click");
    };
    const onKey = (event: KeyboardEvent) => { if (event.target instanceof Element && event.target.closest('[data-sound="off"]')) return; if (event.isTrusted && !event.repeat && !event.metaKey && !event.ctrlKey) audio.unlock(); };
    const onChange = (event: Event) => { if (event.isTrusted && event.target instanceof HTMLSelectElement && !event.target.closest('[data-sound="off"]')) { audio.unlock(); audio.play("select"); } };
    const onVisibility = () => audio.setVisible(document.visibilityState === "visible");
    const onPageHide = () => audio.setVisible(false);
    const onPageShow = () => audio.setVisible(document.visibilityState === "visible");
    const onFocus = () => { const next = read(); preferences.current = next; audio.configure(next); setSettings(next); };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SOUND_STORAGE_KEY) return;
      try { const next = soundPreferences(JSON.parse(event.newValue || "null")); preferences.current = next; audio.configure(next); setSettings(next); } catch {}
    };
    document.addEventListener("click", onClick, true); document.addEventListener("keydown", onKey, true);
    document.addEventListener("change", onChange, true); document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide); window.addEventListener("pageshow", onPageShow); window.addEventListener("storage", onStorage); window.addEventListener("focus", onFocus);
    return () => {
      cancelAnimationFrame(frame); audio.dispose(); engine.current = null;
      document.removeEventListener("click", onClick, true); document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("change", onChange, true); document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide); window.removeEventListener("pageshow", onPageShow); window.removeEventListener("storage", onStorage); window.removeEventListener("focus", onFocus);
    };
  }, [music, musicProfile]);

  useEffect(() => {
    if (!opened) return;
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target)) setOpened(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpened(false); panel.current?.querySelector<HTMLButtonElement>(".md-sound-settings")?.focus(); } };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", key); };
  }, [opened]);

  return <SoundContext.Provider value={{ play, unlock, setMusic, setPreviewing }}>{children}<div className="md-sound" ref={panel} data-sound="off">
    {opened && <section className="md-sound-popover" aria-label="Sound settings"><strong>A little more groove.</strong><p>{musicProfile === "lobby" ? "A bouncy soundtrack while you find your next game. Starts with your first click or tap." : `Game sounds ${music ? "and an original 144 BPM backing track" : "for your clicks and picks"}. Song previews have their own playback controls.`}</p><label htmlFor="md-effects-level">Effects <span>{Math.round(settings.effects * 100)}%</span></label><input id="md-effects-level" aria-label="Effects volume" type="range" min="0" max="100" value={Math.round(settings.effects * 100)} onChange={event => update({ ...preferences.current, effects: Number(event.target.value) / 100 })} onPointerUp={() => { unlock(); play("select"); }} />{music && <><label htmlFor="md-music-level">Background music <span>{Math.round(settings.music * 100)}%</span></label><input id="md-music-level" aria-label="Background music volume" type="range" min="0" max="100" value={Math.round(settings.music * 100)} onChange={event => { update({ ...preferences.current, music: Number(event.target.value) / 100 }); unlock(); }} /><small>Quiet by default. Set to 0 for effects only.</small></>}<button className="md-sound-close" onClick={() => setOpened(false)}>Done</button></section>}
    <div className="md-sound-bar"><ContrastToggle/><button className="md-sound-toggle" aria-label={settings.enabled ? "Mute game sounds" : "Enable game sounds"} aria-pressed={settings.enabled} onClick={() => { const next = { ...preferences.current, enabled: !preferences.current.enabled }; update(next); if (next.enabled) { unlock(); play("select"); } }}><Speaker muted={!settings.enabled}/><span>Sound {settings.enabled ? "on" : "off"}</span></button><button className="md-sound-settings" aria-label="Sound settings" aria-expanded={opened} onClick={() => setOpened(value => !value)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="currentColor"/><circle cx="15" cy="17" r="2.5" fill="currentColor"/></svg></button></div>
  </div></SoundContext.Provider>;
}
