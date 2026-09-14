import { getDb } from './db.js';
import crypto from 'node:crypto';
import type { ShareTokenRow } from '../types.js';

export interface BucketRecord {
  name: string;
  created_at: string;
  is_public: number;
  default_encryption: string | null;
  optimize_config: string | null;
}

export interface ObjectRecord {
  id: string;
  bucket: string;
  key: string;
  size: number;
  etag: string;
  content_type: string;
  last_modified: string;
  storage_class: string;
  custom_metadata: string | null;
  sha256_hash: string | null;
  access_count: number;
  last_accessed: string | null;
  is_permanent_cache: number;
}

export interface ObjectChunkRecord {
  object_id: string;
  chunk_index: number;
  cas_sha256: string;
  size: number;
}

export interface CasChunkRecord {
  sha256: string;
  size: number;
  tg_file_id: string | null;
  tg_msg_id: number | null;
  ref_count: number;
  created_at: string;
}

export interface MultipartUploadRecord {
  upload_id: string;
  bucket: string;
  key: string;
  content_type: string;
  created_at: string;
}

export interface MultipartPartRecord {
  upload_id: string;
  part_number: number;
  etag: string;
  size: number;
  cas_sha256: string;
  created_at: string;
}

export class MetadataStore {
  // Buckets
  static getBucket(name: string): BucketRecord | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM buckets WHERE name = ?').get(name) as BucketRecord | undefined;
  }

  static listBuckets(): BucketRecord[] {
    const db = getDb();
    return db.prepare('SELECT * FROM buckets ORDER BY created_at ASC').all() as BucketRecord[];
  }

  static createBucket(name: string, isPublic = 0, defaultEncryption: string | null = null): boolean {
    const db = getDb();
    try {
      db.prepare('INSERT INTO buckets (name, is_public, default_encryption) VALUES (?, ?, ?)').run(
        name,
        isPublic,
        defaultEncryption
      );
      return true;
    } catch {
      return false;
    }
  }

  static deleteBucket(name: string): boolean {
    const db = getDb();
    const count = db.prepare('SELECT count(*) as cnt FROM objects WHERE bucket = ?').get(name) as { cnt: number };
    if (count.cnt > 0) return false;

    const res = db.prepare('DELETE FROM buckets WHERE name = ?').run(name);
    return res.changes > 0;
  }

  // Objects
  static getObject(bucket: string, key: string): ObjectRecord | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM objects WHERE bucket = ? AND key = ?').get(bucket, key) as ObjectRecord | undefined;
  }

  static getObjectById(id: string): ObjectRecord | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM objects WHERE id = ?').get(id) as ObjectRecord | undefined;
  }

  static recordObjectAccess(id: string): void {
    const db = getDb();
    db.prepare(`
      UPDATE objects 
      SET access_count = access_count + 1, last_accessed = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(id);
  }

  static setPermanentCache(bucket: string, key: string, isPermanent: boolean): boolean {
    const db = getDb();
    const res = db.prepare('UPDATE objects SET is_permanent_cache = ? WHERE bucket = ? AND key = ?').run(
      isPermanent ? 1 : 0,
      bucket,
      key
    );
    return res.changes > 0;
  }

  static listObjects(
    bucket: string,
    prefix = '',
    delimiter = '',
    maxKeys = 1000,
    marker = ''
  ): {
    objects: ObjectRecord[];
    commonPrefixes: string[];
    isTruncated: boolean;
    nextMarker?: string;
  } {
    const db = getDb();
    let query = 'SELECT * FROM objects WHERE bucket = ?';
    const params: any[] = [bucket];

    if (prefix) {
      query += ' AND key LIKE ?';
      params.push(`${prefix}%`);
    }

    if (marker) {
      query += ' AND key > ?';
      params.push(marker);
    }

    query += ' ORDER BY key ASC';

    const allObjects = db.prepare(query).all(...params) as ObjectRecord[];

    const objects: ObjectRecord[] = [];
    const commonPrefixesSet = new Set<string>();

    for (const obj of allObjects) {
      if (objects.length >= maxKeys) {
        break;
      }

      if (delimiter) {
        const relativeKey = prefix ? obj.key.slice(prefix.length) : obj.key;
        const delimIdx = relativeKey.indexOf(delimiter);

        if (delimIdx !== -1) {
          const prefixGroup = prefix + relativeKey.slice(0, delimIdx + delimiter.length);
          commonPrefixesSet.add(prefixGroup);
          continue;
        }
      }

      objects.push(obj);
    }

    const commonPrefixes = Array.from(commonPrefixesSet).sort();
    const isTruncated = allObjects.length > objects.length + commonPrefixesSet.size;
    const lastObj = objects[objects.length - 1];
    const nextMarker = isTruncated && lastObj ? lastObj.key : undefined;

    return {
      objects,
      commonPrefixes,
      isTruncated,
      nextMarker,
    };
  }

  static getObjectCasHashes(bucket: string, key: string): string[] {
    const db = getDb();
    const obj = this.getObject(bucket, key);
    if (!obj) return [];
    const rows = db.prepare(
      'SELECT cas_sha256 FROM object_chunks WHERE object_id = ? ORDER BY chunk_index ASC'
    ).all(obj.id) as { cas_sha256: string }[];
    return rows.map(r => r.cas_sha256);
  }

  static getObjectChunks(bucket: string, key: string): { casSha256: string; size: number }[];
  static getObjectChunks(objectId: string): ObjectChunkRecord[];
  static getObjectChunks(arg1: string, arg2?: string): any {
    const db = getDb();
    if (arg2 !== undefined) {
      const obj = this.getObject(arg1, arg2);
      if (!obj) return [];
      return db.prepare(
        'SELECT cas_sha256 as casSha256, size FROM object_chunks WHERE object_id = ? ORDER BY chunk_index ASC'
      ).all(obj.id) as { casSha256: string; size: number }[];
    } else {
      return db
        .prepare('SELECT * FROM object_chunks WHERE object_id = ? ORDER BY chunk_index ASC')
        .all(arg1) as ObjectChunkRecord[];
    }
  }

  static saveObjectWithChunks(
    bucket: string,
    key: string,
    size: number,
    etag: string,
    contentType: string,
    sha256Hash: string | null,
    customMetadata: Record<string, string> | null,
    chunks: Array<{ casSha256: string; size: number }>
  ): ObjectRecord {
    const db = getDb();

    return db.transaction(() => {
      const existing = this.getObject(bucket, key);
      if (existing) {
        this.deleteObject(bucket, key);
      }

      const metadataStr = customMetadata ? JSON.stringify(customMetadata) : null;

      const res = db.prepare(`
        INSERT INTO objects (bucket, key, size, etag, content_type, custom_metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(bucket, key, size, etag, contentType, metadataStr);

      const objectId = res.lastInsertRowid;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        db.prepare(`
          INSERT INTO object_chunks (object_id, chunk_index, cas_sha256, size)
          VALUES (?, ?, ?, ?)
        `).run(objectId, i, chunk.casSha256, chunk.size);

        db.prepare(`
          UPDATE cas_chunks SET ref_count = ref_count + 1 WHERE sha256 = ?
        `).run(chunk.casSha256);
      }

      return this.getObject(bucket, key)!;
    })();
  }

  static deleteObject(bucket: string, key: string): { success: boolean; unreferencedCasHashes: string[] } {
    const db = getDb();

    return db.transaction(() => {
      const obj = this.getObject(bucket, key);
      if (!obj) return { success: false, unreferencedCasHashes: [] };

      const objectChunks = db
        .prepare('SELECT cas_sha256 FROM object_chunks WHERE object_id = ?')
        .all(obj.id) as Array<{ cas_sha256: string }>;

      const unreferencedCasHashes: string[] = [];

      for (const chunk of objectChunks) {
        db.prepare('UPDATE cas_chunks SET ref_count = ref_count - 1 WHERE sha256 = ?').run(chunk.cas_sha256);
        const cas = db.prepare('SELECT ref_count FROM cas_chunks WHERE sha256 = ?').get(chunk.cas_sha256) as
          | { ref_count: number }
          | undefined;

        if (cas && cas.ref_count <= 0) {
          unreferencedCasHashes.push(chunk.cas_sha256);
        }
      }

      db.prepare('DELETE FROM object_chunks WHERE object_id = ?').run(obj.id);
      db.prepare('DELETE FROM objects WHERE id = ?').run(obj.id);

      return { success: true, unreferencedCasHashes };
    })();
  }

  // CAS Chunks
  static getCasChunk(sha256: string): CasChunkRecord | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM cas_chunks WHERE sha256 = ?').get(sha256) as CasChunkRecord | undefined;
  }

  static createCasChunk(sha256: string, size: number, tgFileId: string | null = null, tgMsgId: number | null = null): CasChunkRecord {
    const db = getDb();
    db.prepare(`
      INSERT INTO cas_chunks (sha256, size, tg_file_id, tg_msg_id, ref_count)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(sha256) DO UPDATE SET
        tg_file_id = COALESCE(excluded.tg_file_id, cas_chunks.tg_file_id),
        tg_msg_id = COALESCE(excluded.tg_msg_id, cas_chunks.tg_msg_id)
    `).run(sha256, size, tgFileId, tgMsgId);

    return this.getCasChunk(sha256)!;
  }

  static updateCasChunkTelegramInfo(sha256: string, tgFileId: string, tgMsgId: number): void {
    const db = getDb();
    db.prepare('UPDATE cas_chunks SET tg_file_id = ?, tg_msg_id = ? WHERE sha256 = ?').run(tgFileId, tgMsgId, sha256);
  }

  static deleteCasChunk(sha256: string): boolean {
    const db = getDb();
    const res = db.prepare('DELETE FROM cas_chunks WHERE sha256 = ? AND ref_count <= 0').run(sha256);
    return res.changes > 0;
  }

  // Multipart Uploads
  static createMultipartUpload(uploadId: string, bucket: string, key: string, contentType: string): MultipartUploadRecord {
    const db = getDb();
    db.prepare(`
      INSERT INTO multipart_uploads (upload_id, bucket, key, content_type)
      VALUES (?, ?, ?, ?)
    `).run(uploadId, bucket, key, contentType);

    return db.prepare('SELECT * FROM multipart_uploads WHERE upload_id = ?').get(uploadId) as MultipartUploadRecord;
  }

  static getMultipartUpload(uploadId: string): MultipartUploadRecord | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM multipart_uploads WHERE upload_id = ?').get(uploadId) as MultipartUploadRecord | undefined;
  }

  static recordMultipartPart(uploadId: string, partNumber: number, etag: string, size: number, casSha256: string): void {
    const db = getDb();
    db.prepare(`
      INSERT INTO multipart_parts (upload_id, part_number, etag, size, cas_sha256)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(upload_id, part_number) DO UPDATE SET
        etag = excluded.etag,
        size = excluded.size,
        cas_sha256 = excluded.cas_sha256
    `).run(uploadId, partNumber, etag, size, casSha256);
  }

  static putMultipartPart(param: { uploadId: string; partNumber: number; etag: string; size: number; casSha256: string }): void {
    this.recordMultipartPart(param.uploadId, param.partNumber, param.etag, param.size, param.casSha256);
  }

  static listMultipartParts(uploadId: string): MultipartPartRecord[] {
    const db = getDb();
    return db
      .prepare('SELECT * FROM multipart_parts WHERE upload_id = ? ORDER BY part_number ASC')
      .all(uploadId) as MultipartPartRecord[];
  }

  static listParts(uploadId: string): MultipartPartRecord[] {
    return this.listMultipartParts(uploadId);
  }

  static listMultipartUploads(bucket: string, prefix = '', delimiter = '', maxUploads = 1000, keyMarker = '', uploadIdMarker = ''): {
    uploads: MultipartUploadRecord[];
    commonPrefixes: string[];
    isTruncated: boolean;
    nextKeyMarker?: string;
    nextUploadIdMarker?: string;
  } {
    const db = getDb();
    let query = 'SELECT * FROM multipart_uploads WHERE bucket = ?';
    const params: any[] = [bucket];

    if (prefix) {
      query += ' AND key LIKE ?';
      params.push(`${prefix}%`);
    }
    if (keyMarker) {
      query += ' AND (key > ? OR (key = ? AND upload_id > ?))';
      params.push(keyMarker, keyMarker, uploadIdMarker);
    }
    query += ' ORDER BY key ASC, upload_id ASC';

    const allUploads = db.prepare(query).all(...params) as MultipartUploadRecord[];
    const uploads: MultipartUploadRecord[] = [];
    const commonPrefixesSet = new Set<string>();

    for (const up of allUploads) {
      if (uploads.length >= maxUploads) break;
      if (delimiter) {
        const relativeKey = prefix ? up.key.slice(prefix.length) : up.key;
        const delimIdx = relativeKey.indexOf(delimiter);
        if (delimIdx !== -1) {
          commonPrefixesSet.add(prefix + relativeKey.slice(0, delimIdx + delimiter.length));
          continue;
        }
      }
      uploads.push(up);
    }

    const isTruncated = allUploads.length > uploads.length + commonPrefixesSet.size;
    const lastItem = uploads[uploads.length - 1];

    return {
      uploads,
      commonPrefixes: Array.from(commonPrefixesSet).sort(),
      isTruncated,
      nextKeyMarker: isTruncated && lastItem ? lastItem.key : undefined,
      nextUploadIdMarker: isTruncated && lastItem ? lastItem.upload_id : undefined,
    };
  }

  static completeMultipartUpload(
    uploadId: string,
    bucket: string,
    key: string,
    parts: Array<{ partNumber: number; etag: string }>
  ): ObjectRecord {
    const db = getDb();
    const mpUpload = this.getMultipartUpload(uploadId);
    if (!mpUpload) {
      throw new Error('NoSuchUpload');
    }

    const recordedParts = this.listMultipartParts(uploadId);
    const partMap = new Map(recordedParts.map(p => [p.part_number, p]));

    let totalSize = 0;
    const chunksToSave: Array<{ casSha256: string; size: number }> = [];

    for (const part of parts) {
      const rec = partMap.get(part.partNumber);
      if (!rec) {
        throw new Error(`InvalidPart: Part ${part.partNumber} missing`);
      }
      totalSize += rec.size;
      if (rec.cas_sha256 && rec.cas_sha256.startsWith('[')) {
        try {
          const parsed = JSON.parse(rec.cas_sha256);
          for (const item of parsed) {
            chunksToSave.push({ casSha256: item.casSha256 || item.sha256, size: item.size });
          }
        } catch {
          chunksToSave.push({ casSha256: rec.cas_sha256, size: rec.size });
        }
      } else {
        chunksToSave.push({ casSha256: rec.cas_sha256, size: rec.size });
      }
    }

    const combinedEtags = parts.map(p => p.etag.replace(/"/g, '')).join('');
    const etag = `"${crypto.createHash('md5').update(combinedEtags).digest('hex')}-${parts.length}"`;

    const objectRecord = this.saveObjectWithChunks(
      bucket,
      key,
      totalSize,
      etag,
      mpUpload.content_type || 'application/octet-stream',
      null,
      null,
      chunksToSave
    );

    this.deleteMultipartUpload(uploadId);
    return objectRecord;
  }

  static deleteMultipartUpload(uploadId: string): void {
    const db = getDb();
    db.transaction(() => {
      db.prepare('DELETE FROM multipart_parts WHERE upload_id = ?').run(uploadId);
      db.prepare('DELETE FROM multipart_uploads WHERE upload_id = ?').run(uploadId);
    })();
  }

  static abortMultipartUpload(uploadId: string): void {
    this.deleteMultipartUpload(uploadId);
  }

  // Credentials
  static getCredential(accessKey: string): { access_key_id: string; secret_access_key: string; permission: string; buckets: string; is_active: number } | undefined {
    const db = getDb();
    const row = db.prepare('SELECT access_key_id, secret_access_key, permission, buckets, is_active FROM credentials WHERE access_key_id = ? AND is_active = 1').get(accessKey) as any;
    return row;
  }

  static getCredentialByAccessKey(accessKey: string): { access_key_id: string; secret_access_key: string; permission: string; buckets: string; is_active: number } | undefined {
    return this.getCredential(accessKey);
  }

  static getCredentialByAccessKeyUnsafe(accessKey: string): { access_key_id: string; secret_access_key: string; permission: string; buckets: string; is_active: number } | undefined {
    const db = getDb();
    const row = db.prepare('SELECT access_key_id, secret_access_key, permission, buckets, is_active FROM credentials WHERE access_key_id = ?').get(accessKey) as any;
    return row;
  }

  static countCredentials(): number {
    const db = getDb();
    const res = db.prepare('SELECT COUNT(*) as count FROM credentials').get() as { count: number };
    return res.count;
  }

  static listCredentials(): { access_key_id: string; secret_access_key: string; permission: string; buckets: string; is_active: number }[] {
    const db = getDb();
    const rows = db.prepare('SELECT access_key_id, secret_access_key, permission, buckets, is_active FROM credentials').all() as any[];
    return rows;
  }

  static createCredential(accessKeyOrObj: string | { access_key_id?: string; access_key?: string; secret_access_key?: string; secret_key?: string }, secretKeyParam?: string): void {
    let accessKey: string;
    let secretKey: string;
    if (typeof accessKeyOrObj === 'object') {
      accessKey = accessKeyOrObj.access_key_id || accessKeyOrObj.access_key || '';
      secretKey = accessKeyOrObj.secret_access_key || accessKeyOrObj.secret_key || '';
    } else {
      accessKey = accessKeyOrObj;
      secretKey = secretKeyParam || '';
    }

    const db = getDb();
    db.prepare(`
      INSERT INTO credentials (access_key_id, secret_access_key, is_active)
      VALUES (?, ?, 1)
      ON CONFLICT(access_key_id) DO UPDATE SET secret_access_key = excluded.secret_access_key, is_active = 1
    `).run(accessKey, secretKey);
  }

  static updateCredential(accessKey: string, updates: { secret_key?: string; secret_access_key?: string; enabled?: number; is_active?: number }): boolean {
    const db = getDb();
    const sk = updates.secret_access_key ?? updates.secret_key;
    const en = updates.is_active ?? updates.enabled;
    if (sk !== undefined) {
      db.prepare('UPDATE credentials SET secret_access_key = ? WHERE access_key_id = ?').run(sk, accessKey);
    }
    if (en !== undefined) {
      db.prepare('UPDATE credentials SET is_active = ? WHERE access_key_id = ?').run(en, accessKey);
    }
    return true;
  }

  static updateCredentialSecret(accessKey: string, newSecret: string): void {
    this.updateCredential(accessKey, { secret_access_key: newSecret });
  }

  static bootstrapCredentials(adminKey?: string, adminSecret?: string): void {
    if (!adminKey || !adminSecret) return;
    if (this.countCredentials() === 0) {
      this.createCredential(adminKey, adminSecret);
    }
  }

  static deleteCredential(accessKey: string): void {
    const db = getDb();
    db.prepare('DELETE FROM credentials WHERE access_key_id = ?').run(accessKey);
  }

  // Share Tokens
  static createShareToken(
    tokenOrRow: string | ShareTokenRow,
    bucket?: string,
    key?: string,
    expiresAt?: string | null,
    passwordHash?: string | null,
    maxDownloads?: number | null,
    creator?: string | null,
    note?: string | null
  ): void {
    const db = getDb();
    if (typeof tokenOrRow === 'object') {
      db.prepare(`
        INSERT INTO share_tokens (token, bucket, key, created_at, expires_at, password_hash, max_downloads, download_count, creator, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tokenOrRow.token,
        tokenOrRow.bucket,
        tokenOrRow.key,
        tokenOrRow.created_at || new Date().toISOString(),
        tokenOrRow.expires_at,
        tokenOrRow.password_hash,
        tokenOrRow.max_downloads,
        tokenOrRow.download_count || 0,
        tokenOrRow.creator,
        tokenOrRow.note
      );
    } else {
      db.prepare(`
        INSERT INTO share_tokens (token, bucket, key, created_at, expires_at, password_hash, max_downloads, download_count, creator, note)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, 0, ?, ?)
      `).run(tokenOrRow, bucket, key, expiresAt, passwordHash, maxDownloads, creator, note);
    }
  }

  static getShareToken(token: string): any {
    const db = getDb();
    return db.prepare('SELECT * FROM share_tokens WHERE token = ?').get(token);
  }

  static listShareTokens(bucket?: string, key?: string, limit = 200): any[] {
    const db = getDb();
    let query = 'SELECT * FROM share_tokens';
    const params: any[] = [];
    if (bucket && key) {
      query += ' WHERE bucket = ? AND key = ?';
      params.push(bucket, key);
    } else if (bucket) {
      query += ' WHERE bucket = ?';
      params.push(bucket);
    }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return db.prepare(query).all(...params);
  }

  static deleteShareToken(token: string): boolean {
    const db = getDb();
    const res = db.prepare('DELETE FROM share_tokens WHERE token = ?').run(token);
    return res.changes > 0;
  }

  static deleteExpiredShareTokens(): number {
    const db = getDb();
    const res = db.prepare("DELETE FROM share_tokens WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run();
    return res.changes;
  }

  static incrementShareDownload(token: string): boolean {
    const db = getDb();
    const res = db.prepare(
      `UPDATE share_tokens SET download_count = download_count + 1
       WHERE token = ? AND (max_downloads IS NULL OR download_count < max_downloads)`
    ).run(token);
    return res.changes > 0;
  }

  static decrementShareDownload(token: string): void {
    const db = getDb();
    db.prepare(
      `UPDATE share_tokens SET download_count = MAX(download_count - 1, 0) WHERE token = ?`
    ).run(token);
  }

  // Password Lock Protection
  static checkPasswordLock(token: string, ip: string): number {
    const db = getDb();
    const row = db.prepare(
      'SELECT locked_until FROM share_password_attempts WHERE token = ? AND ip = ?'
    ).get(token, ip) as { locked_until: string | null } | undefined;
    if (!row?.locked_until) return 0;
    const remaining = (new Date(row.locked_until).getTime() - Date.now()) / 1000;
    return remaining > 0 ? Math.ceil(remaining) : 0;
  }

  static recordPasswordFailure(token: string, ip: string, maxAttempts = 5, lockoutMinutes = 15): number {
    const db = getDb();
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const now = new Date(nowMs).toISOString();
    const lockUntil = new Date(nowMs + lockoutMinutes * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO share_password_attempts (token, ip, attempts, last_attempt, locked_until)
      VALUES (?, ?, 1, ?, NULL)
      ON CONFLICT(token, ip) DO UPDATE SET
        attempts = share_password_attempts.attempts + 1,
        last_attempt = excluded.last_attempt,
        locked_until = CASE
          WHEN share_password_attempts.attempts + 1 >= ? THEN ?
          ELSE share_password_attempts.locked_until
        END
    `).run(token, ip, now, maxAttempts, lockUntil);

    const row = db.prepare(
      'SELECT attempts FROM share_password_attempts WHERE token = ? AND ip = ?'
    ).get(token, ip) as { attempts: number } | undefined;

    return row?.attempts ?? 1;
  }

  static clearPasswordAttempts(token: string, ip: string): void {
    const db = getDb();
    db.prepare('DELETE FROM share_password_attempts WHERE token = ? AND ip = ?').run(token, ip);
  }

  static incrementShareDownloads(token: string): boolean {
    return this.incrementShareDownload(token);
  }

  static updateShareToken(token: string, updates: Record<string, any>): boolean {
    const db = getDb();
    const fields: string[] = [];
    const params: any[] = [];
    if ('expires_at' in updates) { fields.push('expires_at = ?'); params.push(updates.expires_at); }
    if ('password_hash' in updates) { fields.push('password_hash = ?'); params.push(updates.password_hash); }
    if ('max_downloads' in updates) { fields.push('max_downloads = ?'); params.push(updates.max_downloads); }
    if ('note' in updates) { fields.push('note = ?'); params.push(updates.note); }

    if (fields.length === 0) return true;
    params.push(token);
    const res = db.prepare(`UPDATE share_tokens SET ${fields.join(', ')} WHERE token = ?`).run(...params);
    return res.changes > 0;
  }

  static deleteShareTokensByBucket(bucket: string): boolean {
    const db = getDb();
    const res = db.prepare('DELETE FROM share_tokens WHERE bucket = ?').run(bucket);
    return res.changes > 0;
  }

  static getOldIncompleteMultipartUploads(olderThanHours: number): Array<{ upload_id: string; bucket: string; key: string; created_at: string }> {
    const db = getDb();
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString();
    return db.prepare('SELECT upload_id, bucket, key, created_at FROM multipart_uploads WHERE created_at < ?').all(cutoff) as any[];
  }
}

export const store = MetadataStore;
