import {loadArtist} from "@/lib/catalog";
import {rateLimit} from "@/lib/store";
import {createRoom} from "@/lib/rooms/store";
import {RoomError} from "@/lib/rooms/types";
import {onlyFields,privateRoomRead,requireRoomAudio,roomActor,roomArtistId,roomAudioEnabled,roomBody,roomDatabase,roomFailure,roomIdentity,roomReply,roomRequestId,withRoomAudio,type RoomIdentity} from "@/lib/rooms/http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=120;
export function GET(request:Request){try{privateRoomRead(request);return roomReply({audioEnabled:roomAudioEnabled()},roomIdentity(request));}catch(error){return roomFailure(error);}}
export async function POST(request:Request){
  let identity:RoomIdentity|undefined;
  try{
    const body=await roomBody(request);onlyFields(body,["action","artistId","nickname","avatar","requestId"]);
    if(body.action!=="create")throw new RoomError("Choose create room.",400,"invalid_action");
    requireRoomAudio();const artistId=roomArtistId(body.artistId);const requestId=roomRequestId(body.requestId);identity=roomIdentity(request);
    const actor=await roomActor(request,body,identity);const db=await roomDatabase();await rateLimit(db,actor.id,"room-create",5,600000);
    const pool=await loadArtist(artistId);
    return roomReply({room:withRoomAudio(await createRoom(db,actor,pool,requestId))},identity);
  }catch(error){return roomFailure(error,identity);}
}
