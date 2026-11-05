import {NextRequest} from "next/server";
import {loadArtistPortrait} from "@/lib/artist-image";
import {identity,anonymousIdentity,reply,errorReply} from "@/lib/http";
import {findGame,saveGame,store,transaction,rateLimit} from "@/lib/store";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function GET(req:NextRequest){const {token}=anonymousIdentity(req);try{const {player}=await identity(req,token);
  const db=store();rateLimit(db,player,"portrait",20);const id=req.nextUrl.searchParams.get("gameId")||"";const saved=findGame(db,player,id);if(!saved)return reply({error:"Mix not found in this browser."},token,404);
  const portrait=await loadArtistPortrait(saved.artist);
  const artist=transaction(db,()=>{const game=findGame(db,player,id);if(!game)return null;game.artist={...game.artist,image:"",imageSourceUrl:undefined,imageAttribution:undefined,...portrait};saveGame(db,game);return game.artist;});return reply({artist},token);
}catch(e){return errorReply(e,token,503);}}
