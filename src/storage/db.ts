import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SCHEMA_SQL } from './schema.js';

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = process.env.DATABASE_PATH || './data/tg-s3.db';
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  dbInstance = new Database(dbPath);

  // Apply pragmas
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('synchronous = NORMAL');
  dbInstance.pragma('foreign_keys = ON');
  dbInstance.pragma('cache_size = -64000');
  dbInstance.pragma('temp_store = MEMORY');

  // Initialize schema. Embedded in the build so it works no matter where the
  // process runs from; every statement is IF NOT EXISTS, so existing databases
  // are left untouched.
  dbInstance.exec(SCHEMA_SQL);

  // Fail loudly if initialization did not produce the schema
  const tableCheck = dbInstance.prepare(
    "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='buckets'"
  ).get() as { count: number };
  if (tableCheck.count === 0) {
    throw new Error(
      `Database schema initialization failed for ${dbPath}. ` +
      'The server cannot start without a valid metadata store.'
    );
  }

  // Lightweight column migration for databases created before SSE support
  const objectColumns = (dbInstance.prepare('PRAGMA table_info(objects)').all() as Array<{ name: string }>).map(c => c.name);
  if (!objectColumns.includes('system_metadata')) {
    dbInstance.prepare('ALTER TABLE objects ADD COLUMN system_metadata TEXT').run();
  }

  // Migration: add system_metadata to multipart_uploads (for multipart SSE)
  const multipartColumns = (dbInstance.prepare('PRAGMA table_info(multipart_uploads)').all() as Array<{ name: string }>).map(c => c.name);
  if (!multipartColumns.includes('system_metadata')) {
    dbInstance.prepare('ALTER TABLE multipart_uploads ADD COLUMN system_metadata TEXT').run();
  }

  return dbInstance;
}
