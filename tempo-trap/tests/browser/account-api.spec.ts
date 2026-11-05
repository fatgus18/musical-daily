import { test, expect } from "@playwright/test";
import { GET as daily } from "../../src/app/api/daily/route";
import { POST as startRound } from "../../src/app/api/round/route";
import { POST as guess } from "../../src/app/api/guess/route";
import { getTracks } from "../../src/lib/catalog";
import type { AccountMix } from "../../src/lib/account-game";

test("account daily progress resumes across devices, saves once, and remains isolated", async () => {
  const originalFetch = globalThis.fetch;
  const oldSecret = process.env.MUSICAL_DAILY_SERVICE_SECRET;
  process.env.MUSICAL_DAILY_SERVICE_SECRET = "test-only-tempo-account-service-secret";
  const stored = new Map<string, { value: AccountMix; revision: number }>();
  const events: Array<{ score: number }> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.action === "session") return Response.json({ user: { id: body.token, name: body.token, email: `${body.token}@example.test`, picture: null } });
    const key = `${body.token}:${body.key}`;
    if (body.action === "load-progress") return Response.json({ progress: stored.get(key) || null });
    if (body.action === "save-progress") {
      const current = stored.get(key);
      if ((current?.revision || 0) !== body.revision) return Response.json({ saved: false, conflict: true, ...current });
      const revision = (current?.revision || 0) + 1;
      stored.set(key, { value: structuredClone(body.value), revision });
      if (body.event) events.push(body.event);
      return Response.json({ saved: true, revision });
    }
    throw new Error(`Unexpected service operation ${body.action}`);
  };
  const request = (path: string, body?: unknown, user = "alice") => new Request(`http://localhost:3002/api/${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { cookie: `md_tempo_session=${user}`, origin: "http://localhost:3002", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const first = await (await daily(request("daily"))).json();
    let token = first.token as string;
    const tracks = getTracks(first.date, first.seed, first.version);
    let previous = "";
    for (let round = 0; round < 5; round++) {
      const started = await startRound(request("round", { token }));
      expect(started.status).toBe(200);
      const { deadline } = await started.json();
      const resumed = await (await daily(request("daily"))).json();
      expect(resumed.accountProgress.round).toBe(round);
      expect(resumed.accountProgress.deadline).toBe(deadline);
      expect(resumed.accountProgress.phase).toBe("guessing");
      previous = token;
      const result = await guess(request("guess", { token, guess: Math.round(tracks[round].bpm), score: 999999 }));
      expect(result.status).toBe(200);
      const body = await result.json();
      expect(body.result.score).toBe(1000);
      token = body.token;
    }
    expect(events).toHaveLength(1);
    expect(events[0].score).toBe(5000);
    const replay = await (await guess(request("guess", { token: previous, guess: 40 }))).json();
    expect(replay.results).toHaveLength(5);
    expect(replay.result.score).toBe(1000);
    expect(events).toHaveLength(1);
    expect((await (await daily(request("daily"))).json()).accountProgress.phase).toBe("complete");
    const otherUser = await (await daily(request("daily", undefined, "bob"))).json();
    expect(otherUser.accountProgress.results).toEqual([]);
    expect((await guess(request("guess", { token: previous, guess: 120 }, "bob"))).status).toBe(409);
    globalThis.fetch = async () => { throw new Error("outage"); };
    expect((await guess(request("guess", { token: previous, guess: 120 }))).status).toBe(503);
  } finally { globalThis.fetch = originalFetch; if (oldSecret === undefined) delete process.env.MUSICAL_DAILY_SERVICE_SECRET; else process.env.MUSICAL_DAILY_SERVICE_SECRET = oldSecret; }
});

test("an account round deadline cannot be reset and expired answers earn zero", async () => {
  const originalFetch = globalThis.fetch;
  const oldSecret = process.env.MUSICAL_DAILY_SERVICE_SECRET;
  process.env.MUSICAL_DAILY_SERVICE_SECRET = "test-only-tempo-account-service-secret";
  let state: { value: AccountMix; revision: number } | null = null;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.action === "session") return Response.json({ user: { id: "alice", name: "Alice", email: "alice@example.test", picture: null } });
    if (body.action === "load-progress") return Response.json({ progress: state });
    if (body.action === "save-progress") { state = { value: body.value, revision: (state?.revision || 0) + 1 }; return Response.json({ saved: true, revision: state.revision }); }
    throw new Error("Unexpected operation");
  };
  const request = (path: string, body?: unknown) => new Request(`http://localhost:3002/api/${path}`, { method: body ? "POST" : "GET", headers: { cookie: "md_tempo_session=alice", "Content-Type": "application/json", origin: "http://localhost:3002" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const mix = await (await daily(request("daily"))).json();
    await startRound(request("round", { token: mix.token }));
    const expired = Date.now() - 3000;
    state!.value.deadline = expired;
    expect((await (await startRound(request("round", { token: mix.token }))).json()).deadline).toBe(expired);
    const track = getTracks(mix.date, mix.seed, mix.version)[0];
    const answer = await (await guess(request("guess", { token: mix.token, guess: Math.round(track.bpm) }))).json();
    expect(answer.result.score).toBe(0);
    expect(answer.result.guess).toBeNull();
  } finally { globalThis.fetch = originalFetch; if (oldSecret === undefined) delete process.env.MUSICAL_DAILY_SERVICE_SECRET; else process.env.MUSICAL_DAILY_SERVICE_SECRET = oldSecret; }
});
