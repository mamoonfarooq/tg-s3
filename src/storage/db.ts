import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

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

  // Auto-init schema if table doesn't exist
  const tableCheck = dbInstance.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='buckets'").get() as { count: number };
  if (tableCheck.count === 0) {
    const schemaPath = path.join(process.cwd(), 'src', 'storage', 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      dbInstance.exec(schemaSql);
    }
  }

  return dbInstance;
}
