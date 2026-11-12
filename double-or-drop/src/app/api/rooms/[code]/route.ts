import {loadSavedCatalog} from "@/lib/catalog-storage";
import {rateLimit} from "@/lib/store";
import {commandRoom,findRematchedRoom,joinRoom,normalizeRoomCode,readRoom} from "@/lib/rooms/store";
import {RoomError} from "@/lib/rooms/types";
import {onlyFields,privateRoomRead,roomActor,roomBody,roomCommand,roomDatabase,roomFailure,roomIdentity,roomReply,roomResponse,type RoomIdentity} from "@/lib/rooms/http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
type Context={params:Promise<{code:string}>};
export async function GET(request:Request,context:Context){
  let identity:RoomIdentity|undefined;
  try{privateRoomRead(request);const code=normalizeRoomCode((await context.params).code);identity=roomIdentity(request);return roomReply({room:roomResponse(await readRoom(await roomDatabase(),code,identity.id))},identity);}
  catch(error){return roomFailure(error,identity);}
}
export async function POST(request:Request,context:Context){
  let identity:RoomIdentity|undefined;
  try{
    const body=await roomBody(request);const code=normalizeRoomCode((await context.params).code);identity=roomIdentity(request);const db=await roomDatabase();
    if(body.action==="join"){
      onlyFields(body,["action","nickname","avatar"]);await rateLimit(db,identity.id,"coop-join",20);
      return roomReply({room:roomResponse(await joinRoom(db,code,await roomActor(request,body,identity)))},identity);
    }
    const command=roomCommand(body);
    await rateLimit(db,identity.id,`coop-${command.action==="heartbeat"?"heartbeat":"move"}:${code}`,command.action==="heartbeat"?12:120);
    let catalog;
    if(command.action==="rematch"){
      const existing=await findRematchedRoom(db,code,identity.id,command.requestId!);if(existing)return roomReply({room:roomResponse(existing)},identity);
      const current=await readRoom(db,code,identity.id);
      if(current.hostId!==identity.id||current.you.left)throw new RoomError("Only the host can start a new team run.",403,"host_only");
      if(current.phase!=="complete"||current.matchId!==command.matchId||current.turn!==command.turn)throw new RoomError("Finish this team run before starting another.",409,"stale_turn");
      catalog=await loadSavedCatalog(current.catalogVersion,db);
    }else if(["pick","bank","risk"].includes(command.action)){
      const current=await readRoom(db,code,identity.id);
      // Invalid/stale/retried requests are reconciled by the transaction without
      // unnecessary snapshot work. Never hold a write lease while reading a pack.
      if(current.phase==="decision"&&current.activePlayerId===identity.id&&current.matchId===command.matchId&&current.turn===command.turn)catalog=await loadSavedCatalog(current.catalogVersion,db);
    }
    return roomReply({room:roomResponse(await commandRoom(db,code,identity.id,command,catalog))},identity);
  }catch(error){return roomFailure(error,identity);}
}
