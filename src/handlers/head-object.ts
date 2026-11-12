import type { S3Request } from '../types.js';
import { MetadataStore } from '../storage/metadata.js';
import { errorResponse } from '../xml/builder.js';
import { parseSseCHeaders, validateKeyMd5, getStoredKeyMd5, addSseResponseHeaders, addSseS3ResponseHeaders, isEncrypted, SseCError } from '../utils/sse.js';
import crypto from 'crypto';

export async function handleHeadObject(s3: S3Request): Promise<Response> {
  const bucket = MetadataStore.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  const obj = MetadataStore.getObject(s3.bucket, s3.key);
  if (!obj) return errorResponse(404, 'NoSuchKey', 'The specified key does not exist.', `/${s3.bucket}/${s3.key}`);

  if (isEncrypted(obj.system_metadata)) {
    let sseParams;
    try {
      sseParams = parseSseCHeaders(s3.headers);
    } catch (e) {
      if (e instanceof SseCError) return errorResponse(400, 'InvalidArgument', e.message);
      throw e;
    }
    if (!sseParams) {
      return errorResponse(400, 'InvalidRequest', 'The object was stored using a customer-provided encryption key. Provide x-amz-server-side-encryption-customer-* headers to read it.');
    }
    try {
      await validateKeyMd5(sseParams);
    } catch (e) {
      if (e instanceof SseCError) return errorResponse(400, 'InvalidArgument', e.message);
      throw e;
    }
    if (sseParams.keyMd5 !== getStoredKeyMd5(obj.system_metadata)) {
      return errorResponse(403, 'AccessDenied', 'The encryption key provided does not match the key used to store this object.');
    }
  }

  // Conditional request check
  const ifNoneMatch = s3.headers.get('if-none-match');
  if (ifNoneMatch && (ifNoneMatch === obj.etag || ifNoneMatch === '*')) {
    return new Response(null, {
      status: 304,
      headers: {
        'ETag': obj.etag,
        'Last-Modified': new Date(obj.last_modified).toUTCString(),
      },
    });
  }

  const headers: Record<string, string> = {
    'Content-Type': obj.content_type || 'application/octet-stream',
    'Content-Length': obj.size.toString(),
    'ETag': obj.etag,
    'Last-Modified': new Date(obj.last_modified).toUTCString(),
    'Accept-Ranges': 'bytes',
    'x-amz-request-id': crypto.randomUUID(),
  };
  addSseResponseHeaders(headers, obj.system_metadata);
  addSseS3ResponseHeaders(headers, obj.system_metadata);

  if (obj.custom_metadata) {
    try {
      const parsed = JSON.parse(obj.custom_metadata);
      for (const [k, v] of Object.entries(parsed)) {
        headers[`x-amz-meta-${k}`] = String(v);
      }
    } catch {}
  }

  return new Response(null, {
    status: 200,
    headers,
  });
}

