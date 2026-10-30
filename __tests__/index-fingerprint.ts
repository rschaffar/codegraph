import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '../src/db/sqlite-adapter';

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Read all logical contents/schema, not only counts or the checkpointed main file.
 * Keep a fixture writer idle/open when comparing physical WAL bytes; SHM is not
 * an immutable database artifact and is deliberately excluded.
 */
export function indexFingerprint(db: SqliteDatabase, dbPath: string) {
  const logical = db.transaction(() => {
    const schema = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const rows = tables.map(({ name }) => [name, db.prepare(`SELECT * FROM ${quote(name)}`).all()
      .map((row) => JSON.stringify(row, (_, value) => typeof value === 'bigint' ? String(value) : value)).sort()]);
    return hash(JSON.stringify({ schema, rows }));
  })();
  const bytes = (file: string): string | null => {
    try { return hash(fs.readFileSync(file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  return { logical, main: bytes(dbPath), wal: bytes(`${dbPath}-wal`) };
}
