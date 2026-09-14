import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import { MetadataStore } from './metadata.js';
import { CacheManager } from './cache.js';
import { uploadChunkToTelegram, downloadChunkFromTelegram } from '../telegram/mtproto.js';

export interface CasChunkResult {
  casSha256: string;
  size: number;
}

export class CasEngine {
  static getChunkSize(): number {
    return parseInt(process.env.CHUNK_SIZE || '20971520', 10); // Default 20 MB
  }

  /**
   * Process a local file into CAS chunks, deduplicating and uploading new chunks to Telegram.
   */
  static async storeFile(filePath: string): Promise<CasChunkResult[]> {
    const chunkSize = this.getChunkSize();
    const fileStats = fs.statSync(filePath);
    const totalSize = fileStats.size;

    const results: CasChunkResult[] = [];
    const fileHandle = fs.openSync(filePath, 'r');

    try {
      let offset = 0;
      let chunkIndex = 0;

      while (offset < totalSize) {
        const currentChunkSize = Math.min(chunkSize, totalSize - offset);
        const buffer = Buffer.alloc(currentChunkSize);
        fs.readSync(fileHandle, buffer, 0, currentChunkSize, offset);

        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

        // Check if CAS chunk already exists in database with Telegram upload info
        let casRecord = MetadataStore.getCasChunk(sha256);

        if (!casRecord || !casRecord.tg_msg_id) {
          // Write chunk to cache file
          const cachePath = CacheManager.writeCacheChunk(sha256, buffer);

          // Upload chunk to Telegram
          console.log(`Uploading CAS chunk ${chunkIndex} (SHA256: ${sha256.slice(0, 8)}..., Size: ${currentChunkSize} bytes) to Telegram...`);
          const { tgMsgId, tgFileId } = await uploadChunkToTelegram(cachePath, `${sha256}.chunk`);

          // Record or update in SQLite
          casRecord = MetadataStore.createCasChunk(sha256, currentChunkSize, tgFileId, tgMsgId);
        } else {
          console.log(`CAS Deduplication match for chunk ${chunkIndex} (SHA256: ${sha256.slice(0, 8)}...) - skipping Telegram upload.`);
          // Save buffer to cache if not present
          if (!CacheManager.hasCachedChunk(sha256)) {
            CacheManager.writeCacheChunk(sha256, buffer);
          }
        }

        results.push({
          casSha256: sha256,
          size: currentChunkSize,
        });

        offset += currentChunkSize;
        chunkIndex++;
      }
    } finally {
      fs.closeSync(fileHandle);
    }

    return results;
  }

  /**
   * Ensure a chunk is present locally in cache, downloading from Telegram if missing.
   */
  static async ensureChunkInCache(casSha256: string): Promise<string> {
    const cachePath = CacheManager.getCachePath(casSha256);
    if (fs.existsSync(cachePath)) {
      return cachePath;
    }

    const casRecord = MetadataStore.getCasChunk(casSha256);
    if (!casRecord || !casRecord.tg_msg_id) {
      throw new Error(`CAS chunk ${casSha256} metadata or Telegram message ID missing`);
    }

    console.log(`Downloading missing chunk ${casSha256.slice(0, 8)}... from Telegram message ID ${casRecord.tg_msg_id}...`);
    await downloadChunkFromTelegram(casRecord.tg_msg_id, cachePath);
    return cachePath;
  }

  /**
   * Read full object data as a buffer by concatenating its CAS chunks.
   */
  static async readObjectBuffer(bucketOrObjectId: string, key?: string): Promise<Buffer> {
    let objectId = bucketOrObjectId;
    if (key !== undefined) {
      const obj = MetadataStore.getObject(bucketOrObjectId, key);
      if (!obj) throw new Error(`Object ${bucketOrObjectId}/${key} not found`);
      objectId = obj.id;
    }
    const chunks = MetadataStore.getObjectChunks(objectId);
    const bufferParts: Buffer[] = [];

    for (const chunk of chunks) {
      const cachePath = await this.ensureChunkInCache(chunk.cas_sha256);
      const partBuffer = fs.readFileSync(cachePath);
      bufferParts.push(partBuffer);
    }

    return Buffer.concat(bufferParts);
  }

  /**
   * Read stream from CAS chunks with optional range.
   */
  static async readStream(
    casChunksInput: string | any[],
    start?: number,
    end?: number
  ): Promise<Readable> {
    let chunks: { cas_sha256: string; size: number }[] = [];
    if (typeof casChunksInput === 'string') {
      try {
        chunks = JSON.parse(casChunksInput);
      } catch {
        chunks = [];
      }
    } else if (Array.isArray(casChunksInput)) {
      chunks = casChunksInput.map(c => typeof c === 'string' ? { cas_sha256: c, size: 0 } : c);
    }

    const ensureChunk = this.ensureChunkInCache.bind(this);

    let currentPos = 0;
    const reqStart = start ?? 0;
    const reqEnd = end ?? Number.MAX_SAFE_INTEGER;

    const stream = new Readable({
      read() {}
    });

    (async () => {
      try {
        for (const chunk of chunks) {
          const cachePath = await ensureChunk(chunk.cas_sha256);
          const chunkStats = fs.statSync(cachePath);
          const chunkSize = chunkStats.size;

          const chunkStart = currentPos;
          const chunkEnd = currentPos + chunkSize - 1;

          if (chunkEnd >= reqStart && chunkStart <= reqEnd) {
            const readOffset = Math.max(0, reqStart - chunkStart);
            const readLength = Math.min(chunkSize - readOffset, reqEnd - (chunkStart + readOffset) + 1);

            const fileHandle = fs.openSync(cachePath, 'r');
            const buf = Buffer.alloc(readLength);
            fs.readSync(fileHandle, buf, 0, readLength, readOffset);
            fs.closeSync(fileHandle);

            stream.push(buf);
          }

          currentPos += chunkSize;
          if (currentPos > reqEnd) break;
        }
        stream.push(null);
      } catch (err) {
        stream.destroy(err as Error);
      }
    })();

    return stream;
  }
}
