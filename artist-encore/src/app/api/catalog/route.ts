import {NextRequest} from "next/server";
import {loadArtist} from "@/lib/catalog";
import {catalogOffer} from "@/lib/rules";
import {identity,anonymousIdentity,reply,errorReply,readBody} from "@/lib/http";
import {store,rateLimit} from "@/lib/store";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function GET(req:NextRequest){const {token}=anonymousIdentity(req);try{const {player}=await identity(req,token);const artistId=req.nextUrl.searchParams.get("artistId")||"";await rateLimit(await store(),player,"catalog",12);return reply({offer:catalogOffer(await loadArtist(artistId))},token);}catch(e){return errorReply(e,token,503);}}
export async function POST(req:NextRequest){const {token}=anonymousIdentity(req);try{const {player}=await identity(req,token);const body=await readBody(req);if(body.action!=="continue"||typeof body.artistId!=="string")throw new Error("Choose an artist to load more releases.");await rateLimit(await store(),player,"catalog-expand",6);return reply({offer:catalogOffer(await loadArtist(body.artistId,{continue:true}))},token);}catch(e){return errorReply(e,token);}}
