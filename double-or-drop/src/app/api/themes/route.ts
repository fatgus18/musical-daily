import {NextRequest} from "next/server";
import {listArtistThemes,listThemes,loadCatalog} from "@/lib/catalog";
import {anonymousIdentity,reply,errorReply} from "@/lib/http";
import {store,rateLimit} from "@/lib/store";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function GET(req:NextRequest){
  const {token,player}=anonymousIdentity(req);
  try{
    rateLimit(store(),player,"themes",60);const query=(req.nextUrl.searchParams.get("q")||"").trim();
    if(query.length>100)throw new Error("Try a shorter artist name.");
    const catalog=loadCatalog();return reply({themes:query?listArtistThemes(catalog,query).slice(0,30):listThemes(catalog)},token);
  }catch(error){return errorReply(error,token);}
}
