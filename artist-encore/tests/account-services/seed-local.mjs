// Private fixture process, never imported by an application. Native Node avoids
// Playwright rewriting the managed DB module across workspace package formats.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { AccountStore } from "../../../musical-daily/src/lib/account-store.ts";
import { openStore, recordMix } from "../../src/lib/store.ts";
import { createGame, act } from "../../src/lib/engine.ts";

const fixture = JSON.parse(readFileSync(resolve("../test-results-accounts/fixture.json"), "utf8"));
const relativeDirectory = relative(tmpdir(), fixture.temporary);
if (fixture.localFixture !== true || fixture.origin !== "https://localhost:3100" || isAbsolute(relativeDirectory) || relativeDirectory.startsWith("..") || !relativeDirectory.startsWith("musical-daily-services-smoke-")) throw new Error("Expected disposable local fixture.");
for (const key of ["accounts", "encore"]) {
  const part = relative(fixture.temporary, fixture[key]);
  if (isAbsolute(part) || part.startsWith("..")) throw new Error("Fixture path escaped temporary directory.");
}
const accounts = new AccountStore(fixture.accounts);
try {
  if (process.argv[2] === "identity") {
    const marker = `local-qa-${randomUUID()}`;
    const user = await accounts.user({ sub: marker, email: `${marker}@example.invalid`, name: "Local QA Listener", picture: null });
    console.log(JSON.stringify({ user, session: await accounts.createSession(user.id, "hub") }));
  } else if (process.argv[2] === "session") {
    console.log(JSON.stringify(await accounts.createSession(process.argv[3], "hub")));
  } else if (process.argv[2] === "encore") {
    const db = await openStore(fixture.encore);
    try {
      const marker = randomUUID();
      const pool = { artist: { id: marker, name: "QA Fixture Artist", image: "", url: "https://music.apple.com/" }, tracks: Array.from({ length: 30 }, (_, index) => ({ id: `qa-${index}`, title: `Fixture ${index}`, artistId: marker, artist: "QA Fixture Artist", aliases: [], preview: `https://audio-ssl.itunes.apple.com/${index}.m4a`, artwork: "https://is1-ssl.mzstatic.com/fixture.jpg", url: "https://music.apple.com/", duration: 200, rank: 100 - index })), ranking: { kind: "streams", label: "Private QA fixture", sourceUrl: "https://example.invalid", asOf: new Date().toISOString().slice(0, 10) }, fetchedAt: Date.now() };
      const game = createGame(`account:${process.argv[3]}`, pool, [], marker, Date.now() - 200000);
      for (let round = 0; round < 10; round++) {
        const now = game.createdAt + round * 19000;
        act(game, "listen", round, "", now);
        act(game, "heard", round, "", now + 10000);
        act(game, round < 7 ? "answer" : "pass", round, game.picks[round].correctChoiceId, now + 11000);
        if (round < 9) act(game, "next", round, "", now + 12000);
      }
      await db.transaction(tx => recordMix(tx, game));
      console.log(JSON.stringify({ id: game.id }));
    } finally { db.close(); }
  } else throw new Error("Unknown local fixture operation.");
} finally { accounts.close(); }
