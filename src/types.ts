// Environment variables interface
export interface AppEnv {
  TG_APP_ID: number;
  TG_APP_HASH: string;
  TG_SESSION: string;
  TG_GROUP_ID: string | number;
  CHUNK_SIZE: number;
  TG_BOT_TOKEN?: string;
  VPS_URL?: string;
  DB_PATH?: string;
  DATABASE_PATH?: string;
  TEMP_DIR: string;
  CACHE_DIR: string;
  PORT: number;
  S3_ADMIN_KEY?: string;
  S3_ADMIN_SECRET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  HOT_CACHE_DAILY_THRESHOLD?: number;
  CACHE_RETENTION_DAYS?: number;
  LEAVE_IN_CACHE?: boolean;
}

export type Env = AppEnv;

export interface TgFileResponse {
  ok: boolean;
  result?: {
    file_id: string;
    file_unique_id: string;
    file_size?: number;
    file_path?: string;
  };
}

export interface TgMessageResponse {
  ok: boolean;
  result?: {
    message_id: number;
    document?: {
      file_id: string;
      file_unique_id: string;
      file_size?: number;
    };
  };
}

export interface TgForumTopicResponse {
  ok: boolean;
  result?: {
    message_thread_id: number;
    name: string;
  };
}

// Database Row Types (SQLite)
export interface BucketRow {
  name: string;
  created_at: string;
  tg_chat_id: string;
  tg_topic_id: number | null;
  description: string | null;
  object_count: number;
  total_size: number;
  is_public: number;
  optimize_config: string | null;
  default_encryption: number;
}

export interface ObjectRow {
  bucket: string;
  key: string;
  size: number;
  etag: string;
  content_type: string;
  last_modified: string;
  storage_class: string;
  tg_chat_id: string;
  tg_message_id: number;
  tg_file_id: string;
  tg_file_unique_id: string;
  user_metadata: string | null;
  system_metadata: string | null;
  derived_from: string | null;
  download_count: number;
  last_accessed: string | null;
  is_permanent_cache: number;
}

export interface CasChunkRow {
  hash: string;
  tg_message_id: number;
  tg_file_id: string;
  size: number;
  ref_count: number;
  created_at: string;
}

export interface ObjectChunkRow {
  bucket: string;
  key: string;
  chunk_index: number;
  cas_hash: string;
  size: number;
  offset_bytes: number;
}

export interface MultipartUploadRow {
  upload_id: string;
  bucket: string;
  key: string;
  created_at: string;
  content_type: string | null;
  user_metadata: string | null;
  system_metadata: string | null;
}

export interface MultipartPartRow {
  upload_id: string;
  part_number: number;
  size: number;
  etag: string;
  cas_hash: string;
  created_at: string;
}

export type BucketRecord = BucketRow;
export type ObjectRecord = ObjectRow;
export type MultipartPartRecord = MultipartPartRow;
export type MultipartUploadRecord = MultipartUploadRow;

export interface ShareTokenRow {
  token: string;
  bucket: string;
  key: string;
  created_at: string;
  expires_at: string | null;
  password_hash: string | null;
  max_downloads: number | null;
  download_count: number;
  creator: string | null;
  note: string | null;
}

export interface CredentialRow {
  access_key_id: string;
  secret_access_key: string;
  name: string;
  buckets: string;
  permission: string;
  created_at: string;
  last_used_at: string | null;
  is_active: number;
}

// Auth context and failure
export interface AuthContext {
  accessKeyId: string;
  permission: 'admin' | 'readwrite' | 'readonly';
  buckets: string[];
}

export interface AuthFailure {
  code: string;
  message: string;
  status: number;
}

export interface S3Request {
  method: string;
  bucket: string;
  key: string;
  query: URLSearchParams;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  url: URL;
}

export type S3Operation =
  | 'ListBuckets'
  | 'CreateBucket'
  | 'DeleteBucket'
  | 'HeadBucket'
  | 'GetBucketLocation'
  | 'GetBucketVersioning'
  | 'ListObjectsV2'
  | 'ListObjects'
  | 'GetObject'
  | 'PutObject'
  | 'HeadObject'
  | 'DeleteObject'
  | 'CopyObject'
  | 'DeleteObjects'
  | 'CreateMultipartUpload'
  | 'UploadPart'
  | 'UploadPartCopy'
  | 'CompleteMultipartUpload'
  | 'AbortMultipartUpload'
  | 'ListParts'
  | 'ListMultipartUploads'
  | 'GetObjectTagging'
  | 'PutObjectTagging'
  | 'DeleteObjectTagging'
  | 'GetBucketLifecycleConfiguration'
  | 'PutBucketLifecycleConfiguration'
  | 'DeleteBucketLifecycleConfiguration';


// Share types
export interface ShareOptions {
  bucket: string;
  key: string;
  expiresIn?: number;
  password?: string;
  maxDownloads?: number;
  note?: string;
}
