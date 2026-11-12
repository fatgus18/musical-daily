import {loadArtist} from "@/lib/catalog";
import {rateLimit} from "@/lib/store";
import {createRoom,findCreatedRoom} from "@/lib/rooms/store";
import {selectRandomArtist} from "@/lib/rooms/random-artist";
import {RoomError} from "@/lib/rooms/types";
import {onlyFields,privateRoomRead,requireRoomAudio,roomActor,roomArtistSelection,roomAudioEnabled,roomBody,roomDatabase,roomFailure,roomIdentity,roomReply,roomRequestId,withRoomAudio,type RoomIdentity} from "@/lib/rooms/http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
// Inherit the service timeout; provider selection keeps its own bounded deadline.
export function GET(request:Request){try{privateRoomRead(request);return roomReply({audioEnabled:roomAudioEnabled()},roomIdentity(request));}catch(error){return roomFailure(error);}}
export async function POST(request:Request){
  let identity:RoomIdentity|undefined;
  try{
    const body=await roomBody(request);onlyFields(body,["action","artistId","artistMode","nickname","avatar","requestId"]);
    if(body.action!=="create")throw new RoomError("Choose create room.",400,"invalid_action");
    requireRoomAudio();const selection=roomArtistSelection(body);const requestId=roomRequestId(body.requestId);identity=roomIdentity(request);
    const actor=await roomActor(request,body,identity);const db=await roomDatabase();await rateLimit(db,actor.id,"room-create",5,600000);
    const existing=await findCreatedRoom(db,actor.id,requestId);
    if(existing)return roomReply({room:withRoomAudio(existing)},identity);
    const pool=selection.artistMode==="random"?await selectRandomArtist():await loadArtist(selection.artistId!);
    return roomReply({room:withRoomAudio(await createRoom(db,actor,pool,requestId,Date.now(),selection.artistMode))},identity);
  }catch(error){return roomFailure(error,identity);}
}
