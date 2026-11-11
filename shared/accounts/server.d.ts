import type { GameId, AccountUser, ResultEvent, PublishResult, AccountStats, ProgressSnapshot, ProgressResult } from "./types.d.ts";
export declare function getAccount(request: Request, app: GameId): Promise<AccountUser | null>;
export declare function publishResult(request: Request, app: GameId, event: ResultEvent): Promise<PublishResult>;
export declare function publishResults(request: Request, app: GameId, events: ResultEvent[]): Promise<{ saved: boolean }>;
export declare function getStats(request: Request, app: GameId): Promise<AccountStats>;
export declare function loadProgress(request: Request, app: GameId, key: string): Promise<ProgressSnapshot | null>;
export declare function loadAccountProgress(request: Request, app: GameId, key: string): Promise<{ user: AccountUser | null; progress: ProgressSnapshot | null }>;
export declare function saveProgress(request: Request, app: GameId, key: string, value: unknown, revision?: number, event?: ResultEvent): Promise<ProgressResult>;
export declare function makeAccountRoutes(app: GameId, hooks?: { onLogin?: (user: AccountUser, request: Request) => Promise<void> }): { session: (request: Request) => Promise<Response>; login: (request: Request) => Promise<Response>; callback: (request: Request) => Promise<Response>; logout: (request: Request) => Promise<Response>; stats: (request: Request) => Promise<Response>; avatar: (request: Request) => Promise<Response> };
