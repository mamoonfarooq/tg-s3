import fs from 'fs';
import crypto from 'crypto';
import type { S3Request } from '../types.js';
import { MetadataStore } from '../storage/metadata.js';
import { CacheManager } from '../storage/cache.js';
import { CasEngine } from '../storage/cas.js';
import { extractUserMetadata } from '../utils/headers.js';
import { errorResponse } from '../xml/builder.js';
import { parseSseCHeaders, validateKeyMd5, SseCError } from '../utils/sse.js';

function parseTaggingHeader(header: string | null): { key: string; value: string }[] | null {
  if (!header) return null;
  const tags = header.split('&').map(pair => {
    const [k, v] = pair.split('=');
    return { key: decodeURIComponent(k || ''), value: decodeURIComponent(v || '') };
  }).filter(t => t.key);
  return tags.length > 0 && tags.length <= 10 ? tags : null;
}

export async function handlePutObject(s3: S3Request): Promise<Response> {
  const bucket = MetadataStore.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  // SSE-C check
  let sseParams: ReturnType<typeof parseSseCHeaders> = null;
  try {
    sseParams = parseSseCHeaders(s3.headers);
    if (sseParams) await validateKeyMd5(sseParams);
  } catch (e) {
    if (e instanceof SseCError) return errorResponse(400, 'InvalidArgument', e.message);
    throw e;
  }

  const contentType = s3.headers.get('content-type') || 'application/octet-stream';
  const userMeta = extractUserMetadata(s3.headers);

  // Tags validation
  const parsedTags = parseTaggingHeader(s3.headers.get('x-amz-tagging'));
  if (s3.headers.get('x-amz-tagging') && !parsedTags) {
    return errorResponse(400, 'InvalidTag', 'Object tags cannot be greater than 10.');
  }

  // If-None-Match check
  const ifNoneMatch = s3.headers.get('if-none-match');
  if (ifNoneMatch && ifNoneMatch.trim() === '*') {
    const existing = MetadataStore.getObject(s3.bucket, s3.key);
    if (existing) {
      return errorResponse(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold.');
    }
  }

  // Write incoming stream to temp file
  const tempFileName = `put_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.tmp`;
  const tempPath = CacheManager.getTempPath(tempFileName);

  const fileStream = fs.createWriteStream(tempPath);
  const md5Hash = crypto.createHash('md5');
  const sha256Hash = crypto.createHash('sha256');

  let totalSize = 0;

  if (s3.body) {
    const reader = s3.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        fileStream.write(value);
        md5Hash.update(value);
        sha256Hash.update(value);
        totalSize += value.byteLength;
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    fileStream.end((err?: Error) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const etag = `"${md5Hash.digest('hex')}"`;
  const sha256HexStr = sha256Hash.digest('hex');

  // Verify Content-MD5 if supplied
  const contentMd5 = s3.headers.get('content-md5');
  if (contentMd5) {
    const computedBase64 = md5Hash.digest('base64');
    if (computedBase64 !== contentMd5) {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      return errorResponse(400, 'BadDigest', 'The Content-MD5 you specified did not match what we received.');
    }
  }

  try {
    // Process temp file into CAS chunks & upload to Telegram if chunk is new
    const casChunks = await CasEngine.storeFile(tempPath);

    // Save object & chunks in SQLite metadata
    MetadataStore.saveObjectWithChunks(
      s3.bucket,
      s3.key,
      totalSize,
      etag,
      contentType,
      sha256HexStr,
      userMeta,
      casChunks
    );

    return new Response(null, {
      status: 200,
      headers: {
        'ETag': etag,
        'x-amz-request-id': crypto.randomUUID(),
      },
    });
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}
