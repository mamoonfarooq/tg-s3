-- TG-S3 SQLite Metadata Schema

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size = -64000;
PRAGMA temp_store = MEMORY;

-- 1. Buckets Table
CREATE TABLE IF NOT EXISTS buckets (
    name                TEXT PRIMARY KEY,
    created_at          TEXT NOT NULL DEFAULT (DATETIME('now')),
    description         TEXT,
    object_count        INTEGER NOT NULL DEFAULT 0,
    total_size          INTEGER NOT NULL DEFAULT 0,
    is_public           INTEGER NOT NULL DEFAULT 0,          -- 0 = private, 1 = public
    default_encryption  INTEGER NOT NULL DEFAULT 0,          -- 0 = disabled, 1 = auto-encrypt
    is_permanent_cache  INTEGER NOT NULL DEFAULT 0           -- 1 = keep all objects in local cache
);

-- 2. CAS Chunks Table (Content-Addressable Storage Index)
CREATE TABLE IF NOT EXISTS cas_chunks (
    cas_id              TEXT PRIMARY KEY,               -- SHA-256 Hash of chunk data
    size                INTEGER NOT NULL,               -- Chunk size in bytes
    tg_chat_id          TEXT NOT NULL,                  -- Telegram Target Channel/Group ID
    tg_message_id       INTEGER NOT NULL,              -- Telegram Message ID
    tg_file_id          TEXT NOT NULL,                  -- Telegram File ID handle
    ref_count           INTEGER NOT NULL DEFAULT 1,     -- Reference count of objects using this chunk
    is_cached           INTEGER NOT NULL DEFAULT 0,     -- 1 = binary exists in local cache
    cached_at           TEXT,                           -- Timestamp when written to local cache
    last_accessed_at    TEXT,                           -- Timestamp of most recent download request
    access_count_today  INTEGER NOT NULL DEFAULT 0,     -- Total requests for this chunk in last 24h
    is_permanent_cache  INTEGER NOT NULL DEFAULT 0,     -- 1 = marked for permanent local retention
    created_at          TEXT NOT NULL DEFAULT (DATETIME('now'))
);

-- 3. Objects Table (S3 Object Metadata)
CREATE TABLE IF NOT EXISTS objects (
    bucket              TEXT NOT NULL,
    key                 TEXT NOT NULL,
    size                INTEGER NOT NULL,
    etag                TEXT NOT NULL,
    content_type        TEXT NOT NULL DEFAULT 'application/octet-stream',
    last_modified       TEXT NOT NULL DEFAULT (DATETIME('now')),
    storage_class       TEXT NOT NULL DEFAULT 'STANDARD',
    is_cas              INTEGER NOT NULL DEFAULT 1,     -- 1 = CAS Chunked
    user_metadata       TEXT,                           -- JSON stringified custom user metadata
    system_metadata     TEXT,                           -- JSON stringified system properties
    derived_from        TEXT,
    is_permanent_cache  INTEGER NOT NULL DEFAULT 0,     -- 1 = permanently cache chunks
    access_count_today  INTEGER NOT NULL DEFAULT 0,     -- Requests counter within 24h window
    last_accessed_at    TEXT,                           -- Timestamp of last HTTP download access
    PRIMARY KEY (bucket, key),
    FOREIGN KEY (bucket) REFERENCES buckets(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_objects_bucket_key ON objects (bucket, key);
CREATE INDEX IF NOT EXISTS idx_objects_modified ON objects (bucket, last_modified);

-- 4. Object Chunks Table (Mapping Objects -> CAS Chunks)
CREATE TABLE IF NOT EXISTS object_chunks (
    bucket              TEXT NOT NULL,
    key                 TEXT NOT NULL,
    chunk_index         INTEGER NOT NULL,               -- 0-based chunk sequence index
    offset              INTEGER NOT NULL,                -- Byte start offset in original file
    size                INTEGER NOT NULL,                -- Chunk byte length
    cas_id              TEXT NOT NULL,                   -- Foreign key to cas_chunks table
    PRIMARY KEY (bucket, key, chunk_index),
    FOREIGN KEY (bucket, key) REFERENCES objects(bucket, key) ON DELETE CASCADE,
    FOREIGN KEY (cas_id) REFERENCES cas_chunks(cas_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_object_chunks_cas ON object_chunks (cas_id);

-- 5. Multipart Uploads Table
CREATE TABLE IF NOT EXISTS multipart_uploads (
    upload_id           TEXT PRIMARY KEY,
    bucket              TEXT NOT NULL,
    key                 TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (DATETIME('now')),
    content_type        TEXT,
    user_metadata       TEXT,
    system_metadata     TEXT,
    FOREIGN KEY (bucket) REFERENCES buckets(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_multipart_bucket_key ON multipart_uploads (bucket, key);

-- 6. Multipart Parts Table
CREATE TABLE IF NOT EXISTS multipart_parts (
    upload_id           TEXT NOT NULL,
    part_number         INTEGER NOT NULL,
    size                INTEGER NOT NULL,
    etag                TEXT NOT NULL,
    cas_sha256          TEXT NOT NULL,                   -- Uploaded part stored as CAS chunk
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
    locked_until        TEXT,
    last_attempt        TEXT NOT NULL,
    PRIMARY KEY (token, ip)
);

-- S3 Object Tagging: up to 10 key-value pairs per object
CREATE TABLE IF NOT EXISTS object_tags (
    bucket          TEXT    NOT NULL,
    key             TEXT    NOT NULL,
    tag_key         TEXT    NOT NULL,
    tag_value       TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (bucket, key, tag_key),
    FOREIGN KEY (bucket, key) REFERENCES objects (bucket, key) ON DELETE CASCADE
);

-- Lifecycle rules: per-bucket expiration policies
CREATE TABLE IF NOT EXISTS lifecycle_rules (
    id              TEXT    PRIMARY KEY,
    bucket          TEXT    NOT NULL,
    prefix          TEXT    NOT NULL DEFAULT '',
    expiration_days INTEGER NOT NULL,
    tag_key         TEXT,
    tag_value       TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (bucket) REFERENCES buckets (name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_bucket ON lifecycle_rules (bucket);
CREATE INDEX IF NOT EXISTS idx_lifecycle_enabled ON lifecycle_rules (enabled, bucket);

-- [Phase 2 预留] 分块上传/下载实现时需要的 objects 表扩展:
-- ALTER TABLE objects ADD COLUMN is_chunked INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE objects ADD COLUMN chunk_count INTEGER;
