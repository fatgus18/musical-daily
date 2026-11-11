import assert from "node:assert/strict";
import test from "node:test";
import { accountRequestPath, createAccountRequestCoordinator } from "./account-requests.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test("service account calls use the central root while standalone apps retain their local prefix", () => {
  for (const path of ["/api/account/session", "/api/account/stats", "/api/account/logout", "/api/account/login?returnTo=%2Fencore"]) {
    assert.equal(accountRequestPath(path, true, value => `/encore${value}`), path);
    assert.equal(accountRequestPath(path, false, value => `/encore${value}`), `/encore${path}`);
    assert.equal(accountRequestPath(path, false, value => value), path);
  }
});

test("overlapping initial, pageshow, focus and visibility refreshes share one pending read, never a completed identity", async () => {
  const requests = createAccountRequestCoordinator();
  const response = deferred<string>();
  let loads = 0;
  const values: string[] = [];
  const load = async () => { loads++; return response.promise; };
  const callbacks = { success: (value: string) => values.push(value), error: () => assert.fail("Unexpected error") };
  const first = requests.run(load, callbacks);
  assert.equal(requests.run(load, callbacks), first);
  assert.equal(requests.run(load, callbacks), first);
  assert.equal(requests.run(load, callbacks), first);
  await Promise.resolve();
  assert.equal(loads, 1);
  response.resolve("first account");
  await first;
  assert.deepEqual(values, ["first account"]);
  await requests.run(async () => { loads++; return "new account"; }, callbacks);
  assert.equal(loads, 2);
  assert.deepEqual(values, ["first account", "new account"]);
});

test("logout cancels stale responses and suppresses focus refreshes until a fresh post-logout read", async () => {
  const requests = createAccountRequestCoordinator();
  const stale = deferred<string | null>();
  let signal: AbortSignal | undefined;
  let identity: string | null = "signed-in account";
  const failures: unknown[] = [];
  let settled = 0;
  const callbacks = { success: (value: string | null) => { identity = value; }, error: (reason: unknown) => failures.push(reason), settled: () => { settled++; } };
  const beforeLogout = requests.run(abortSignal => { signal = abortSignal; return stale.promise; }, callbacks);
  await Promise.resolve();
  requests.pause();
  assert.equal(signal?.aborted, true);
  await requests.run(async () => assert.fail("No account read while logout is pending"), callbacks);
  identity = null; // Successful logout clears the visible identity.
  requests.resume();
  await requests.run(async () => null, callbacks);
  stale.resolve("signed-in account"); // A transport/body can still complete after abort.
  await beforeLogout;
  assert.equal(identity, null);
  assert.equal(settled, 1);
  assert.deepEqual(failures, []);
});

test("invalidating an old read cannot clear a newer pending request or leak an abort error", async () => {
  const requests = createAccountRequestCoordinator();
  const old = deferred<string>();
  const next = deferred<string>();
  const values: string[] = [];
  const callbacks = { success: (value: string) => values.push(value), error: () => assert.fail("Stale errors must be ignored") };
  const first = requests.run(() => old.promise, callbacks);
  await Promise.resolve();
  requests.invalidate();
  const second = requests.run(() => next.promise, callbacks);
  await Promise.resolve();
  old.reject(new DOMException("Aborted", "AbortError"));
  await first;
  assert.equal(requests.run(async () => assert.fail("New read must stay coalesced"), callbacks), second);
  next.resolve("current account");
  await second;
  assert.deepEqual(values, ["current account"]);
});

test("failed reads report an error once and the next attempt reads fresh data", async () => {
  const requests = createAccountRequestCoordinator();
  const failure = new Error("Network unavailable");
  const failures: unknown[] = [];
  const values: string[] = [];
  const callbacks = { success: (value: string) => values.push(value), error: (reason: unknown) => failures.push(reason) };
  await requests.run(async () => { throw failure; }, callbacks);
  await requests.run(async () => "reconnected", callbacks);
  assert.deepEqual(failures, [failure]);
  assert.deepEqual(values, ["reconnected"]);
});

test("unmount before the scheduled read starts prevents the network request", async () => {
  const requests = createAccountRequestCoordinator();
  const pending = requests.run(async () => assert.fail("Unmounted read must not start"), {
    success: () => assert.fail("Unmounted component must not update"),
    error: () => assert.fail("Unmounted component must not update"),
  });
  requests.invalidate();
  await pending;
});
