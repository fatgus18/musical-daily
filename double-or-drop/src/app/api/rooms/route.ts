import {catalogStatus} from "@/lib/catalog";
import {loadSavedCatalog} from "@/lib/catalog-storage";
import {rateLimit} from "@/lib/store";
import {createRoom,findCreatedRoom} from "@/lib/rooms/store";
import {privateRoomRead,roomActor,roomBody,roomCreation,roomDatabase,roomFailure,roomIdentity,roomReply,roomResponse,roomSettings,type RoomIdentity} from "@/lib/rooms/http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
// Inherit the service timeout so these routes share its Node function bundle.
export function GET(request:Request){try{privateRoomRead(request);return roomReply({catalog:catalogStatus()},roomIdentity(request));}catch(error){return roomFailure(error);}}
export async function POST(request:Request){
  let identity:RoomIdentity|undefined;
  try{
    const body=await roomBody(request);const selection=roomCreation(body);identity=roomIdentity(request);
    const actor=await roomActor(request,body,identity);const db=await roomDatabase();await rateLimit(db,actor.id,"coop-create",5,600000);
    const existing=await findCreatedRoom(db,actor.id,selection.requestId);if(existing)return roomReply({room:roomResponse(existing)},identity);
    const catalog=await loadSavedCatalog(selection.catalogVersion,db);
    const settings=roomSettings(catalog,selection);
    return roomReply({room:roomResponse(await createRoom(db,actor,catalog,selection.requestId,settings))},identity);
  }catch(error){return roomFailure(error,identity);}
}
