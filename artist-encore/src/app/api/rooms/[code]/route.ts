import {loadArtist} from "@/lib/catalog";
import {rateLimit} from "@/lib/store";
import {commandRoom,findRematchedRoom,joinRoom,normalizeRoomCode,readRoom} from "@/lib/rooms/store";
import {selectRandomArtist} from "@/lib/rooms/random-artist";
import {RoomError} from "@/lib/rooms/types";
import {onlyFields,privateRoomRead,requireRoomAudio,roomActor,roomArtistSelection,roomBody,roomCommand,roomDatabase,roomFailure,roomIdentity,roomReply,withRoomAudio,type RoomIdentity} from "@/lib/rooms/http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=120;
type Context={params:Promise<{code:string}>};
export async function GET(request:Request,context:Context){
  let identity:RoomIdentity|undefined;
  try{privateRoomRead(request);const code=normalizeRoomCode((await context.params).code);identity=roomIdentity(request);return roomReply({room:withRoomAudio(await readRoom(await roomDatabase(),code,identity.id))},identity);}
  catch(error){return roomFailure(error,identity);}
}
export async function POST(request:Request,context:Context){
  let identity:RoomIdentity|undefined;
  try{
    const body=await roomBody(request);const code=normalizeRoomCode((await context.params).code);identity=roomIdentity(request);const db=await roomDatabase();
    if(body.action==="join"){
      onlyFields(body,["action","nickname","avatar"]);requireRoomAudio();await rateLimit(db,identity.id,"room-join",20);
      const actor=await roomActor(request,body,identity);return roomReply({room:withRoomAudio(await joinRoom(db,code,actor))},identity);
    }
    const command=roomCommand(body);if(!["leave","heartbeat"].includes(command.action))requireRoomAudio();
    await rateLimit(db,identity.id,`room-${command.action==="heartbeat"?"heartbeat":"move"}:${code}`,command.action==="heartbeat"?12:120);
    let pool;
    if(command.action==="configure"||command.action==="rematch"){
      if(command.action==="rematch"){
        const existing=await findRematchedRoom(db,code,identity.id,command.requestId!);
        if(existing)return roomReply({room:withRoomAudio(existing)},identity);
      }
      const current=await readRoom(db,code,identity.id);
      if(current.hostId!==identity.id)throw new RoomError("Only the host can change this match.",403,"host_only");
      if(current.you.left||current.matchId!==command.matchId||current.round!==command.round)throw new RoomError("The room has moved on. Refreshing your match…",409,"stale_round");
      if(command.action==="configure"&&current.phase!=="lobby"||command.action==="rematch"&&current.phase!=="complete")throw new RoomError("Choose a new artist in the lobby, or finish this match before rematching.");
      await rateLimit(db,identity.id,"room-catalog",8,600000);
      const selection=command.action==="configure"?roomArtistSelection(body):{artistMode:current.artistMode??"chosen",artistId:current.artist.id};
      pool=selection.artistMode==="random"?await selectRandomArtist({excludeArtistId:current.artist.id,excludeArtistName:current.artist.name}):await loadArtist(selection.artistId!);
    }
    return roomReply({room:withRoomAudio(await commandRoom(db,code,identity.id,command,pool))},identity);
  }catch(error){return roomFailure(error,identity);}
}
