export type GameId = "blackjack" | "tempo" | "encore" | "double-drop";
export type ResultStatus = "completed" | "incomplete";
export type IncompleteReason = "discarded" | "replaced" | "expired" | "account-merge";
export type AccountAvatar = "headphones" | "microphone" | "guitar" | "piano" | "drums" | "trumpet" | "saxophone" | "violin" | "music-note" | "score";
export declare const ACCOUNT_AVATARS: readonly Readonly<{ id: AccountAvatar; emoji: string; label: string }>[];
export declare function isAccountAvatar(value: unknown): value is AccountAvatar;
export interface AccountUser { id: string; name: string; email: string; picture: string | null; avatar?: AccountAvatar | null }
export interface ResultEvent { eventId: string; mode: "daily" | "practice" | "artist"; date?: string; status?: ResultStatus; incompleteReason?: IncompleteReason; score: number; maxScore: number; won?: boolean; correct?: number; rounds?: number; bankedPoints?: number; artist?: { id: string; name: string } }
export interface GameStats { played: number; completed: number; incomplete?: number; wins: number; totalScore: number; bestScore: number; averageScore: number; averagePercent: number; totalCorrect: number; totalRounds: number; totalBanked?: number; bestBanked?: number; currentStreak: number; bestStreak: number; lastPlayed: string | null; recent: Array<{ eventId: string; date: string; mode?: ResultEvent["mode"]; status?: ResultStatus; incompleteReason?: IncompleteReason; score: number; maxScore: number; correct?: number; rounds?: number; won: boolean; bankedPoints?: number; artist?: { id: string; name: string } }> }
export interface AccountStats { user: AccountUser | null; games: Record<GameId, GameStats> }
export interface ProgressSnapshot { value: unknown; revision: number }
export interface ProgressResult { saved: boolean; revision: number; conflict?: boolean; value?: unknown; event?: ResultEvent; duplicate?: boolean }
export interface PublishResult { saved: boolean; duplicate?: boolean; event?: ResultEvent }
export declare const GAME_IDS: readonly GameId[];
