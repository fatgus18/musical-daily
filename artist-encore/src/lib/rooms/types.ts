import type {Artist, ArtistPool} from "../catalog.ts";
import type {AnswerChoice, Exposure, Pick} from "../types.ts";

export type RoomPhase = "lobby" | "loading" | "playing" | "reveal" | "complete";
export interface RoomActor {id:string; name:string; avatar?:string|null}
export interface RoomAnswer {choiceId:string|null; correct:boolean; elapsedMs:number; answeredAt:number; timedOut:boolean}
export interface RoomMember extends RoomActor {
  joinedAt:number; seenAt:number; ready:boolean; loaded:boolean; left:boolean;
  guessAt:number|null; answer:RoomAnswer|null;
}
export interface RoomRoundResult {
  round:number; title:string; artist:string; artwork:string; url:string;
  correctChoiceId:string; choices:AnswerChoice[]; voided:boolean;
  reason:"preview_unavailable"|"host_skipped"|null;
  answers:{playerId:string; choiceId:string|null; correct:boolean; elapsedMs:number; timedOut:boolean}[];
}
/** Never serialize this private state to a browser. Use projectRoom instead. */
export interface RoomState {
  code:string; matchId:string; revision:number; hostId:string; createdBy:string; requestId:string;
  artist:Artist; ranking:ArtistPool["ranking"]; phase:RoomPhase; members:RoomMember[];
  picks:Pick[]; history:Exposure[]; round:number; createdAt:number; updatedAt:number; expiresAt:number;
  startAt:number|null; roundEnd:number|null; loadingDeadline:number|null; revealUntil:number|null;
  reveals:RoomRoundResult[]; lastRematchRequestId:string|null; audioRevision:number;
}
export interface PublicRoomPlayer extends RoomActor {
  ready:boolean; loaded:boolean; answered:boolean; left:boolean; present:boolean;
}
export interface RoomStanding extends RoomActor {
  score:number; correct:number; timeMs:number; rank:number; left:boolean; winner:boolean;
}
export interface PublicRoom {
  code:string; matchId:string; revision:number; phase:RoomPhase; artist:Artist;
  hostId:string; youId:string; players:PublicRoomPlayer[]; round:number; totalRounds:number;
  serverNow:number; startAt:number|null; roundEnd:number|null; loadingDeadline:number|null; revealUntil:number|null;
  clipSeconds:number; clipOffset:number; guessSeconds:number; audioRevision:number;
  /** Added by the route only when that participant may still listen. */
  audioUrl?:string;
  choices?:AnswerChoice[];
  you:{ready:boolean; loaded:boolean; guessAt:number|null; guessDeadline:number|null; answered:boolean; choiceId:string|null; passed:boolean; left:boolean};
  reveals:RoomRoundResult[]; leaderboard:RoomStanding[];
}
export type RoomAction = "ready"|"start"|"loaded"|"guess"|"answer"|"pass"|"heartbeat"|"leave"|"retry"|"skip"|"rematch"|"configure";
export interface RoomCommand {
  action:RoomAction; matchId:string; round:number; requestId?:string; ready?:boolean; choiceId?:string; audioRevision?:number;
}
export class RoomError extends Error {
  readonly status:number;
  readonly code:string;
  constructor(message:string, status=409, code="room_conflict") {super(message); this.name="RoomError"; this.status=status; this.code=code;}
}
