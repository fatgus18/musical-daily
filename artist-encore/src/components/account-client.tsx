"use client";

// Shared source. Run `node scripts/sync-account-ui.mjs` from the workspace root.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { ACCOUNT_AVATARS, type AccountAvatar, type AccountUser } from "@musical-daily/accounts";
import { withBasePath } from "@/lib/app-path";
import { accountRequestPath, createAccountRequestCoordinator } from "./account-requests";

export const guestOnly = process.env.NEXT_PUBLIC_GUEST_ONLY === "1";

export type { AccountUser } from "@musical-daily/accounts";
interface AccountSession { user: AccountUser | null; configured: boolean }
interface AccountContextValue extends AccountSession {
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  avatarSaving: boolean;
  updateAvatar: (avatar: AccountAvatar | null) => Promise<boolean>;
}
const AccountContext = createContext<AccountContextValue | null>(null);
const CHANGE_KEY = "musical-daily:account-change";

function notifyAccountChange() {
  // A unique value also notifies other tabs when two changes happen within a millisecond.
  try { localStorage.setItem(CHANGE_KEY, `${Date.now()}:${Math.random().toString(36).slice(2)}`); } catch { /* Private mode can disable storage. */ }
}

export function accountApiPath(path: string): string {
  // All service-mounted games share the hub's root cookie and browser API.
  // Standalone local apps keep their own account proxy route.
  return accountRequestPath(path, process.env.NEXT_PUBLIC_MUSICAL_DAILY_SERVICES === "1", withBasePath);
}

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AccountSession>({ user: null, configured: false });
  const [loading, setLoading] = useState(!guestOnly);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [requests] = useState(createAccountRequestCoordinator);
  const currentUser = useRef<AccountUser | null>(null);
  const mounted = useRef(false);
  const signingOut = useRef(false);
  const avatarWrite = useRef<{ controller: AbortController; timeout: ReturnType<typeof setTimeout> } | null>(null);
  const cancelAvatarWrite = useCallback(() => {
    const pending = avatarWrite.current;
    avatarWrite.current = null;
    if (pending) { clearTimeout(pending.timeout); pending.controller.abort(); }
    if (mounted.current) setAvatarSaving(false);
  }, []);
  const refresh = useCallback((): Promise<void> => {
    if (guestOnly) return Promise.resolve();
    return requests.run(async signal => {
      const response = await fetch(accountApiPath("/api/account/session"), { cache: "no-store", credentials: "same-origin", signal });
      if (!response.ok) throw new Error("Your account could not be loaded. Please try again.");
      return response.json() as Promise<AccountSession>;
    }, {
      success: value => {
        currentUser.current = value.user ?? null;
        setSession({ user: value.user ?? null, configured: value.configured === true });
        setError(null);
      },
      error: () => {
        currentUser.current = null;
        setSession({ user: null, configured: false });
        setError("Your account could not be loaded. Please try again.");
      },
      settled: () => setLoading(false),
    });
  }, [requests]);
  useEffect(() => {
    if (guestOnly) return;
    mounted.current = true;
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
    const onStorage = (event: StorageEvent) => {
      if (event.key !== CHANGE_KEY) return;
      // Another tab may have switched accounts or changed this profile. Never
      // apply a response started with the old cookie to the new identity.
      currentUser.current = null;
      cancelAvatarWrite();
      if (!signingOut.current) requests.resume();
      requests.invalidate();
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onFocus);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onFocus);
    const interval = window.setInterval(onFocus, 60_000);
    return () => {
      mounted.current = false;
      cancelAvatarWrite();
      requests.invalidate();
      window.cancelAnimationFrame(noticeFrame);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onFocus);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(interval);
    };
  }, [cancelAvatarWrite, refresh, requests]);
  const updateAvatar = useCallback(async (avatar: AccountAvatar | null): Promise<boolean> => {
    const accountId = currentUser.current?.id;
    if (guestOnly || !mounted.current || !accountId || signingOut.current || avatarWrite.current) return false;
    // Pause reads for the write so an older session response cannot briefly
    // replace the saved avatar. Gameplay and stats keep their existing identity.
    requests.pause();
    const controller = new AbortController();
    const write = { controller, timeout: setTimeout(() => controller.abort(), 15_000) };
    avatarWrite.current = write;
    setAvatarSaving(true);
    const current = () => mounted.current && avatarWrite.current === write && !signingOut.current && currentUser.current?.id === accountId;
    try {
      const response = await fetch(accountApiPath("/api/account/avatar"), {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ avatar }),
      });
      if (!response.ok) throw new Error(response.status === 401 ? "Please sign in again to change your picture." : "Your picture could not be saved. Please try again.");
      const result = await response.json() as { user?: AccountUser };
      if (!current()) return false;
      if (!result.user || result.user.id !== accountId) throw new Error("Your account changed. Reopen your profile and try again.");
      if (controller.signal.aborted) return false;
      requests.invalidate();
      currentUser.current = result.user;
      setSession(value => value.user?.id === accountId ? { ...value, user: result.user! } : value);
      notifyAccountChange();
      return true;
    } catch (reason) {
      if (!current()) return false;
      if (controller.signal.aborted) throw new Error("That took a little too long. Please try again.");
      throw reason;
    } finally {
      clearTimeout(write.timeout);
      if (avatarWrite.current === write) {
        avatarWrite.current = null;
        if (mounted.current) setAvatarSaving(false);
        if (!signingOut.current) requests.resume();
      }
    }
  }, [requests]);
  const signOut = useCallback(async () => {
    if (guestOnly) return;
    // Cancel before logout, and suppress focus refreshes until the cookie is
    // revoked. An older response must never restore a signed-out identity.
    signingOut.current = true;
    cancelAvatarWrite();
    requests.pause();
    try {
      const response = await fetch(accountApiPath("/api/account/logout"), { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error("We could not sign you out. Please try again.");
      currentUser.current = null;
      setSession(value => ({ ...value, user: null }));
      setError(null);
      notifyAccountChange();
    } finally { signingOut.current = false; requests.resume(); }
    await refresh();
  }, [cancelAvatarWrite, refresh, requests]);
  return <AccountContext.Provider value={{ ...session, loading, error, refresh, signOut, avatarSaving, updateAvatar }}>{notice && <div className="md-account-notice" role="alert"><span>{notice}</span><button type="button" onClick={() => setNotice(null)} aria-label="Dismiss sign-in message">×</button></div>}{children}</AccountContext.Provider>;
}

export function useAccount() {
  const context = useContext(AccountContext);
  if (!context) throw new Error("Account UI must be inside AccountProvider.");
  return context;
}

function GoogleMark() {
  return <svg className="md-google-mark" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6C44.4 38.02 46.98 31.86 46.98 24.55Z"/><path fill="#FBBC05" d="M10.53 28.59A14.4 14.4 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.87 23.87 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19Z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"/></svg>;
}

function AccountIcon({ name }: { name: "stats" | "arrow" | "chevron" | "sign-out" }) {
  return <svg className={`md-account-icon md-account-icon-${name}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "stats" && <><path d="M4 20h16M6 16v-5m6 5V4m6 12V8" /><circle cx="6" cy="8" r=".5" fill="currentColor" stroke="none" /></>}
    {name === "arrow" && <path d="M5 12h14m-6-6 6 6-6 6" />}
    {name === "chevron" && <path d="m6 9 6 6 6-6" />}
    {name === "sign-out" && <><path d="M10 4H5v16h5m-1-8h12m-5-5 5 5-5 5" /></>}
  </svg>;
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

function GoogleProfilePicture({ user }: { user: AccountUser }) {
  const [broken, setBroken] = useState(false);
  const initial = (user.name?.trim() || user.email || "M").slice(0, 1).toUpperCase();
  return user.picture && !broken
    ? <Image src={user.picture} alt="" width={42} height={42} unoptimized referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    : <>{initial}</>;
}

function ProfileAvatar({ user, large = false, useDefault = false }: { user: AccountUser; large?: boolean; useDefault?: boolean }) {
  const avatar = !useDefault && ACCOUNT_AVATARS.find(option => option.id === user.avatar);
  return <span className={`md-account-avatar${large ? " md-account-profile-avatar" : ""}${avatar ? " md-account-emoji-avatar" : ""}`} data-avatar={avatar ? avatar.id : "default"} aria-hidden="true">
    {avatar ? avatar.emoji : <GoogleProfilePicture key={user.picture} user={user} />}
  </span>;
}

function SelectionCheck() {
  return <svg className="md-avatar-check" width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 4 4 8-8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function AvatarPicker({ user, signingOut }: { user: AccountUser; signingOut: boolean }) {
  const { avatarSaving, updateAvatar } = useAccount();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function choose(avatar: AccountAvatar | null) {
    setError(null); setSaved(false);
    try {
      const changed = await updateAvatar(avatar);
      if (mounted.current) setSaved(changed);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "Your picture could not be saved. Please try again.");
    }
  }
  const selected = ACCOUNT_AVATARS.some(option => option.id === user.avatar) ? user.avatar : null;
  const disabled = avatarSaving || signingOut;
  return <section className="md-avatar-picker" aria-label="Profile picture" aria-busy={avatarSaving}>
    <div className="md-avatar-heading"><strong>Profile picture</strong><span>Pick your vibe</span></div>
    <button type="button" className="md-avatar-default" aria-label="Default — Google photo" aria-pressed={!selected} disabled={disabled} onClick={() => void choose(null)}>
      <ProfileAvatar user={user} useDefault /><span>Default <small>Google photo</small></span>{!selected && <SelectionCheck />}
    </button>
    <div className="md-avatar-grid">{ACCOUNT_AVATARS.map(option => <button key={option.id} type="button" className="md-avatar-option" aria-label={option.label} title={option.label} aria-pressed={selected === option.id} disabled={disabled} onClick={() => void choose(option.id)}>
      <span aria-hidden="true">{option.emoji}</span>{selected === option.id && <SelectionCheck />}
    </button>)}</div>
    <p className="md-avatar-status" role="status" aria-live="polite">{avatarSaving ? "Saving your look…" : saved ? "Saved. Looking good!" : "One look across all your games."}</p>
    {error && <p className="md-avatar-error md-account-error" role="alert">{error}</p>}
  </section>;
}

export function AccountSignIn() {
  const { configured, loading, error, refresh } = useAccount();
  const returnTo = useSyncExternalStore(subscribeLocation, currentReturnPath, () => "/");
  if (guestOnly) return null;
  if (loading) return <span className="md-account-loading" role="status">Checking your account…</span>;
  if (error) return <div className="md-account-message"><p role="alert">{error}</p><button type="button" onClick={() => void refresh()}>Try again</button></div>;
  if (!configured) return <div className="md-account-message"><p>Google sign-in is being set up. You can keep playing as a guest.</p><button type="button" onClick={() => void refresh()}>Check again</button></div>;
  const login = `/api/account/login?returnTo=${encodeURIComponent(returnTo)}`;
  return <a className="md-google-sign-in" href={accountApiPath(login)}><GoogleMark /> Continue with Google</a>;
}

export function AccountButton({ statsHref = "/stats" }: { statsHref?: string }) {
  const { user } = useAccount();
  if (guestOnly) return null;
  // A new identity gets fresh menu and avatar state before it is displayed.
  return <AccountButtonState key={user?.id ?? "guest"} statsHref={withBasePath(statsHref)} />;
}

function AccountButtonState({ statsHref }: { statsHref: string }) {
  const { user, loading, error, signOut } = useAccount();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
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
  return <div className="md-account" ref={root}>
    <button type="button" className={`md-account-trigger${user ? " is-signed-in" : ""}`} ref={trigger} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} disabled={loading}>
      {user ? <><ProfileAvatar user={user} /><span className="md-account-name">{user.name?.split(" ")[0] || "My account"}</span><AccountIcon name="chevron" /></> : <><GoogleMark /><span>{loading ? "Loading…" : error ? "Account" : "Sign in"}</span></>}
    </button>
    {open && <div className="md-account-panel" id={id}>
      {user ? <><div className="md-account-identity"><ProfileAvatar user={user} large /><div className="md-account-identity-detail"><strong>{user.name || "Music lover"}</strong><span>{user.email}</span></div></div><AvatarPicker user={user} signingOut={busy} /><a className="md-account-stats" href={statsHref}><AccountIcon name="stats" /><span>My stats</span><AccountIcon name="arrow" /></a><button className="md-account-sign-out" type="button" disabled={busy} onClick={() => void leave()}><AccountIcon name="sign-out" /><span>{busy ? "Signing out…" : "Sign out"}</span></button>{signOutError && <p className="md-account-error" role="alert">{signOutError}</p>}</> : <><strong className="md-account-heading">Make yourself at home.</strong><p className="md-account-fine">Keep your scores together across all your games.</p><AccountSignIn /></>}
    </div>}
  </div>;
}
