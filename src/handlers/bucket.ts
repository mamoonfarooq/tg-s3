import type { S3Request } from '../types.js';
import { MetadataStore } from '../storage/metadata.js';
import { listBucketsXml, xmlResponse, errorResponse } from '../xml/builder.js';

export async function handleBucketOps(s3: S3Request): Promise<Response> {
  const method = s3.method.toUpperCase();
  if (method === 'PUT') return handleCreateBucket(s3);
  if (method === 'DELETE') return handleDeleteBucket(s3);
  if (method === 'HEAD') {
    const bucket = MetadataStore.getBucket(s3.bucket);
    if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);
    return new Response(null, { status: 200 });
  }
  if (method === 'GET') {
    const { handleListObjects } = await import('./list-objects.js');
    return handleListObjects(s3);
  }
  return errorResponse(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.');
}

export async function handleListBuckets(_s3: S3Request): Promise<Response> {
  const buckets = MetadataStore.listBuckets();
  return xmlResponse(listBucketsXml(buckets));
}

export async function handleCreateBucket(s3: S3Request): Promise<Response> {
  const existing = MetadataStore.getBucket(s3.bucket);
  if (existing) return new Response(null, { status: 200, headers: { 'Location': `/${s3.bucket}` } });

  const RESERVED_BUCKETS = new Set(['share', 'api', 'bot']);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s3.bucket)
    || /\.\./.test(s3.bucket)
    || /\.-|-\./.test(s3.bucket)
    || /^\d+\.\d+\.\d+\.\d+$/.test(s3.bucket)
    || s3.bucket.startsWith('xn--')
    || s3.bucket.endsWith('-s3alias') || s3.bucket.endsWith('--ol-s3')
    || RESERVED_BUCKETS.has(s3.bucket)
  ) {
    return errorResponse(400, 'InvalidBucketName', 'The specified bucket is not valid.');
  }

  MetadataStore.createBucket(s3.bucket);
  return new Response(null, { status: 200, headers: { 'Location': `/${s3.bucket}` } });
}

export async function handleDeleteBucket(s3: S3Request): Promise<Response> {
  const bucket = MetadataStore.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  const objects = MetadataStore.listObjects(s3.bucket, '', '', 1);
  if (objects.objects.length > 0) {
    return errorResponse(409, 'BucketNotEmpty', 'The bucket you tried to delete is not empty.', s3.bucket);
  }

  const uploads = MetadataStore.listMultipartUploads(s3.bucket, '', '', 1);
  if (uploads.uploads.length > 0) {
    return errorResponse(409, 'BucketNotEmpty', 'The bucket you tried to delete has in-progress multipart uploads.', s3.bucket);
  }

  MetadataStore.deleteShareTokensByBucket(s3.bucket);
  MetadataStore.deleteBucket(s3.bucket);
  return new Response(null, { status: 204 });
}

export async function handleHeadBucket(s3: S3Request): Promise<Response> {
  const bucket = MetadataStore.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);
  const headers: Record<string, string> = { 'x-amz-bucket-region': process.env.S3_REGION || 'us-east-1' };
  return new Response(null, { status: 200, headers });
}

export async function handleGetBucketLocation(s3: S3Request): Promise<Response> {
  const bucket = MetadataStore.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);
  const region = process.env.S3_REGION || 'us-east-1';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${region}</LocationConstraint>`;
  return xmlResponse(xml);
}

export async function handleGetBucketVersioning(s3: S3Request): Promise<Response> {
  const bucket = MetadataStore.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);
  return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?>\n<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>`);
}
