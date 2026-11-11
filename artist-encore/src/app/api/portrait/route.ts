import {NextRequest} from "next/server";
import {loadArtistPortrait} from "@/lib/artist-image";
import {identity,anonymousIdentity,reply,errorReply} from "@/lib/http";
import {findGame,saveGame,store,transaction,rateLimit} from "@/lib/store";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function GET(req:NextRequest){let {token}=anonymousIdentity(req);try{const authenticated=await identity(req,token);token=authenticated.token;const {player}=authenticated;
  const db=await store();await rateLimit(db,player,"portrait",20);const id=req.nextUrl.searchParams.get("gameId")||"";const saved=await findGame(db,player,id);if(!saved)return reply({error:"Mix not found in this browser."},token,404);
  const portrait=await loadArtistPortrait(saved.artist);
  const artist=await transaction(db,async tx=>{const game=await findGame(tx,player,id);if(!game)return null;game.artist={...game.artist,image:"",imageSourceUrl:undefined,imageAttribution:undefined,...portrait};await saveGame(tx,game);return game.artist;});return reply({artist},token);
}catch(e){return errorReply(e,token,503);}}
