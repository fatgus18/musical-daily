import { NextRequest } from "next/server";
import { searchArtists, loadArtistCollection } from "@/lib/catalog-artists";
import { anonymousIdentity, reply, errorReply, readBody } from "@/lib/http";
import { rateLimit, store } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const { token, player } = anonymousIdentity(req);
  try {
    const query = req.nextUrl.searchParams.get("q")?.trim() || "";
    if (query.length < 2 || query.length > 80) return reply({ artists: [] }, token);
    await rateLimit(await store(), player, "artist-search", 20);
    return reply({ artists: await searchArtists(query) }, token);
  } catch (error) { return errorReply(error, token); }
}
export async function POST(req: NextRequest) {
  const { token, player } = anonymousIdentity(req);
  try {
    const body = await readBody(req);
    if (typeof body.artistId !== "string" || !/^apple:\d{1,15}$/.test(body.artistId) || body.continue !== undefined && typeof body.continue !== "boolean") throw new Error("Choose an artist from search results.");
    await rateLimit(await store(), player, "artist-load", 6);
    return reply(await loadArtistCollection(body.artistId, body.continue === true), token);
  } catch (error) { return errorReply(error, token); }
}
