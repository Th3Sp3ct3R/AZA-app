/** Minimal typed surface used from better-sqlite3. */
export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get<T = unknown>(...params: unknown[]): T | undefined;
  all<T = unknown>(...params: unknown[]): T[];
}

export interface SqliteDatabase {
  exec(sql: string): this;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface BetterSqlite3DatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  timeout?: number;
}

export interface BetterSqlite3Constructor {
  new (filename: string, options?: BetterSqlite3DatabaseOptions): SqliteDatabase;
}

type DynamicImport = (specifier: string) => Promise<unknown>;
const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;

/**
 * Resolve better-sqlite3 without making its ambient types part of @ares/core's
 * public contract. @ares/core must declare better-sqlite3 as a runtime dependency
 * before this default loader is wired into production.
 */
export async function loadBetterSqlite3(): Promise<BetterSqlite3Constructor> {
  let loaded: unknown;
  try {
    loaded = await dynamicImport("better-sqlite3");
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      "The durable session kernel requires better-sqlite3. Add it to @ares/core dependencies " +
        `or inject a BetterSqlite3Constructor${detail}`,
    );
  }
  const candidate = (loaded as { default?: unknown }).default ?? loaded;
  if (typeof candidate !== "function") {
    throw new TypeError("better-sqlite3 did not export a database constructor");
  }
  return candidate as BetterSqlite3Constructor;
}
