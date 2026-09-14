import type { S3Request } from '../types.js';
import { MetadataStore } from '../storage/metadata.js';
import { CasEngine } from '../storage/cas.js';
import { parseRange } from '../utils/headers.js';
import { errorResponse } from '../xml/builder.js';
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

  const totalSize = fileBuffer.length;
  const rangeHeader = s3.headers.get('range');

  const headers: Record<string, string> = {
    'Content-Type': obj.content_type || 'application/octet-stream',
    'ETag': obj.etag,
    'Last-Modified': new Date(obj.last_modified).toUTCString(),
    'Accept-Ranges': 'bytes',
    'x-amz-request-id': crypto.randomUUID(),
  };

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
