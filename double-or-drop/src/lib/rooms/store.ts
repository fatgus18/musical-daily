import {randomInt} from "node:crypto";
import type {Database,SqlExecutor} from "@musical-daily/database";
import type {Catalog} from "../catalog.ts";
import {initializeCatalogStorage,pinRoomCatalog} from "../catalog-storage.ts";
import {advanceRoom,applyRoomCommand,createRoomState,joinRoomState,projectRoom,requireMember,ROOM_IDLE_MS} from "./engine.ts";
import {RoomError,type RoomActor,type RoomClock,type RoomCommand,type RoomSettings,type RoomState,type PublicRoom} from "./types.ts";

const alphabet="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function normalizeRoomCode(value:string){const code=value.trim().toUpperCase();if(!/^[A-HJ-NP-Z2-9]{6}$/.test(code))throw new RoomError("Enter a valid six-character code.",400,"invalid_code");return code;}
export async function ensureRoomSchema(db:Database){
  await initializeCatalogStorage(db);
  await db.executeMultiple(`CREATE TABLE IF NOT EXISTS double_drop_rooms(code TEXT PRIMARY KEY,created_by TEXT NOT NULL,request_id TEXT NOT NULL,catalog_version TEXT NOT NULL,expires_at INTEGER NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,UNIQUE(created_by,request_id));
    CREATE INDEX IF NOT EXISTS double_drop_room_expiry ON double_drop_rooms(expires_at);`);
}
function decode(row:Record<string,unknown>|undefined,now:number):RoomState {
  if(!row)throw new RoomError("That room could not be found. Check the code.",404,"room_not_found");
  if(Number(row.expires_at)<=now)throw new RoomError("This room has expired. Start another team run.",410,"room_expired");
  return JSON.parse(String(row.state)) as RoomState;
}
async function load(db:SqlExecutor,code:string,clock:RoomClock){const row=(await db.execute("SELECT state,expires_at FROM double_drop_rooms WHERE code=?",[code])).rows[0];const now=clock();return{room:decode(row,now),now};}
async function write(db:SqlExecutor,room:RoomState,now:number,extendIdle=false){
  room.revision++;room.updatedAt=now;if(extendIdle&&room.phase!=="complete")room.expiresAt=now+ROOM_IDLE_MS;
  await db.batch([{sql:"UPDATE double_drop_rooms SET state=?,revision=?,catalog_version=?,expires_at=? WHERE code=?",args:[JSON.stringify(room),room.revision,room.game.catalogVersion,room.expiresAt,room.code]},
    {sql:"UPDATE catalog_room_pins SET expires_at=? WHERE room_code=?",args:[room.expiresAt,room.code]}]);
}
export async function pruneRooms(db:SqlExecutor,now=Date.now()){
  const rows=(await db.execute("SELECT code FROM double_drop_rooms WHERE expires_at<=? ORDER BY expires_at LIMIT 20",[now])).rows;
  if(!rows.length)return 0;
  const result=await db.batch(rows.flatMap(row=>[{sql:"DELETE FROM catalog_room_pins WHERE room_code=? AND EXISTS(SELECT 1 FROM double_drop_rooms WHERE code=? AND expires_at<=?)",args:[row.code,row.code,now]},{sql:"DELETE FROM double_drop_rooms WHERE code=? AND expires_at<=?",args:[row.code,now]}]));return result.filter((_,index)=>index%2===1).reduce((sum,item)=>sum+item.rowsAffected,0);
}
export async function findCreatedRoom(db:Database,actorId:string,id:string,clock:RoomClock=Date.now):Promise<PublicRoom|undefined>{const row=(await db.execute("SELECT state,expires_at FROM double_drop_rooms WHERE created_by=? AND request_id=?",[actorId,id])).rows[0];return row?readRoom(db,decode(row,clock()).code,actorId,clock):undefined;}
export async function findRematchedRoom(db:Database,rawCode:string,id:string,requestId:string,clock:RoomClock=Date.now):Promise<PublicRoom|undefined>{const code=normalizeRoomCode(rawCode);const {room}=await load(db,code,clock);const p=requireMember(room,id);if(room.hostId!==id||p.left)throw new RoomError("Only the host can start a rematch.",403,"host_only");return room.lastRematchRequestId===requestId?readRoom(db,code,id,clock):undefined;}
export async function createRoom(db:Database,actor:RoomActor,catalog:Catalog,requestId:string,settings:RoomSettings={},clock:RoomClock=Date.now):Promise<PublicRoom>{
  if(!requestId||requestId.length>128)throw new RoomError("A request ID is required.",400,"invalid_request");
  return db.transaction(async tx=>{
    const existing=(await tx.execute("SELECT state,expires_at FROM double_drop_rooms WHERE created_by=? AND request_id=?",[actor.id,requestId])).rows[0];const now=clock();
    if(existing)return projectRoom(decode(existing,now),actor.id,now);
    await pruneRooms(tx,now);
    for(let attempt=0;attempt<8;attempt++){
      const code=Array.from({length:6},()=>alphabet[randomInt(alphabet.length)]).join("");const room=createRoomState(code,actor,catalog,requestId,settings,now);
      const result=await tx.execute("INSERT INTO double_drop_rooms VALUES(?,?,?,?,?,?,?) ON CONFLICT(code) DO NOTHING",[code,actor.id,requestId,catalog.version,room.expiresAt,room.revision,JSON.stringify(room)]);
      if(result.rowsAffected){await pinRoomCatalog(tx,catalog,code,room.expiresAt,now);return projectRoom(room,actor.id,now);}
    }
    throw new RoomError("Could not reserve a room code. Retry shortly.",503,"room_creation_busy");
  });
}
export async function joinRoom(db:Database,rawCode:string,actor:RoomActor,clock:RoomClock=Date.now):Promise<PublicRoom>{
  const code=normalizeRoomCode(rawCode);return db.transaction(async tx=>{const{room,now}=await load(tx,code,clock);advanceRoom(room,now);joinRoomState(room,actor,now);advanceRoom(room,now);await write(tx,room,now,true);return projectRoom(room,actor.id,now);});
}
/** Normal polling is a single read; write transactions only settle a timer or handoff. */
export async function readRoom(db:Database,rawCode:string,id:string,clock:RoomClock=Date.now):Promise<PublicRoom>{
  const code=normalizeRoomCode(rawCode);const first=await load(db,code,clock);requireMember(first.room,id);if(!advanceRoom(first.room,first.now))return projectRoom(first.room,id,first.now);
  return db.transaction(async tx=>{const{room,now}=await load(tx,code,clock);requireMember(room,id);if(advanceRoom(room,now))await write(tx,room,now);return projectRoom(room,id,now);});
}
export async function commandRoom(db:Database,rawCode:string,id:string,command:RoomCommand,catalog?:Catalog,clock:RoomClock=Date.now):Promise<PublicRoom>{
  const code=normalizeRoomCode(rawCode);
  const result=await db.transaction(async tx=>{
    const{room,now}=await load(tx,code,clock);requireMember(room,id);const changed=advanceRoom(room,now);const draft=structuredClone(room);
    try{
      applyRoomCommand(draft,id,command,catalog,now);
      if(command.action==="rematch"&&draft.matchId!==room.matchId&&catalog)await pinRoomCatalog(tx,catalog,code,draft.expiresAt,now);
      await write(tx,draft,now,true);return{room:projectRoom(draft,id,now)};
    }catch(error){if(!(error instanceof RoomError))throw error;if(changed)await write(tx,room,now);return{error};}
  });
  if(result.error)throw result.error;return result.room!;
}
