import {randomInt} from "node:crypto";
import type {Database,SqlExecutor} from "@musical-daily/database";
import type {ArtistPool,Track} from "../catalog.ts";
import {advanceRoom,applyRoomCommand,createRoomState,joinRoomState,projectRoom,requireMember,ROOM_IDLE_MS} from "./engine.ts";
import {RoomError,type RoomActor,type RoomArtistMode,type RoomCommand,type RoomState,type PublicRoom} from "./types.ts";

const ALPHABET="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function normalizeRoomCode(value:string):string {
  const code=value.trim().toUpperCase();
  if(!/^[A-HJ-NP-Z2-9]{6}$/.test(code))throw new RoomError("Enter a valid six-character room code.",400,"invalid_code");
  return code;
}
export async function ensureRoomSchema(db:Database) {
  await db.executeMultiple(`CREATE TABLE IF NOT EXISTS encore_rooms(
    code TEXT PRIMARY KEY,created_by TEXT NOT NULL,request_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,
    UNIQUE(created_by,request_id));
    CREATE INDEX IF NOT EXISTS encore_rooms_expiry ON encore_rooms(expires_at);`);
}
function decode(row:Record<string,unknown>|undefined,now:number):RoomState {
  if(!row)throw new RoomError("That room could not be found. Check the code or create a new one.",404,"room_not_found");
  if(Number(row.expires_at)<=now)throw new RoomError("This room has expired. Create a new room to play again.",410,"room_expired");
  return JSON.parse(String(row.state)) as RoomState;
}
async function load(db:SqlExecutor,code:string,now:number) {
  return decode((await db.execute("SELECT expires_at,state FROM encore_rooms WHERE code=?",[code])).rows[0],now);
}
async function write(db:SqlExecutor,room:RoomState,now:number,extendIdle=false) {
  room.revision++;room.updatedAt=now;
  if(extendIdle&&room.phase!=="complete")room.expiresAt=now+ROOM_IDLE_MS;
  await db.execute("UPDATE encore_rooms SET state=?,revision=?,expires_at=? WHERE code=?",[JSON.stringify(room),room.revision,room.expiresAt,room.code]);
}
function requestId(value:string) {
  if(!value||value.length>128)throw new RoomError("A valid request ID is required.",400,"invalid_request");
}
/** Short bounded cleanup: no private song histories survive room expiration. */
export async function pruneRooms(db:SqlExecutor,now=Date.now()) {
  return (await db.execute("DELETE FROM encore_rooms WHERE code IN (SELECT code FROM encore_rooms WHERE expires_at<=? ORDER BY expires_at LIMIT 20)",[now])).rowsAffected;
}
/** Retry a completed creation without another provider lookup or random draw. */
export async function findCreatedRoom(db:Database,actorId:string,id:string,now=Date.now()):Promise<PublicRoom|undefined> {
  const row=(await db.execute("SELECT expires_at,state FROM encore_rooms WHERE created_by=? AND request_id=?",[actorId,id])).rows[0];
  if(!row)return undefined;
  return readRoom(db,decode(row,now).code,actorId,now);
}
/** Rematch responses can be lost. A retry returns the existing match unchanged. */
export async function findRematchedRoom(db:Database,rawCode:string,id:string,rematchId:string,now=Date.now()):Promise<PublicRoom|undefined> {
  const code=normalizeRoomCode(rawCode);const room=await load(db,code,now);const player=requireMember(room,id);
  if(room.hostId!==id||player.left)throw new RoomError("Only the host can change this match.",403,"host_only");
  return room.lastRematchRequestId===rematchId?readRoom(db,code,id,now):undefined;
}
export async function createRoom(db:Database,actor:RoomActor,pool:ArtistPool,id:string,now=Date.now(),artistMode:RoomArtistMode="chosen"):Promise<PublicRoom> {
  requestId(id);
  return db.transaction(async tx=>{
    const duplicate=(await tx.execute("SELECT expires_at,state FROM encore_rooms WHERE created_by=? AND request_id=?",[actor.id,id])).rows[0];
    if(duplicate)return projectRoom(decode(duplicate,now),actor.id,now);
    await pruneRooms(tx,now);
    for(let attempt=0;attempt<8;attempt++){
      const code=Array.from({length:6},()=>ALPHABET[randomInt(ALPHABET.length)]).join("");
      const room=createRoomState(code,actor,pool,id,now,artistMode);
      const inserted=await tx.execute("INSERT INTO encore_rooms(code,created_by,request_id,expires_at,revision,state) VALUES(?,?,?,?,?,?) ON CONFLICT(code) DO NOTHING",[code,actor.id,id,room.expiresAt,room.revision,JSON.stringify(room)]);
      if(inserted.rowsAffected)return projectRoom(room,actor.id,now);
    }
    throw new RoomError("We couldn't reserve a room code. Please try again.",503,"room_creation_busy");
  });
}
export async function joinRoom(db:Database,rawCode:string,actor:RoomActor,now=Date.now()):Promise<PublicRoom> {
  const code=normalizeRoomCode(rawCode);
  return db.transaction(async tx=>{
    const room=await load(tx,code,now);advanceRoom(room,now);joinRoomState(room,actor,now);await write(tx,room,now,true);return projectRoom(room,actor.id,now);
  });
}
/** Steady polling costs one read. Only a phase/host change opens a write transaction. */
export async function readRoom(db:Database,rawCode:string,id:string,now=Date.now()):Promise<PublicRoom> {
  const code=normalizeRoomCode(rawCode);const initial=await load(db,code,now);requireMember(initial,id);
  if(!advanceRoom(initial,now))return projectRoom(initial,id,now);
  return db.transaction(async tx=>{
    const room=await load(tx,code,now);requireMember(room,id);if(advanceRoom(room,now))await write(tx,room,now);return projectRoom(room,id,now);
  });
}
export async function commandRoom(db:Database,rawCode:string,id:string,command:RoomCommand,pool?:ArtistPool,now=Date.now()):Promise<PublicRoom> {
  const code=normalizeRoomCode(rawCode);
  return db.transaction(async tx=>{
    const room=await load(tx,code,now);requireMember(room,id);advanceRoom(room,now);
    applyRoomCommand(room,id,command,pool,now);await write(tx,room,now,true);return projectRoom(room,id,now);
  });
}
/** Provider URLs are private and may only be streamed for the current unheard clip. */
export async function roomAudioTrack(db:Database,rawCode:string,id:string,matchId:string,round:number,now=Date.now(),audioRevision?:number):Promise<Track> {
  const room=await load(db,normalizeRoomCode(rawCode),now);const player=requireMember(room,id);
  if(room.matchId!==matchId||room.round!==round||audioRevision!==undefined&&room.audioRevision!==audioRevision)throw new RoomError("This audio belongs to an older round.",409,"stale_round");
  if(player.left||!["loading","playing"].includes(room.phase))throw new RoomError("That clip is not available now.",403,"audio_unavailable");
  if(room.phase==="loading"&&room.loadingDeadline!==null&&now>=room.loadingDeadline)throw new RoomError("Loading time expired for this clip.",409,"stale_round");
  if(player.answer||player.guessAt!==null||room.startAt!==null&&now>=room.startAt+15_000)throw new RoomError("Audio closes once guessing begins.",403,"audio_closed");
  return room.picks[round].track;
}
