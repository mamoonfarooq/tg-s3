# S3 Compatibility Status

tg-s3 implements an S3-compatible API on top of Telegram as the storage backend.
This document records the compatibility status and deliberate design decisions for the current standalone Node.js implementation.

## Supported Operations

| Operation | Status | Notes |
|-----------|--------|-------|
| ListBuckets | Full | |
| CreateBucket | Full | Idempotent on existing bucket |
| DeleteBucket | Full | Rejects non-empty buckets and in-progress multipart uploads |
| HeadBucket | Full | Returns the bucket region |
| GetBucketLocation | Full | |
| GetBucketVersioning | Stub | Always returns disabled |
| ListObjects (V1) | Full | Supports prefix, delimiter, marker, and encoding-type |
| ListObjectsV2 | Full | Uses opaque continuation tokens |
| GetObject | Full | Supports conditional headers, range requests, partNumber, and response overrides |
| PutObject | Full | Supports content hashing and 0-byte objects |
| HeadObject | Full | Matches GetObject metadata semantics |
| DeleteObject | Full | Returns 204 even if the key does not exist |
| DeleteObjects | Full | Quiet mode and bulk delete validation |
| CopyObject | Full | Supports metadata directives and conditional copy headers |
| CreateMultipartUpload | Full | Preserves user and system metadata |
| UploadPart | Full | Verifies content hashes and cleans up re-uploads |
| UploadPartCopy | Full | Supports range copy and conditional copy headers |
| CompleteMultipartUpload | Full | Validates part order and multipart ETag generation |
| AbortMultipartUpload | Full | Cleans up Telegram-backed upload state |
| ListParts | Full | Supports pagination markers |
| ListMultipartUploads | Full | Supports prefix, delimiter, and pagination |
| GetObjectTagging | Full | Up to 10 tags per object |
| PutObjectTagging | Full | XML body validation and tag limits |
| DeleteObjectTagging | Full | |
| GetBucketLifecycleConfiguration | Full | Supports prefix and tag filters |
| PutBucketLifecycleConfiguration | Full | Supports expiration rules |
| DeleteBucketLifecycleConfiguration | Full | |

## Server-Side Encryption

- **SSE-C** (Customer-Provided Keys): Supported for single-part uploads. Requires `x-amz-server-side-encryption-customer-algorithm`, `x-amz-server-side-encryption-customer-key`, and `x-amz-server-side-encryption-customer-key-MD5`. Every GET/HEAD must present the same key: missing key returns 400, wrong key returns 403. The server stores only the key MD5.
- **SSE-S3** (Server-Managed Keys): Supported for single-part uploads. AES-256-GCM with a server-managed key from `S3_MASTER_KEY` (base64, 32 bytes, set in `.env`). Reads are transparent to clients.
- **SSE-KMS**: Not implemented.

**Encryption notes:**
- ETag remains the MD5 of the plaintext payload, matching standard S3 semantics.
- Encrypted chunks are cached locally like any other chunk (the cache holds ciphertext; decryption happens at request time).
- Encrypted objects are not deduplicated (fresh random IV per upload).
- Multipart uploads are stored unencrypted (SSE headers on multipart operations are ignored).
- CopyObject preserves the source object's encryption state; passing SSE headers on copy returns `501 NotImplemented`.
- Losing `S3_MASTER_KEY` (SSE-S3) or the customer key (SSE-C) makes those objects permanently unreadable; they can still be deleted.

## Authentication

- **SigV4 header auth**: Full, with standard S3-style validation errors.
- **Presigned URLs**: Full, with SigV4 query-string verification.
- **AWS chunked streaming**: Supported for streamed payloads where the request body is parsed and validated.
- **Bearer token**: Supported for simplified access in the local app workflow.
- **Simple Upload API**: Supported for scripts and automation workflows.

## Response Headers

- All responses include standard S3 headers such as `Date`, `x-amz-request-id`, and related metadata.
- XML responses use the standard S3 namespace.
- Range and conditional requests follow the expected S3 semantics.
- CORS headers are included for browser-friendly S3 access patterns.

## Error Responses

- Errors return standard S3 XML payloads with `<Code>`, `<Message>`, `<Resource>`, and `<RequestId>`.
- HEAD-friendly error metadata is included in the response headers where appropriate.
- Rate limiting and request validation errors are returned using standard S3-compatible semantics.

## Deliberately Not Implemented

### Versioning

**Decision**: Not implemented.

**Rationale**:

1. Telegram-backed storage is not elastic, so full object version chains would grow quickly and create a poor cost profile.
2. Versioning changes the semantics of nearly every S3 operation and would require a full versioned-object model.
3. The primary use case is a simple personal cloud store, so soft-delete or retention-based recovery is a better fit.

### Sub-resource Operations

Unsupported operations such as `?acl`, `?policy`, `?cors`, and `?encryption` return `501 NotImplemented` instead of being misrouted as data operations.

## Platform Constraints

These are inherent to the Telegram storage backend:

- **SSE-KMS is not available** because there is no KMS integration.
- **No storage classes**: all objects are effectively STANDARD.
- **No object locking / retention**: not applicable to the current storage model.
- **No bucket policies / ACL**: the system is single-owner and authenticated through access keys or SigV4.
