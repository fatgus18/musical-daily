// Shared source. Run `node scripts/sync-account-ui.mjs` from the workspace root.
// Only pending requests are shared. Completed account responses are never cached.
interface RequestCallbacks<T> {
  success: (value: T) => void;
  error: (reason: unknown) => void;
  settled?: () => void;
}

export function accountRequestPath(path: string, services: boolean, localPath: (path: string) => string): string {
  return services ? path : localPath(path);
}

export function accountReadSignal(signal: AbortSignal, timeoutMs = 15_000): AbortSignal {
  // A deadline must not abort the coordinator's controller: timeout failures
  // still need to report an error and release the pending read for retry.
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

export function createAccountRequestCoordinator() {
  let pending: { controller: AbortController; promise: Promise<void> } | null = null;
  let paused = false;

  function invalidate() {
    const previous = pending;
    pending = null;
    previous?.controller.abort();
  }

  return {
    invalidate,
    pause() { paused = true; invalidate(); },
    resume() { paused = false; },
    run<T>(load: (signal: AbortSignal) => Promise<T>, callbacks: RequestCallbacks<T>): Promise<void> {
      if (paused) return Promise.resolve();
      if (pending) return pending.promise;
      const controller = new AbortController();
      const entry = { controller, promise: Promise.resolve() };
      pending = entry;
      const current = () => pending === entry && !controller.signal.aborted;
      entry.promise = Promise.resolve().then(async () => {
        // An effect cleanup or logout may cancel before the microtask starts.
        if (!current()) return;
        try {
          const value = await load(controller.signal);
          // Also guards against responses whose body finished after abort.
          if (current()) callbacks.success(value);
        } catch (reason) {
          if (current()) callbacks.error(reason);
        } finally {
          if (current()) {
            pending = null;
            callbacks.settled?.();
          }
        }
      });
      return entry.promise;
    },
  };
}
