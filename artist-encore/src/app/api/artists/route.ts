import {NextRequest} from "next/server";
import {searchArtists} from "@/lib/catalog";
import {identity,anonymousIdentity,reply,errorReply} from "@/lib/http";
import {rateLimit,store} from "@/lib/store";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function GET(req:NextRequest){const {token}=anonymousIdentity(req);try{const {player}=await identity(req,token);const query=req.nextUrl.searchParams.get("q")?.trim()||"";if(query.length<2||query.length>80)return reply({artists:[]},token);await rateLimit(await store(),player,"search",30);return reply({artists:await searchArtists(query)},token);}catch(e){return errorReply(e,token,503);}}
