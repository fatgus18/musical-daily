import {roomAudioTrack,normalizeRoomCode} from "@/lib/rooms/store";
import {RoomError} from "@/lib/rooms/types";
import {privateRoomRead,requireRoomAudio,roomDatabase,roomFailure,roomIdentity} from "@/lib/rooms/http";
import {cachedPreview} from "@/lib/rooms/audio";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
export async function GET(request:Request,context:{params:Promise<{code:string}>}){
  try{
    privateRoomRead(request);requireRoomAudio();const identity=roomIdentity(request);if(identity.fresh)throw new RoomError("Join this room before listening.",401,"not_member");
    const code=normalizeRoomCode((await context.params).code);const params=new URL(request.url).searchParams;
    const matchId=params.get("matchId")||"";const round=Number(params.get("round"));const revision=Number(params.get("revision"));
    if(!matchId||matchId.length>100||!params.has("round")||!params.has("revision")||!Number.isInteger(round)||round<0||round>9||!Number.isInteger(revision)||revision<0)throw new RoomError("Load the current round's preview.",400,"invalid_audio_request");
    const db=await roomDatabase();const track=await roomAudioTrack(db,code,identity.id,matchId,round,Date.now(),revision);
    const audio=await cachedPreview(track.preview);
    // Loading may have ended or been retried while the provider was responding.
    await roomAudioTrack(db,code,identity.id,matchId,round,Date.now(),revision);
    return new Response(audio.bytes,{headers:{"Content-Type":audio.type,"Content-Length":String(audio.bytes.byteLength),"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Cross-Origin-Resource-Policy":"same-origin"}});
  }catch(error){return roomFailure(error);}
}
