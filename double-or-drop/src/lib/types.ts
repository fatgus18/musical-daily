import type {CatalogTrack, Metric} from "./catalog.ts";
import type {BankTarget} from "./run-goals.ts";

export type Side = "left" | "right";
export type Phase = "guess" | "decision" | "miss" | "complete";
export type MetricFilter = Metric | "mixed";
export type Move = "guess" | "timeout" | "bank" | "risk" | "next" | "cashout" | "discard";
export type CompletionStatus = "completed" | "incomplete";
export interface Pair {left:CatalogTrack;right:CatalogTrack;metric:Metric}
export interface RunHistory {recentTracks:string[];recentPairs:string[]}
export interface ValueReveal {value:number;formatted:string;source:string;asOf?:string;quality?:string}
export interface RoundResult {
  round:number;metric:Metric;selected:Side|null;winner:Side;correct:boolean;timedOut:boolean;
  left:ValueReveal;right:ValueReveal;leftTitle:string;rightTitle:string;
  explanation:string;earned:number;
}
export interface Game {
  id:string;player:string;requestId:string;revision:number;catalogVersion:string;
  phase:Phase;round:number;lives:number;banked:number;pot:number;ladder:number;
  correct:number;answered:number;currentStreak:number;bestStreak:number;
  theme:string;metricFilter:MetricFilter;pair:Pair;results:RoundResult[];
  recentTracks:string[];recentPairs:string[];createdAt:number;updatedAt:number;
  // Undefined only for saved runs written before timed picks were introduced.
  guessDeadline?:number|null;
  completedAt:number|null;endReason?:"cashout"|"lives"|"score-limit"|"run-limit"|"account-merge"|"expired"|"discarded";
  // Older terminal snapshots are completed unless an explicit status was recorded.
  completionStatus?:CompletionStatus;
  modeNotice?:string;
  bankTarget?:BankTarget|null;bestBankToBeat?:number|null;
}
export interface PublicTrack {id:string;title:string;artist:string;artwork:string;previewUrl?:string;previewSourceUrl?:string}
export interface PublicGame {
  id:string;revision:number;phase:Phase;round:number;lives:number;banked:number;pot:number;
  ladder:number;correct:number;answered:number;currentStreak:number;bestStreak:number;
  theme:string;metricFilter:MetricFilter;canRisk:boolean;nextReward:number;maxLadder:number;
  pair:{left:PublicTrack;right:PublicTrack;metric:Metric;label:string;question:string;unit:string};
  reveal?:RoundResult;results:RoundResult[];guessDeadline:number|null;serverNow:number;createdAt:number;completedAt:number|null;
  endReason?:Game["endReason"];completionStatus:CompletionStatus|null;catalogVersion:string;
  modeNotice?:string;
  bankTarget?:BankTarget|null;bestBankToBeat?:number|null;
}
