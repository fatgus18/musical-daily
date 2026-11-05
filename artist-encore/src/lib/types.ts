import type {Artist,ArtistPool,Track} from "./catalog.ts";
export type Tier="hit"|"favorite"|"deep"|"discovery";
export type MixMode="ranked"|"discovery";
export type Phase="ready"|"listening"|"guessing"|"reveal"|"complete"|"discarded";
export type IncompleteReason="discarded"|"replaced"|"expired"|"account-merge";
export interface AnswerChoice {id:string;label:string}
export interface Pick {track:Track;tier:Tier;choices?:AnswerChoice[];correctChoiceId?:string}
export interface Result {round:number;title:string;artist:string;artwork:string;url:string;tier:Tier;input:string;correct:boolean;skipped:boolean;timedOut?:boolean;assisted?:boolean}
/** Private IDs are retained so requests from a stale tab cannot pick a removed option. */
export interface FiftyFifty {round:number;removedChoiceIds:string[]}
export interface Game {id:string;player:string;artist:Artist;ranking:ArtistPool["ranking"];picks:Pick[];round:number;phase:Phase;results:Result[];listenAt:number|null;guessDeadline?:number|null;createdAt:number;completedAt:number|null;requestId:string;replaced?:string[];mode?:MixMode;poolSize?:number;coverage?:ArtistPool["coverage"];rankingFingerprint?:string;completionStatus?:"completed"|"incomplete";incompleteReason?:IncompleteReason;fiftyFifty?:FiftyFifty}
export interface PublicGame {id:string;artist:Artist;ranking:ArtistPool["ranking"];round:number;phase:Phase;results:Result[];correct:number;tier:Tier;listenAt:number|null;guessDeadline?:number|null;serverNow:number;preview?:string;choices?:AnswerChoice[];mixCounts?:{hit:number;favorite:number;deep:number};clipOffset:number;clipSeconds:number;poolSize?:number;mode?:MixMode;coverage?:ArtistPool["coverage"];completionStatus?:"completed"|"incomplete";incompleteReason?:IncompleteReason;lifeline?:{used:boolean;round:number|null;active:boolean}}
export interface CatalogOffer {artist:Artist;previewable:number;ranked:number;rankedAvailable:boolean;discoveryAvailable:boolean;coverage?:ArtistPool["coverage"];ranking:ArtistPool["ranking"]}
export interface Exposure {id:string;plays:number;lastPlayed:number}
