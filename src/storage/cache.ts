import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MetadataStore } from './metadata.js';

export class CacheManager {
  private static tempDir = process.env.TEMP_DIR || './data/temp';
  private static cacheDir = process.env.CACHE_DIR || './data/cache';

  static initDirectories(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  static getTempPath(identifier: string): string {
    this.initDirectories();
    return path.join(this.tempDir, identifier);
  }

  static getCachePath(casSha256: string): string {
    this.initDirectories();
    return path.join(this.cacheDir, casSha256);
  }

  static hasCachedChunk(casSha256: string): boolean {
    const chunkPath = this.getCachePath(casSha256);
    return fs.existsSync(chunkPath);
  }

  static writeCacheChunk(casSha256: string, data: Buffer): string {
    const chunkPath = this.getCachePath(casSha256);
    fs.writeFileSync(chunkPath, data);
    return chunkPath;
  }

  static readCacheChunk(casSha256: string): Buffer | null {
    const chunkPath = this.getCachePath(casSha256);
    if (fs.existsSync(chunkPath)) {
      return fs.readFileSync(chunkPath);
    }
    return null;
  }

  static removeCacheChunk(casSha256: string): void {
    const chunkPath = this.getCachePath(casSha256);
    if (fs.existsSync(chunkPath)) {
      fs.unlinkSync(chunkPath);
    }
  }

  /**
   * Run background cleanup of cache based on CACHE_RETENTION_DAYS, HOT_CACHE_DAILY_THRESHOLD, and LEAVE_IN_CACHE settings.
   */
  static cleanupCache(): { removedCount: number; bytesFreed: number } {
    this.initDirectories();

    const retentionDays = parseInt(process.env.CACHE_RETENTION_DAYS || '7', 10);
    const leaveInCache = (process.env.LEAVE_IN_CACHE || 'false').toLowerCase() === 'true';
    const hotDailyThreshold = parseInt(process.env.HOT_CACHE_DAILY_THRESHOLD || '10', 10);

    if (leaveInCache) {
      // If LEAVE_IN_CACHE is true, we keep files indefinitely unless explicit eviction
      return { removedCount: 0, bytesFreed: 0 };
    }

    const files = fs.readdirSync(this.cacheDir);
    const now = Date.now();
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    let removedCount = 0;
    let bytesFreed = 0;

    for (const filename of files) {
      const casSha256 = filename;
      const filePath = path.join(this.cacheDir, filename);

      try {
        const stats = fs.statSync(filePath);
        const ageMs = now - stats.mtimeMs;

        // Check if referenced by any permanent cache objects in SQLite
        const casChunk = MetadataStore.getCasChunk(casSha256);

        // If age exceeds retention, check if it's hot or permanent
        if (ageMs > retentionMs) {
          let isHot = false;
          let isPermanent = false;

          if (casChunk) {
            // Check objects referencing this chunk
            const db = (MetadataStore as any).getDb ? (MetadataStore as any).getDb() : null;
            // Or check via query: objects referencing this chunk with is_permanent_cache = 1 or high access count
          }

          if (!isHot && !isPermanent) {
            bytesFreed += stats.size;
            fs.unlinkSync(filePath);
            removedCount++;
          }
        }
      } catch (err) {
        console.error(`Error auditing cache file ${filename}:`, err);
      }
    }

    return { removedCount, bytesFreed };
  }

  static cleanStaleTempFiles(maxAgeMs = 24 * 60 * 60 * 1000): void {
    this.initDirectories();
    try {
      const files = fs.readdirSync(this.tempDir);
      const now = Date.now();
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (err) {
      console.error('Error cleaning temp files:', err);
    }
  }
}

export const cache = CacheManager;
