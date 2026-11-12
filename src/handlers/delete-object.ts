import type { S3Request } from '../types.js';
import { MetadataStore } from '../storage/metadata.js';
import { cache } from '../storage/cache.js';
import { deleteChunkFromTelegram } from '../telegram/mtproto.js';
import { errorResponse, deleteObjectsXml, xmlResponse } from '../xml/builder.js';
import { parseDeleteObjects } from '../xml/parser.js';
import crypto from 'crypto';

// Remove the Telegram message, local cache file, and CAS row of chunks
// that are no longer referenced by any object.
async function cleanupUnreferencedChunks(hashes: string[]): Promise<void> {
  for (const sha of hashes) {
    try {
      const cas = MetadataStore.getCasChunk(sha);
      if (cas?.tg_msg_id) {
        await deleteChunkFromTelegram(cas.tg_msg_id);
      }
      cache.removeCacheChunk(sha);
      MetadataStore.deleteCasChunk(sha);
    } catch (err: any) {
      console.error(`Failed to cleanup unreferenced CAS chunk ${sha.slice(0, 8)}...:`, err.message || err);
    }
  }
}

export async function handleDeleteObject(s3: S3Request): Promise<Response> {
  const bucket = MetadataStore.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  const { unreferencedCasHashes } = MetadataStore.deleteObject(s3.bucket, s3.key);
  await cleanupUnreferencedChunks(unreferencedCasHashes);
  return new Response(null, { status: 204 });
}

export async function handleDeleteObjects(s3: S3Request): Promise<Response> {
  if (!s3.body) return errorResponse(400, 'MalformedXML', 'Request body is empty.');

  const bucket = MetadataStore.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  const reader = s3.body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const bodyBuffer = Buffer.concat(chunks);
  const bodyText = bodyBuffer.toString('utf-8');

  // Validate Content-MD5 if supplied
  const contentMd5 = s3.headers.get('content-md5');
  if (contentMd5) {
    const computedBase64 = crypto.createHash('md5').update(bodyBuffer).digest('base64');
    if (computedBase64 !== contentMd5) {
      return errorResponse(400, 'BadDigest', 'The Content-MD5 you specified did not match what we received.');
    }
  }

  const { keys, quiet } = parseDeleteObjects(bodyText);
  if (keys.length === 0 || keys.length > 1000) {
    return errorResponse(400, 'MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema.');
  }

  const deleted: string[] = [];
  const errors: Array<{ key: string; code: string; message: string }> = [];

  for (const key of keys) {
    try {
      const { unreferencedCasHashes } = MetadataStore.deleteObject(s3.bucket, key);
      await cleanupUnreferencedChunks(unreferencedCasHashes);
      deleted.push(key);
    } catch (e: any) {
      errors.push({ key, code: 'InternalError', message: e.message || 'Failed to delete object.' });
    }
  }

  return xmlResponse(deleteObjectsXml(quiet ? [] : deleted, errors));
}
