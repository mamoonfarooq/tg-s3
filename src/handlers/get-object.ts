import type { S3Request } from '../types.js';
import { MetadataStore } from '../storage/metadata.js';
import { CasEngine } from '../storage/cas.js';
import { parseRange } from '../utils/headers.js';
import { errorResponse } from '../xml/builder.js';
import { parseSseCHeaders, validateKeyMd5, decrypt, decryptS3, isEncrypted, isEncryptedS3, getStoredKeyMd5, addSseResponseHeaders, addSseS3ResponseHeaders, SseCError } from '../utils/sse.js';
import crypto from 'crypto';

export async function handleGetObject(s3: S3Request): Promise<Response> {
  const bucket = MetadataStore.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  const obj = MetadataStore.getObject(s3.bucket, s3.key);
  if (!obj) return errorResponse(404, 'NoSuchKey', 'The specified key does not exist.', `/${s3.bucket}/${s3.key}`);

  // Conditional request checks
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

  const ifMatch = s3.headers.get('if-match');
  if (ifMatch && ifMatch !== '*' && ifMatch !== obj.etag) {
    return errorResponse(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold.');
  }

  // Retrieve full file buffer via CAS engine
  let fileBuffer: Buffer;
  try {
    fileBuffer = await CasEngine.readObjectBuffer(s3.bucket, s3.key);
  } catch (err: any) {
    return errorResponse(500, 'InternalError', err.message || 'Failed to read object data.');
  }

  // Server-side encryption: SSE-S3 is transparent (server key from env);
  // SSE-C requires the customer key on every read, like real S3.
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
    try {
      const plain = await decrypt(
        fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength) as ArrayBuffer,
        sseParams.keyBase64
      );
      fileBuffer = Buffer.from(plain);
    } catch (err: any) {
      if (err instanceof SseCError) return errorResponse(403, 'AccessDenied', err.message);
      return errorResponse(500, 'InternalError', 'Failed to decrypt object data.');
    }
  } else if (isEncryptedS3(obj.system_metadata)) {
    if (!process.env.S3_MASTER_KEY) {
      return errorResponse(500, 'InternalError', 'Object is SSE-S3 encrypted but S3_MASTER_KEY is not configured.');
    }
    try {
      const plain = await decryptS3(
        fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength) as ArrayBuffer,
        process.env.S3_MASTER_KEY
      );
      fileBuffer = Buffer.from(plain);
    } catch {
      return errorResponse(500, 'InternalError', 'Failed to decrypt object data. Check S3_MASTER_KEY.');
    }
  }

  const totalSize = fileBuffer.length;
  const rangeHeader = s3.headers.get('range');

  const headers: Record<string, string> = {
    'Content-Type': obj.content_type || 'application/octet-stream',
    'ETag': obj.etag,
    'Last-Modified': new Date(obj.last_modified).toUTCString(),
    'Accept-Ranges': 'bytes',
    'x-amz-request-id': crypto.randomUUID(),
  };
  addSseResponseHeaders(headers, obj.system_metadata);
  addSseS3ResponseHeaders(headers, obj.system_metadata);

  // Add custom user metadata
  if (obj.custom_metadata) {
    try {
      const parsed = JSON.parse(obj.custom_metadata);
      for (const [k, v] of Object.entries(parsed)) {
        headers[`x-amz-meta-${k}`] = String(v);
      }
    } catch {}
  }

  if (rangeHeader) {
    const range = parseRange(rangeHeader, totalSize);
    if (range === 'unsatisfiable') {
      return errorResponse(416, 'InvalidRange', 'The requested range cannot be satisfied.', `/${s3.bucket}/${s3.key}`);
    }

    if (range) {
      const chunk = fileBuffer.subarray(range.start, range.end + 1);
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${totalSize}`;
      headers['Content-Length'] = chunk.length.toString();

      return new Response(chunk, {
        status: 206,
        headers,
      });
    }
  }

  headers['Content-Length'] = totalSize.toString();
  return new Response(fileBuffer, {
    status: 200,
    headers,
  });
}
