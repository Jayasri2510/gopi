import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
export type DB = InstanceType<typeof DatabaseSync>;
type P = (string | number | bigint | null)[];

export const nowIso = () => new Date().toISOString(); // all timestamps are UTC ISO-8601
export const get = <T = any>(db: DB, sql: string, ...p: P) => db.prepare(sql).get(...p) as T | undefined;
export const all = <T = any>(db: DB, sql: string, ...p: P) => db.prepare(sql).all(...p) as T[];
export const run = (db: DB, sql: string, ...p: P) => db.prepare(sql).run(...p);

/** Runs fn inside BEGIN IMMEDIATE; rolls back on any error. Do not nest. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function openDb(file = ':memory:'): DB {
  if (file !== ':memory:') {
    const dir = path.dirname(file);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

export function migrate(db: DB) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = path.resolve(import.meta.dirname, '../migrations');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
    if (get(db, 'SELECT 1 FROM schema_migrations WHERE name = ?', f)) continue;
    tx(db, () => { db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); run(db, 'INSERT INTO schema_migrations VALUES (?, ?)', f, nowIso()); });
  }
}

export function audit(db: DB, actorId: number | null, action: string, entity: string, entityId: string | number | null, detail?: unknown) {
  run(db, 'INSERT INTO audit_events (actor_id, action, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
    actorId, action, entity, entityId === null ? null : String(entityId), detail ? JSON.stringify(detail) : null, nowIso());
}
