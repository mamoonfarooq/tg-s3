import type { S3Request } from '../types.js';
import { MetadataStore } from '../storage/metadata.js';
import { listObjectsV2Xml, listObjectsV1Xml, xmlResponse, errorResponse } from '../xml/builder.js';
import { S3_MAX_KEYS_DEFAULT } from '../constants.js';

function clampInt(val: string | null, defaultVal: number, min: number, max: number): number {
  const n = parseInt(val || String(defaultVal), 10);
  if (isNaN(n)) return defaultVal;
  return Math.max(min, Math.min(n, max));
}

function encodeToken(key: string): string {
  return Buffer.from(encodeURIComponent(key)).toString('base64');
}

function decodeToken(token: string): string {
  try {
    return decodeURIComponent(Buffer.from(token, 'base64').toString('utf-8'));
  } catch {
    return token;
  }
}

export async function handleListObjectsV2(s3: S3Request): Promise<Response> {
  const bucket = MetadataStore.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  const prefix = s3.query.get('prefix') || '';
  const delimiter = s3.query.get('delimiter') || '';
  const maxKeys = clampInt(s3.query.get('max-keys'), S3_MAX_KEYS_DEFAULT, 0, S3_MAX_KEYS_DEFAULT);
  const rawContinuationToken = s3.query.get('continuation-token') || undefined;
  const startAfter = s3.query.get('start-after') || undefined;
  const cursor = rawContinuationToken ? decodeToken(rawContinuationToken) : startAfter || undefined;
  const rawEncodingType = s3.query.get('encoding-type') || undefined;
  if (rawEncodingType && rawEncodingType !== 'url') {
    return errorResponse(400, 'InvalidArgument', `Invalid encoding type. Only "url" is supported.`);
  }
  const encodingType = rawEncodingType;
  const fetchOwner = s3.query.get('fetch-owner') === 'true';

  const result = MetadataStore.listObjects(s3.bucket, prefix, delimiter, maxKeys, cursor);

  return xmlResponse(listObjectsV2Xml({
    bucket: s3.bucket,
    prefix,
    delimiter,
    maxKeys,
    startAfter: startAfter || '',
    continuationToken: rawContinuationToken || '',
    contents: result.objects,
    commonPrefixes: result.commonPrefixes,
    isTruncated: result.isTruncated,
    nextToken: result.nextMarker ? encodeToken(result.nextMarker) : undefined,
    keyCount: result.objects.length + result.commonPrefixes.length,
    encodingType,
    fetchOwner,
  }));
}

export async function handleListObjects(s3: S3Request): Promise<Response> {
  const bucket = MetadataStore.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  const prefix = s3.query.get('prefix') || '';
  const delimiter = s3.query.get('delimiter') || '';
  const maxKeys = clampInt(s3.query.get('max-keys'), S3_MAX_KEYS_DEFAULT, 0, S3_MAX_KEYS_DEFAULT);
  const marker = s3.query.get('marker') || undefined;
  const rawEncodingType = s3.query.get('encoding-type') || undefined;
  if (rawEncodingType && rawEncodingType !== 'url') {
    return errorResponse(400, 'InvalidArgument', `Invalid encoding type. Only "url" is supported.`);
  }
  const encodingType = rawEncodingType;

  const result = MetadataStore.listObjects(s3.bucket, prefix, delimiter, maxKeys, marker);

  return xmlResponse(listObjectsV1Xml({
    bucket: s3.bucket,
    prefix,
    delimiter,
    maxKeys,
    marker: marker || '',
    contents: result.objects,
    commonPrefixes: result.commonPrefixes,
    isTruncated: result.isTruncated,
    nextMarker: delimiter ? result.nextMarker : undefined,
    encodingType,
  }));
}
