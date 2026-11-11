export type SqlValue = string | number | bigint | Uint8Array | ArrayBuffer | null;
export type Row = Record<string, SqlValue>;
export interface SqlStatement { sql: string; args?: readonly SqlValue[] }
export interface SqlResult { rows: Row[]; rowsAffected: number }
export interface SqlExecutor {
  execute(sql: string, args?: readonly SqlValue[]): Promise<SqlResult>;
  batch(statements: readonly SqlStatement[]): Promise<SqlResult[]>;
}
export interface Database extends SqlExecutor {
  executeMultiple(sql: string): Promise<void>;
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): void;
}
export type DatabaseScope = "encore" | "double-drop" | "music-cache" | "accounts";
export function createDatabase(options: { url: string; authToken?: string }): Database;
export function openLocalDatabase(path: string): Database;
export function databaseFor(scope: DatabaseScope): Database;
