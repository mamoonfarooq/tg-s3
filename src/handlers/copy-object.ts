import crypto from 'crypto';
import type { S3Request } from '../types.js';
import { MetadataStore } from '../storage/metadata.js';
import { extractUserMetadata } from '../utils/headers.js';
import { etagMatches } from '../utils/headers.js';
import { copyObjectXml, xmlResponse, errorResponse } from '../xml/builder.js';

export async function handleCopyObject(s3: S3Request): Promise<Response> {
  // Parse x-amz-copy-source header
  const copySource = s3.headers.get('x-amz-copy-source') || '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(copySource.split('?')[0]);
  } catch {
    return errorResponse(400, 'InvalidArgument', 'Invalid copy source encoding.');
  }
  const trimmed = decoded.startsWith('/') ? decoded.slice(1) : decoded;
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx < 0) return errorResponse(400, 'InvalidArgument', 'Invalid copy source.');

  const srcBucket = trimmed.slice(0, slashIdx);
  const srcKey = trimmed.slice(slashIdx + 1);

  // x-amz-metadata-directive: COPY (default) or REPLACE
  const metadataDirective = (s3.headers.get('x-amz-metadata-directive') || 'COPY').toUpperCase();
  if (metadataDirective !== 'COPY' && metadataDirective !== 'REPLACE') {
    return errorResponse(400, 'InvalidArgument', `Unknown metadata directive '${metadataDirective}'.`);
  }

  if (srcBucket === s3.bucket && srcKey === s3.key && metadataDirective !== 'REPLACE') {
    return errorResponse(400, 'InvalidRequest',
      'This copy request is illegal because it is trying to copy an object to itself without changing the object\'s metadata.');
  }

  // Check source bucket exists
  const srcBucketRow = MetadataStore.getBucket(srcBucket);
  if (!srcBucketRow) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', srcBucket);

  // Get source object
  const srcObj = MetadataStore.getObject(srcBucket, srcKey);
  if (!srcObj) return errorResponse(404, 'NoSuchKey', 'The specified key does not exist.', `/${srcBucket}/${srcKey}`);

  // Conditional copy headers
  const copyIfMatch = s3.headers.get('x-amz-copy-source-if-match');
  if (copyIfMatch && !etagMatches(copyIfMatch, srcObj.etag, true)) {
    return errorResponse(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold.');
  }
  if (!copyIfMatch) {
    const copyIfUnmodifiedSince = s3.headers.get('x-amz-copy-source-if-unmodified-since');
    if (copyIfUnmodifiedSince && new Date(srcObj.last_modified).getTime() > new Date(copyIfUnmodifiedSince).getTime()) {
      return errorResponse(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold.');
    }
  }
  const copyIfNoneMatch = s3.headers.get('x-amz-copy-source-if-none-match');
  if (copyIfNoneMatch && etagMatches(copyIfNoneMatch, srcObj.etag)) {
    return errorResponse(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold.');
  }
  if (!copyIfNoneMatch) {
    const copyIfModifiedSince = s3.headers.get('x-amz-copy-source-if-modified-since');
    if (copyIfModifiedSince && new Date(srcObj.last_modified).getTime() <= new Date(copyIfModifiedSince).getTime()) {
      return errorResponse(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold.');
    }
  }

  // Check destination bucket exists
  const destBucket = MetadataStore.getBucket(s3.bucket);
  if (!destBucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  let contentType = srcObj.content_type;
  let customMetadata: any = srcObj.custom_metadata ? JSON.parse(srcObj.custom_metadata) : undefined;

  if (metadataDirective === 'REPLACE') {
    contentType = s3.headers.get('content-type') || contentType;
    const userMeta = extractUserMetadata(s3.headers);
    if (Object.keys(userMeta).length > 0) {
      customMetadata = userMeta;
    } else {
      customMetadata = undefined;
    }
  }

  const chunks = MetadataStore.getObjectChunks(srcBucket, srcKey);
  const systemMetadata = srcObj.custom_metadata ? JSON.parse(srcObj.custom_metadata) : undefined;
  const lastModified = new Date().toISOString();

  MetadataStore.saveObjectWithChunks(
    s3.bucket,
    s3.key,
    srcObj.size,
    srcObj.etag,
    contentType,
    null,
    customMetadata || systemMetadata || null,
    chunks
  );

  return xmlResponse(copyObjectXml(srcObj.etag, lastModified));
}
