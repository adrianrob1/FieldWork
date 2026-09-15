import BetterSqlite3 from 'better-sqlite3';

export interface WorkspaceDatabase {
  readonly file: string;
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): number;
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  all<T>(sql: string, ...params: unknown[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDatabase(
  file: string,
  options: { readonly?: boolean } = {},
): WorkspaceDatabase {
  const native = new BetterSqlite3(file, {
    readonly: options.readonly ?? false,
    fileMustExist: options.readonly ?? false,
  });
  native.pragma('foreign_keys = ON');
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new Error(`Database is closed: ${file}`);
  };
  return {
    file,
    exec(sql) {
      ensureOpen();
      native.exec(sql);
    },
    run(sql, ...params) {
      ensureOpen();
      return native.prepare(sql).run(...params).changes;
    },
    get<T>(sql: string, ...params: unknown[]): T | undefined {
      ensureOpen();
      return native.prepare(sql).get(...params) as T | undefined;
    },
    all<T>(sql: string, ...params: unknown[]): T[] {
      ensureOpen();
      return native.prepare(sql).all(...params) as T[];
    },
    transaction<T>(fn: () => T): T {
      ensureOpen();
      const wrapped = native.transaction(fn) as () => T;
      return wrapped();
    },
    close() {
      if (closed) return;
      closed = true;
      native.close();
    },
  };
}
