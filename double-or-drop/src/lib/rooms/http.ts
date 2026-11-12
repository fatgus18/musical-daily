import {createHash,randomBytes} from "node:crypto";
import {getAccount} from "@musical-daily/accounts/server";
import {isAccountAvatar} from "@musical-daily/accounts";
import type {Database} from "@musical-daily/database";
import {store} from "../store.ts";
import {filterCatalog,listThemes,type Catalog} from "../catalog.ts";
import {availableMetrics,METRICS} from "../rules.ts";
import type {MetricFilter} from "../types.ts";
import {ensureRoomSchema} from "./store.ts";
import {RoomError,type PublicRoom,type RoomActor,type RoomCommand,type RoomSettings} from "./types.ts";

const COOKIE="double_drop_room_player";
export interface RoomIdentity {token:string;id:string;fresh:boolean}
export function roomIdentity(request:Request):RoomIdentity {
  const value=request.headers.get("cookie")?.split(";").map(item=>item.trim()).find(item=>item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1);
  const fresh=!value||!/^[a-f0-9]{64}$/.test(value);const token=fresh?randomBytes(32).toString("hex"):value;
  return {token,id:createHash("sha256").update(token).digest("hex"),fresh};
}
export function roomReply(body:unknown,identity?:RoomIdentity,status=200) {
  const response=Response.json(body,{status,headers:{"Cache-Control":"private, no-store","Referrer-Policy":"same-origin","X-Content-Type-Options":"nosniff"}});
  if(identity?.fresh)response.headers.append("Set-Cookie",`${COOKIE}=${identity.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${process.env.NODE_ENV==="production"?"; Secure":""}`);
  return response;
}
export function roomFailure(error:unknown,identity?:RoomIdentity) {
  if(error instanceof RoomError)return roomReply({error:error.message,code:error.code},identity,error.status);
  const status=error&&typeof error==="object"&&"status" in error?Number(error.status):503;
  if(status===429){const response=roomReply({error:"A few too many requests. Give it a moment and retry.",code:"rate_limit"},identity,429);response.headers.set("Retry-After","60");return response;}
  console.error("Double or Drop room request failed",{type:error instanceof Error?error.name:"UnknownError"});
  return roomReply({error:"The room couldn't connect. Your team's saved bank is safe; please retry.",code:"room_unavailable"},identity,503);
}
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
export function roomRequestId(value:unknown){if(typeof value!=="string"||!(/^[a-zA-Z0-9-]{16,80}$/).test(value))throw new RoomError("Refresh and try that room request again.",400,"invalid_request");return value;}
export async function roomActor(request:Request,body:Record<string,unknown>,identity:RoomIdentity):Promise<RoomActor> {
  const user=await getAccount(request,"double-drop");const raw=body.nickname===undefined?user?.name?.split(" ")[0]||"Player":body.nickname;
  if(typeof raw!=="string")throw new RoomError("Choose a nickname for the room.",400,"invalid_name");
  const name=raw.normalize("NFKC").trim().replace(/\s+/g," ");
  if(!name||[...name].length>20||/[\p{Cc}\p{Cf}<>]/u.test(name))throw new RoomError("Use a nickname of 1–20 characters, without markup.",400,"invalid_name");
  const avatar=body.avatar===undefined?user?.avatar??null:body.avatar;
  if(avatar!==null&&!isAccountAvatar(avatar))throw new RoomError("Choose one of the music avatars.",400,"invalid_avatar");
  // Room membership is independent of solo runs. Only nickname and emoji are public.
  return {id:identity.id,name,avatar};
}
export function roomCreation(body:Record<string,unknown>) {
  onlyFields(body,["action","requestId","nickname","avatar","theme","metricFilter","catalogVersion"]);
  if(body.action!=="create")throw new RoomError("Choose create room.",400,"invalid_action");
  const requestId=roomRequestId(body.requestId);const theme=body.theme===undefined?"all":body.theme;const metricFilter=body.metricFilter===undefined?"mixed":body.metricFilter;
  if(typeof theme!=="string"||!theme||theme.length>150||typeof metricFilter!=="string"||!(metricFilter==="mixed"||METRICS.includes(metricFilter as Exclude<MetricFilter,"mixed">)))throw new RoomError("Choose a valid music collection and comparison type.",400,"invalid_collection");
  if(body.catalogVersion!==undefined&&(typeof body.catalogVersion!=="string"||!/^[a-f0-9]{16}$/.test(body.catalogVersion)))throw new RoomError("Choose a current music collection.",400,"invalid_collection");
  return {requestId,theme,metricFilter:metricFilter as MetricFilter,catalogVersion:body.catalogVersion as string|undefined};
}
export function roomSettings(catalog:Catalog,selection:ReturnType<typeof roomCreation>):RoomSettings {
  const tracks=filterCatalog(catalog,selection.theme);
  if(tracks.length<2||!availableMetrics(tracks,selection.metricFilter).length)throw new RoomError("This collection needs more comparable songs. Choose another collection.",422,"insufficient_songs");
  const themeLabel=listThemes(catalog).find(theme=>theme.id===selection.theme)?.label||(selection.theme.startsWith("artist:")?(tracks[0].primaryArtist||tracks[0].artist):undefined);
  if(!themeLabel)throw new RoomError("Choose one of the available music collections.",400,"invalid_collection");
  return {theme:selection.theme,themeLabel,metricFilter:selection.metricFilter};
}
export function roomCommand(body:Record<string,unknown>):RoomCommand {
  onlyFields(body,["action","matchId","turn","requestId","ready","choice"]);
  const actions=["ready","start","pick","bank","risk","guess","heartbeat","leave","rematch"];
  if(typeof body.action!=="string"||!actions.includes(body.action)||typeof body.matchId!=="string"||!body.matchId||body.matchId.length>100||!Number.isSafeInteger(body.turn)||Number(body.turn)<0||Number(body.turn)>1_000_000_000)throw new RoomError("Reconnect to the current turn and try again.",400,"invalid_move");
  if(body.action==="ready"?typeof body.ready!=="boolean":body.ready!==undefined)throw new RoomError("Choose ready or not ready in the lobby.",400,"invalid_move");
  if(body.action==="guess"?body.choice!=="left"&&body.choice!=="right":body.choice!==undefined)throw new RoomError("Choose the song on the left or right during your pick.",400,"invalid_move");
  if(body.requestId!==undefined||!["ready","heartbeat","leave"].includes(body.action))roomRequestId(body.requestId);
  return {action:body.action as RoomCommand["action"],matchId:body.matchId,turn:Number(body.turn),...(typeof body.requestId==="string"?{requestId:body.requestId}:{}),...(typeof body.ready==="boolean"?{ready:body.ready}:{}),...(body.choice==="left"||body.choice==="right"?{choice:body.choice}:{})};
}
const schemas=new WeakMap<Database,Promise<void>>();
export async function roomDatabase(){const db=await store();let ready=schemas.get(db);if(!ready){ready=ensureRoomSchema(db);schemas.set(db,ready);void ready.catch(()=>{if(schemas.get(db)===ready)schemas.delete(db);});}await ready;return db;}
export function roomResponse(room:PublicRoom):PublicRoom{return {...room,serverNow:Date.now()};}
