// TG-S3 SQLite Metadata Schema
// Embedded (not loaded from disk) so fresh databases initialize correctly
// no matter where the process runs from (src or dist/without-src deployments).

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size = -64000;
PRAGMA temp_store = MEMORY;

-- 1. Buckets Table
CREATE TABLE IF NOT EXISTS buckets (
    name                TEXT PRIMARY KEY,
    created_at          TEXT NOT NULL DEFAULT (DATETIME('now')),
    is_public           INTEGER NOT NULL DEFAULT 0,          -- 0 = private, 1 = public
    default_encryption  INTEGER NOT NULL DEFAULT 0          -- 0 = disabled, 1 = auto-encrypt
);

-- 2. CAS Chunks Table (Content-Addressable Storage Index)
CREATE TABLE IF NOT EXISTS cas_chunks (
    sha256              TEXT PRIMARY KEY,                   -- SHA-256 hash of chunk data
    size                INTEGER NOT NULL,                   -- Chunk size in bytes
    tg_file_id          TEXT,                               -- Telegram document File ID handle
    tg_msg_id           INTEGER,                            -- Telegram message ID
    ref_count           INTEGER NOT NULL DEFAULT 0,         -- Reference count of objects using this chunk
    created_at          TEXT NOT NULL DEFAULT (DATETIME('now'))
);

-- 3. Objects Table (S3 Object Metadata)
CREATE TABLE IF NOT EXISTS objects (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket              TEXT NOT NULL,
    key                 TEXT NOT NULL,
    size                INTEGER NOT NULL,
    etag                TEXT NOT NULL,
    content_type        TEXT NOT NULL DEFAULT 'application/octet-stream',
    custom_metadata     TEXT,                               -- JSON stringified custom user metadata
    system_metadata     TEXT,                               -- JSON stringified system properties (SSE flags)
    sha256_hash         TEXT,
    storage_class       TEXT NOT NULL DEFAULT 'STANDARD',
    last_modified       TEXT NOT NULL DEFAULT (DATETIME('now')),
    access_count        INTEGER NOT NULL DEFAULT 0,
    last_accessed       TEXT,
    is_permanent_cache  INTEGER NOT NULL DEFAULT 0,         -- 1 = permanently cache chunks
    UNIQUE (bucket, key),
    FOREIGN KEY (bucket) REFERENCES buckets(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_objects_bucket_key ON objects (bucket, key);
CREATE INDEX IF NOT EXISTS idx_objects_modified ON objects (bucket, last_modified);

-- 4. Object Chunks Table (Mapping Objects -> CAS Chunks)
CREATE TABLE IF NOT EXISTS object_chunks (
    object_id           INTEGER NOT NULL,                   -- FK to objects.id
    chunk_index         INTEGER NOT NULL,                   -- 0-based chunk sequence index
    cas_sha256          TEXT NOT NULL,                      -- FK to cas_chunks.sha256
    size                INTEGER NOT NULL,                   -- Chunk byte length
    PRIMARY KEY (object_id, chunk_index),
    FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE CASCADE,
    FOREIGN KEY (cas_sha256) REFERENCES cas_chunks(sha256) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_object_chunks_cas ON object_chunks (cas_sha256);

-- 5. Multipart Uploads Table
CREATE TABLE IF NOT EXISTS multipart_uploads (
    upload_id           TEXT PRIMARY KEY,
    bucket              TEXT NOT NULL,
    key                 TEXT NOT NULL,
    content_type        TEXT,
    created_at          TEXT NOT NULL DEFAULT (DATETIME('now')),
    FOREIGN KEY (bucket) REFERENCES buckets(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_multipart_bucket_key ON multipart_uploads (bucket, key);

-- 6. Multipart Parts Table
CREATE TABLE IF NOT EXISTS multipart_parts (
    upload_id           TEXT NOT NULL,
    part_number         INTEGER NOT NULL,
    etag                TEXT NOT NULL,
    size                INTEGER NOT NULL,
    cas_sha256          TEXT NOT NULL,                      -- Uploaded part stored as CAS chunk
    created_at          TEXT NOT NULL DEFAULT (DATETIME('now')),
    PRIMARY KEY (upload_id, part_number),
    FOREIGN KEY (upload_id) REFERENCES multipart_uploads(upload_id) ON DELETE CASCADE
);

-- 7. Share Tokens Table
CREATE TABLE IF NOT EXISTS share_tokens (
    token               TEXT PRIMARY KEY,
    bucket              TEXT NOT NULL,
    key                 TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (DATETIME('now')),
    expires_at          TEXT,
    password_hash       TEXT,
    max_downloads       INTEGER,
    download_count      INTEGER NOT NULL DEFAULT 0,
    creator             TEXT,
    note                TEXT,
    FOREIGN KEY (bucket, key) REFERENCES objects(bucket, key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_share_tokens_object ON share_tokens (bucket, key);

-- 8. Credentials Table
CREATE TABLE IF NOT EXISTS credentials (
    access_key_id       TEXT PRIMARY KEY,
    secret_access_key   TEXT NOT NULL,
    name                TEXT NOT NULL DEFAULT '',
    buckets             TEXT NOT NULL DEFAULT '*',
    permission          TEXT NOT NULL DEFAULT 'admin',
    created_at          TEXT NOT NULL DEFAULT (DATETIME('now')),
    last_used_at        TEXT,
    is_active           INTEGER NOT NULL DEFAULT 1
);

-- 9. Share Password Attempts Table
CREATE TABLE IF NOT EXISTS share_password_attempts (
    token               TEXT NOT NULL,
    ip                  TEXT NOT NULL,
    attempts            INTEGER NOT NULL DEFAULT 0,
    last_attempt        TEXT NOT NULL,
    locked_until        TEXT,
    PRIMARY KEY (token, ip)
);
`;
