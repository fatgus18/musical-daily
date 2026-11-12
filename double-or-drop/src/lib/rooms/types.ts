import type {Game,MetricFilter,PublicGame,RoundResult,Side} from "../types.ts";

export type RoomPhase="lobby"|"decision"|"guess"|"reveal"|"paused"|"complete";
export interface RoomActor {id:string;name:string;avatar?:string|null}
export interface RoomMember extends RoomActor {joinedAt:number;seenAt:number;ready:boolean;left:boolean}
export interface RoomTurnResult extends RoundResult {playerId:string;playerName:string;lostPot:number;turn:number}
export interface RoomSettings {theme?:string;themeLabel?:string;metricFilter?:MetricFilter}
/** Private shared solo-engine state. Never send this object to a browser. */
export interface RoomState {
  code:string;matchId:string;revision:number;createdBy:string;requestId:string;hostId:string;
  phase:RoomPhase;members:RoomMember[];activePlayerId:string|null;turn:number;game:Game;themeLabel:string;
  revealUntil:number|null;recentTurns:RoomTurnResult[];createdAt:number;updatedAt:number;expiresAt:number;
  lastRematchRequestId:string|null;processed:{id:string;playerId:string;matchId:string;turn:number;action:string}[];
}
export interface PublicRoomPlayer extends RoomActor {ready:boolean;left:boolean;present:boolean}
export interface PublicRoom {
  code:string;matchId:string;revision:number;phase:RoomPhase;hostId:string;youId:string;
  players:PublicRoomPlayer[];activePlayerId:string|null;turn:number;serverNow:number;
  guessDeadline:number|null;revealUntil:number|null;catalogVersion:string;theme:string;themeLabel:string;metricFilter:MetricFilter;
  team:{banked:number;pot:number;lives:number;answered:number;correct:number;bestStreak:number;currentStreak:number;ladder:number;canRisk:boolean;nextReward:number;maxLadder:number};
  pair?:PublicGame["pair"];reveal?:RoomTurnResult;recentTurns:RoomTurnResult[];
  you:{ready:boolean;left:boolean};completionStatus?:Game["completionStatus"];endReason?:Game["endReason"];
}
export type RoomAction="ready"|"start"|"pick"|"bank"|"risk"|"guess"|"heartbeat"|"leave"|"rematch";
export interface RoomCommand {action:RoomAction;matchId:string;turn:number;requestId?:string;ready?:boolean;choice?:Side}
export type RoomClock=()=>number;
export class RoomError extends Error {
  readonly status:number;readonly code:string;
  constructor(message:string,status=409,code="room_conflict"){super(message);this.name="RoomError";this.status=status;this.code=code;}
}
