import {createHash, randomBytes} from "node:crypto";
import {getAccount} from "@musical-daily/accounts/server";
import {isAccountAvatar} from "@musical-daily/accounts";
import type {Database} from "@musical-daily/database";
import {store} from "../store.ts";
import {withBasePath} from "../app-path.ts";
import {CatalogError} from "../catalog.ts";
import {ensureRoomSchema} from "./store.ts";
import {RoomError, type PublicRoom, type RoomActor, type RoomCommand, type RoomArtistMode} from "./types.ts";

const COOKIE = "encore_room_player";
export interface RoomIdentity {token:string; id:string; fresh:boolean}
export function roomIdentity(request:Request):RoomIdentity {
  const value=request.headers.get("cookie")?.split(";").map(item=>item.trim()).find(item=>item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1);
  const fresh=!value||!/^[a-f0-9]{64}$/.test(value);
  const token=fresh?randomBytes(32).toString("hex"):value;
  return {token,id:createHash("sha256").update(token).digest("hex"),fresh};
}
export function roomReply(body:unknown,identity?:RoomIdentity,status=200) {
  const response=Response.json(body,{status,headers:{"Cache-Control":"private, no-store","Referrer-Policy":"same-origin","X-Content-Type-Options":"nosniff"}});
  if(identity?.fresh)response.headers.append("Set-Cookie",`${COOKIE}=${identity.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${process.env.NODE_ENV==="production"?"; Secure":""}`);
  return response;
}
export function roomFailure(error:unknown,identity?:RoomIdentity) {
  if(error instanceof RoomError)return roomReply({error:error.message,code:error.code},identity,error.status);
  if(error instanceof CatalogError){const response=roomReply({error:error.message,code:"catalog_unavailable"},identity,error.status);if(error.status===429)response.headers.set("Retry-After","60");return response;}
  const status=error&&typeof error==="object"&&"status" in error?Number(error.status):503;
  if(status===429){const response=roomReply({error:"A few too many requests. Give it a moment and retry.",code:"rate_limit"},identity,429);response.headers.set("Retry-After","60");return response;}
  console.error("Encore room request failed",{type:error instanceof Error?error.name:"UnknownError"});
  return roomReply({error:"The room couldn't connect. Your saved answers are safe; please retry.",code:"room_unavailable"},identity,503);
}
export function roomAudioEnabled(){return process.env.ENCORE_AUDIO_ENABLED==="true"||(process.env.NODE_ENV!=="production"&&process.env.ENCORE_AUDIO_ENABLED!=="false");}
export function requireRoomAudio(){if(!roomAudioEnabled())throw new RoomError("Encore audio is not enabled on this deployment yet.",503,"audio_disabled");}
export function privateRoomRead(request:Request){if(request.headers.get("sec-fetch-site")==="cross-site")throw new RoomError("Open the room from its invite link.",403,"invalid_origin");}
export async function roomBody(request:Request,expectedOrigin?:string):Promise<Record<string,unknown>> {
  const configured=process.env.NEXT_PUBLIC_MUSICAL_DAILY_SERVICES==="1"?process.env.MUSICAL_DAILY_AUTH_ORIGIN:process.env.MUSICAL_DAILY_APP_ORIGIN;
  const expected=expectedOrigin||new URL(configured||request.url).origin;
  if(request.headers.get("origin")!==expected)throw new RoomError("Invalid request origin.",403,"invalid_origin");
  if(request.headers.get("content-type")?.split(";",1)[0].trim().toLowerCase()!=="application/json")throw new RoomError("Send a JSON room request.",415,"invalid_body");
  if(Number(request.headers.get("content-length")||0)>2048)throw new RoomError("That request is too large.",413,"invalid_body");
  const reader=request.body?.getReader();if(!reader)throw new RoomError("Missing room request.",400,"invalid_body");
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>2048){await reader.cancel();throw new RoomError("That request is too large.",413,"invalid_body");}chunks.push(value);}}finally{reader.releaseLock();}
  let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new RoomError("Invalid room request.",400,"invalid_body");}
  if(!body||typeof body!=="object"||Array.isArray(body))throw new RoomError("Invalid room request.",400,"invalid_body");
  return body as Record<string,unknown>;
}
export function onlyFields(body:Record<string,unknown>,keys:string[]){if(Object.keys(body).some(key=>!keys.includes(key)))throw new RoomError("This room request contains unsupported fields.",400,"invalid_body");}
export function roomArtistId(value:unknown){if(typeof value!=="string"||!/^apple:[1-9]\d{0,14}$/.test(value))throw new RoomError("Choose an artist from the search results.",400,"invalid_artist");return value;}
export function roomArtistSelection(body:Record<string,unknown>):{artistMode:RoomArtistMode;artistId?:string} {
  const mode=body.artistMode===undefined?"chosen":body.artistMode;
  if(mode!=="chosen"&&mode!=="random")throw new RoomError("Choose an artist or let the room surprise you.",400,"invalid_artist_mode");
  if(mode==="random"){
    if(body.artistId!==undefined)throw new RoomError("Random rooms choose their artist for everyone. Leave the artist selection empty.",400,"invalid_artist_mode");
    return {artistMode:mode};
  }
  return {artistMode:mode,artistId:roomArtistId(body.artistId)};
}
export function roomRequestId(value:unknown){if(typeof value!=="string"||!(/^[a-zA-Z0-9-]{16,80}$/).test(value))throw new RoomError("Refresh and try that room request again.",400,"invalid_request");return value;}
export async function roomActor(request:Request,body:Record<string,unknown>,identity:RoomIdentity):Promise<RoomActor> {
  const user=await getAccount(request,"encore");
  const raw=body.nickname===undefined?user?.name?.split(" ")[0]||"Player":body.nickname;
  if(typeof raw!=="string")throw new RoomError("Choose a nickname for the room.",400,"invalid_name");
  const name=raw.normalize("NFKC").trim().replace(/\s+/g," ");
  if(!name||[...name].length>20||/[\p{Cc}\p{Cf}<>]/u.test(name))throw new RoomError("Use a nickname of 1–20 characters, without markup.",400,"invalid_name");
  const avatar=body.avatar===undefined?user?.avatar??null:body.avatar;
  if(avatar!==null&&!isAccountAvatar(avatar))throw new RoomError("Choose one of the music avatars.",400,"invalid_avatar");
  // Only this public nickname and emoji enter the room. Never expose email,
  // Google subject, account ID, or other players' solo scores.
  return {id:identity.id,name,avatar};
}
export function roomCommand(body:Record<string,unknown>):RoomCommand {
  onlyFields(body,["action","matchId","round","ready","choiceId","requestId","artistId","artistMode","audioRevision"]);
  const actions=["ready","start","loaded","guess","answer","pass","heartbeat","leave","retry","skip","rematch","configure"];
  if(typeof body.action!=="string"||!actions.includes(body.action)||typeof body.matchId!=="string"||body.matchId.length>100||!body.matchId||!Number.isInteger(body.round)||Number(body.round)<0||Number(body.round)>9)throw new RoomError("Reconnect to the current room and try again.",400,"invalid_move");
  if(body.action==="ready"&&typeof body.ready!=="boolean")throw new RoomError("Choose ready or not ready.",400,"invalid_move");
  if(body.action==="answer"&&(typeof body.choiceId!=="string"||body.choiceId.length>128||!body.choiceId))throw new RoomError("Choose one of the four songs.",400,"invalid_move");
  if(body.action==="loaded"&&(!Number.isInteger(body.audioRevision)||Number(body.audioRevision)<0))throw new RoomError("Load the current preview before getting ready.",400,"invalid_move");
  if(body.action==="rematch"||body.action==="configure")roomRequestId(body.requestId);
  if(body.action!=="configure"&&(body.artistMode!==undefined||body.artistId!==undefined))throw new RoomError("The room's artist can only be changed in the lobby.",400,"invalid_artist_mode");
  const selection=body.action==="configure"?roomArtistSelection(body):undefined;
  return {action:body.action as RoomCommand["action"],matchId:body.matchId,round:Number(body.round),...(selection?{artistMode:selection.artistMode}:{}),...(typeof body.ready==="boolean"?{ready:body.ready}:{}),...(typeof body.choiceId==="string"?{choiceId:body.choiceId}:{}),...(typeof body.requestId==="string"?{requestId:body.requestId}:{}),...(typeof body.audioRevision==="number"?{audioRevision:body.audioRevision}:{})};
}
const schemas=new WeakMap<Database,Promise<void>>();
export async function roomDatabase(){const db=await store();let ready=schemas.get(db);if(!ready){ready=ensureRoomSchema(db);schemas.set(db,ready);void ready.catch(()=>{if(schemas.get(db)===ready)schemas.delete(db);});}await ready;return db;}
export function withRoomAudio(room:PublicRoom):PublicRoom {
  // Timestamp the response after storage work so client clock estimation does
  // not mistake database latency for a difference between device clocks.
  room={...room,serverNow:Date.now()};
  const canListen=!room.you.left&&!room.you.answered&&room.you.guessAt===null&&(room.phase==="loading"||room.phase==="playing"&&room.startAt!==null&&room.serverNow<room.startAt+room.clipSeconds*1000);
  return canListen?{...room,audioUrl:withBasePath(`/api/rooms/${room.code}/audio?${new URLSearchParams({matchId:room.matchId,round:String(room.round),revision:String(room.audioRevision)})}`)}:room;
}
