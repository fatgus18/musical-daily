"use client";

// Shared source. Run `node scripts/sync-account-ui.mjs` from the workspace root.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { withBasePath } from "@/lib/app-path";

export const guestOnly = process.env.NEXT_PUBLIC_GUEST_ONLY === "1";

export interface AccountUser { id: string; name: string; email: string; picture: string | null }
interface AccountSession { user: AccountUser | null; configured: boolean }
interface AccountContextValue extends AccountSession {
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}
const AccountContext = createContext<AccountContextValue | null>(null);
const CHANGE_KEY = "musical-daily:account-change";

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AccountSession>({ user: null, configured: false });
  const [loading, setLoading] = useState(!guestOnly);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef(0);
  const invalidatePending = useCallback(() => { request.current++; }, []);
  const refresh = useCallback(async () => {
    if (guestOnly) return;
    const current = ++request.current;
    try {
      const response = await fetch(withBasePath("/api/account/session"), { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("Your account could not be loaded. Please try again.");
      const value: AccountSession = await response.json();
      if (current !== request.current) return;
      setSession({ user: value.user ?? null, configured: value.configured === true });
      setError(null);
    } catch {
      if (current !== request.current) return;
      setSession({ user: null, configured: false });
      setError("Your account could not be loaded. Please try again.");
    } finally { if (current === request.current) setLoading(false); }
  }, []);
  useEffect(() => {
    if (guestOnly) return;
    // Read the browser-only callback result after hydration, then remove it from the URL.
    const noticeFrame = window.requestAnimationFrame(() => {
      const location = new URL(window.location.href);
      const reason = location.searchParams.get("accountError");
      if (reason === "not-configured") setNotice("Google sign-in is not available yet. You can keep playing as a guest.");
      if (reason === "sign-in-failed") setNotice("Google sign-in did not finish. Please try again using Sign in.");
      if (reason) { location.searchParams.delete("accountError"); window.history.replaceState(window.history.state, "", location.pathname + location.search + location.hash); }
      void refresh();
    });
    const onFocus = () => { if (document.visibilityState === "visible") void refresh(); };
    const onStorage = (event: StorageEvent) => { if (event.key === CHANGE_KEY) void refresh(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onFocus);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onFocus);
    const interval = window.setInterval(onFocus, 60_000);
    return () => {
      invalidatePending();
      window.cancelAnimationFrame(noticeFrame);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onFocus);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(interval);
    };
  }, [refresh, invalidatePending]);
  const signOut = useCallback(async () => {
    if (guestOnly) return;
    const response = await fetch(withBasePath("/api/account/logout"), { method: "POST", credentials: "same-origin" });
    if (!response.ok) throw new Error("We could not sign you out. Please try again.");
    invalidatePending();
    setSession(value => ({ ...value, user: null }));
    setError(null);
    try { localStorage.setItem(CHANGE_KEY, String(Date.now())); } catch { /* Private mode can disable storage. */ }
    await refresh();
  }, [refresh, invalidatePending]);
  return <AccountContext.Provider value={{ ...session, loading, error, refresh, signOut }}>{notice && <div className="md-account-notice" role="alert"><span>{notice}</span><button type="button" onClick={() => setNotice(null)} aria-label="Dismiss sign-in message">×</button></div>}{children}</AccountContext.Provider>;
}

export function useAccount() {
  const context = useContext(AccountContext);
  if (!context) throw new Error("Account UI must be inside AccountProvider.");
  return context;
}

function GoogleMark() {
  return <svg className="md-google-mark" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6C44.4 38.02 46.98 31.86 46.98 24.55Z"/><path fill="#FBBC05" d="M10.53 28.59A14.4 14.4 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.87 23.87 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19Z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"/></svg>;
}

function subscribeLocation(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}
function currentReturnPath() {
  const location = new URL(window.location.href);
  location.searchParams.delete("accountError");
  return location.pathname + location.search;
}

export function AccountSignIn() {
  const { configured, loading, error, refresh } = useAccount();
  const returnTo = useSyncExternalStore(subscribeLocation, currentReturnPath, () => "/");
  if (guestOnly) return null;
  if (loading) return <span className="md-account-loading" role="status">Checking your account…</span>;
  if (error) return <div className="md-account-message"><p role="alert">{error}</p><button type="button" onClick={() => void refresh()}>Try again</button></div>;
  if (!configured) return <div className="md-account-message"><p>Google sign-in is being set up. You can keep playing as a guest.</p><button type="button" onClick={() => void refresh()}>Check again</button></div>;
  const login = `/api/account/login?returnTo=${encodeURIComponent(returnTo)}`;
  return <a className="md-google-sign-in" href={process.env.NEXT_PUBLIC_MUSICAL_DAILY_SERVICES === "1" ? login : withBasePath(login)}><GoogleMark /> Continue with Google</a>;
}

export function AccountButton({ statsHref = "/stats" }: { statsHref?: string }) {
  const { user } = useAccount();
  if (guestOnly) return null;
  // A new identity gets fresh menu and avatar state before it is displayed.
  return <AccountButtonState key={`${user?.id ?? "guest"}:${user?.picture ?? ""}`} statsHref={withBasePath(statsHref)} />;
}

function AccountButtonState({ statsHref }: { statsHref: string }) {
  const { user, loading, error, signOut } = useAccount();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [brokenImage, setBrokenImage] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);
  async function leave() {
    setBusy(true); setSignOutError(null);
    try { await signOut(); setOpen(false); trigger.current?.focus(); }
    catch (reason) { setSignOutError(reason instanceof Error ? reason.message : "Sign-out failed. Please try again."); }
    finally { setBusy(false); }
  }
  const initial = (user?.name?.trim() || user?.email || "M").slice(0, 1).toUpperCase();
  return <div className="md-account" ref={root}>
    <button type="button" className={`md-account-trigger${user ? " is-signed-in" : ""}`} ref={trigger} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} disabled={loading}>
      {user ? <><span className="md-account-avatar">{user.picture && !brokenImage ? <Image src={user.picture} alt="" width={29} height={29} unoptimized referrerPolicy="no-referrer" onError={() => setBrokenImage(true)} /> : initial}</span><span className="md-account-name">{user.name?.split(" ")[0] || "My account"}</span><span aria-hidden="true">⌄</span></> : <><GoogleMark /><span>{loading ? "Loading…" : error ? "Account" : "Sign in"}</span></>}
    </button>
    {open && <div className="md-account-panel" id={id}>
      {user ? <><div className="md-account-identity"><strong>{user.name || "Music lover"}</strong><span>{user.email}</span></div><a className="md-account-stats" href={statsHref}><span aria-hidden="true">▂ ▅ ▃ ▇</span> Your listening legacy <span aria-hidden="true">↗</span></a><p className="md-account-fine">One account. All your games.</p><button className="md-account-sign-out" type="button" disabled={busy} onClick={() => void leave()}>{busy ? "Signing out…" : "Sign out"}</button>{signOutError && <p className="md-account-error" role="alert">{signOutError}</p>}</> : <><strong className="md-account-heading">Make yourself at home.</strong><p className="md-account-fine">Keep your scores together across all your games.</p><AccountSignIn /></>}
    </div>}
  </div>;
}
