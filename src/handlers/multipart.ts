import fs from 'fs';
import crypto from 'crypto';
import type { S3Request } from '../types.js';
import { MetadataStore } from '../storage/metadata.js';
import { CacheManager } from '../storage/cache.js';
import { CasEngine } from '../storage/cas.js';
import { extractUserMetadata } from '../utils/headers.js';
import {
  initiateMultipartXml, completeMultipartXml, listPartsXml, listMultipartUploadsXml,
  xmlResponse, errorResponse
} from '../xml/builder.js';
import { parseCompleteMultipart } from '../xml/parser.js';
import { S3_MAX_KEYS_DEFAULT, S3_MAX_PART_NUMBER } from '../constants.js';

function clampInt(val: string | null, defaultVal: number, min: number, max: number): number {
  const n = parseInt(val || String(defaultVal), 10);
  if (isNaN(n)) return defaultVal;
  return Math.max(min, Math.min(n, max));
}

export async function handleMultipartUpload(s3: S3Request): Promise<Response> {
  const method = s3.method.toUpperCase();
  if (s3.query.has('uploads')) {
    if (method === 'POST') return handleCreateMultipartUpload(s3);
    if (method === 'GET') return handleListMultipartUploads(s3);
  }
  if (s3.query.has('uploadId')) {
    if (s3.query.has('partNumber')) {
      if (method === 'PUT') return handleUploadPart(s3);
    } else {
      if (method === 'POST') return handleCompleteMultipartUpload(s3);
      if (method === 'DELETE') return handleAbortMultipartUpload(s3);
      if (method === 'GET') return handleListParts(s3);
    }
  }
  return errorResponse(400, 'InvalidRequest', 'Invalid multipart request.');
}

export async function handleCreateMultipartUpload(s3: S3Request): Promise<Response> {
  const bucket = MetadataStore.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  const uploadId = crypto.randomUUID();
  const contentType = s3.headers.get('content-type') || 'application/octet-stream';

  MetadataStore.createMultipartUpload(uploadId, s3.bucket, s3.key, contentType);

  return xmlResponse(initiateMultipartXml(s3.bucket, s3.key, uploadId));
}

export async function handleUploadPart(s3: S3Request): Promise<Response> {
  const uploadId = s3.query.get('uploadId');
  const partNumber = parseInt(s3.query.get('partNumber') || '0', 10);
  if (!uploadId || !partNumber) return errorResponse(400, 'InvalidArgument', 'Missing uploadId or partNumber.');
  if (partNumber < 1 || partNumber > S3_MAX_PART_NUMBER) return errorResponse(400, 'InvalidArgument', 'partNumber must be between 1 and 10000.');

  const upload = MetadataStore.getMultipartUpload(uploadId);
  if (!upload || upload.bucket !== s3.bucket || upload.key !== s3.key) {
    return errorResponse(404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
  }

  // Write incoming stream to temp file
  const tempFileName = `part_${uploadId}_${partNumber}_${Date.now()}.tmp`;
  const tempPath = CacheManager.getTempPath(tempFileName);
  const fileStream = fs.createWriteStream(tempPath);
  const md5Hash = crypto.createHash('md5');

  let totalSize = 0;

  if (s3.body) {
    const reader = s3.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        fileStream.write(value);
        md5Hash.update(value);
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

  try {
    const casChunks = await CasEngine.storeFile(tempPath);
    MetadataStore.putMultipartPart({
      uploadId,
      partNumber,
      size: totalSize,
      etag,
      casSha256: JSON.stringify(casChunks),
    });

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

export async function handleCompleteMultipartUpload(s3: S3Request): Promise<Response> {
  const uploadId = s3.query.get('uploadId');
  if (!uploadId) return errorResponse(400, 'InvalidArgument', 'Missing uploadId.');

  const upload = MetadataStore.getMultipartUpload(uploadId);
  if (!upload || upload.bucket !== s3.bucket || upload.key !== s3.key) {
    return errorResponse(404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
  }

  if (!s3.body) return errorResponse(400, 'MalformedXML', 'Request body is empty.');
  const reader = s3.body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const bodyText = Buffer.concat(chunks).toString('utf-8');

  const requestParts = parseCompleteMultipart(bodyText);
  if (requestParts.length === 0) return errorResponse(400, 'MalformedXML', 'You must specify at least one part.');

  const parts = MetadataStore.listParts(uploadId);
  if (parts.length === 0) return errorResponse(400, 'InvalidPart', 'No parts uploaded for this multipart upload.');

  const objectRecord = MetadataStore.completeMultipartUpload(uploadId, s3.bucket, s3.key, requestParts);

  return xmlResponse(completeMultipartXml(s3.bucket, s3.key, objectRecord.etag));
}

export async function handleAbortMultipartUpload(s3: S3Request): Promise<Response> {
  const uploadId = s3.query.get('uploadId');
  if (!uploadId) return errorResponse(400, 'InvalidArgument', 'Missing uploadId.');

  const upload = MetadataStore.getMultipartUpload(uploadId);
  if (!upload || upload.bucket !== s3.bucket || upload.key !== s3.key) {
    return errorResponse(404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
  }

  MetadataStore.abortMultipartUpload(uploadId);
  return new Response(null, { status: 204 });
}

export async function handleListParts(s3: S3Request): Promise<Response> {
  const uploadId = s3.query.get('uploadId');
  if (!uploadId) return errorResponse(400, 'InvalidArgument', 'Missing uploadId.');

  const upload = MetadataStore.getMultipartUpload(uploadId);
  if (!upload || upload.bucket !== s3.bucket || upload.key !== s3.key) {
    return errorResponse(404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
  }

  const parts = MetadataStore.listParts(uploadId);
  return xmlResponse(listPartsXml(s3.bucket, s3.key, uploadId, parts));
}

export async function handleListMultipartUploads(s3: S3Request): Promise<Response> {
  const bucket = MetadataStore.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  const prefix = s3.query.get('prefix') || '';
  const delimiter = s3.query.get('delimiter') || '';
  const maxUploads = clampInt(s3.query.get('max-uploads'), S3_MAX_KEYS_DEFAULT, 0, S3_MAX_KEYS_DEFAULT);
  const keyMarker = s3.query.get('key-marker') || undefined;
  const uploadIdMarker = s3.query.get('upload-id-marker') || undefined;

  const result = MetadataStore.listMultipartUploads(s3.bucket, prefix, delimiter, maxUploads, keyMarker, uploadIdMarker);

  return xmlResponse(listMultipartUploadsXml({
    bucket: s3.bucket,
    prefix,
    delimiter,
    maxUploads,
    keyMarker: keyMarker || '',
    uploadIdMarker: uploadIdMarker || '',
    uploads: result.uploads,
    commonPrefixes: result.commonPrefixes,
    isTruncated: result.isTruncated,
    nextKeyMarker: result.nextKeyMarker,
    nextUploadIdMarker: result.nextUploadIdMarker,
  }));
}
