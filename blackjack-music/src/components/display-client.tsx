"use client";

import { useSyncExternalStore } from "react";
import { CONTRAST_COOKIE, CONTRAST_STORAGE_KEY } from "./display-preferences";

const eventName = "md-contrast-change";

function preferredContrast(): "high" | "standard" {
  let preference: string | null | undefined;
  try { preference = document.cookie.split("; ").find(value => value.startsWith(`${CONTRAST_COOKIE}=`))?.slice(CONTRAST_COOKIE.length + 1); } catch { /* Cookies can be blocked. */ }
  if (preference !== "high" && preference !== "standard") {
    try { preference = localStorage.getItem(CONTRAST_STORAGE_KEY); } catch { /* Storage can be blocked. */ }
  }
  return preference === "high" || preference === "standard" ? preference : window.matchMedia("(prefers-contrast: more)").matches ? "high" : "standard";
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia("(prefers-contrast: more)");
  const sync = () => { document.documentElement.dataset.contrast = preferredContrast(); onChange(); };
  const storage = (event: StorageEvent) => { if (event.key === CONTRAST_STORAGE_KEY || event.key === null) sync(); };
  const visible = () => { if (document.visibilityState === "visible") sync(); };
  window.addEventListener(eventName, onChange);
  window.addEventListener("storage", storage);
  window.addEventListener("focus", sync);
  window.addEventListener("pageshow", sync);
  document.addEventListener("visibilitychange", visible);
  media.addEventListener("change", sync);
  sync();
  return () => {
    window.removeEventListener(eventName, onChange);
    window.removeEventListener("storage", storage);
    window.removeEventListener("focus", sync);
    window.removeEventListener("pageshow", sync);
    document.removeEventListener("visibilitychange", visible);
    media.removeEventListener("change", sync);
  };
}

const snapshot = () => document.documentElement.dataset.contrast === "high";
const serverSnapshot = () => false;
const clientReady = () => true;
const subscribeReady = () => () => {};

export function ContrastToggle() {
  const high = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverSnapshot);
  function toggle() {
    const next = snapshot() ? "standard" : "high";
    try { localStorage.setItem(CONTRAST_STORAGE_KEY, next); } catch { /* This tab still works without persistence. */ }
    try { document.cookie = `${CONTRAST_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`; } catch { /* Private browsers may block cookies. */ }
    document.documentElement.dataset.contrast = next;
    window.dispatchEvent(new Event(eventName));
  }
  return <button type="button" className="md-contrast-toggle" aria-label="High contrast" aria-pressed={high} disabled={!ready} title={`High contrast ${high ? "on" : "off"}`} onClick={toggle}>
    <svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M10 2.5a7.5 7.5 0 0 1 0 15Z" fill="currentColor"/></svg>
    <span>Contrast <b>{high ? "on" : "off"}</b></span>
  </button>;
}
