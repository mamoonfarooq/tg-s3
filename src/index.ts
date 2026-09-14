import { serve } from '@hono/node-server';
import dotenv from 'dotenv';
import { AppEnv, S3Request } from './types.js';
import { store } from './storage/metadata.js';
import { MTProtoManager } from './telegram/mtproto.js';
import { cache } from './storage/cache.js';
import { verifySigV4 } from './auth/sigv4.js';
import { verifyPresignedUrl } from './auth/presigned.js';
import { verifyBearerToken } from './auth/bearer.js';
import { handlePutObject } from './handlers/put-object.js';
import { handleGetObject } from './handlers/get-object.js';
import { handleHeadObject } from './handlers/head-object.js';
import { handleDeleteObject } from './handlers/delete-object.js';
import { handleListObjects } from './handlers/list-objects.js';
import { handleMultipartUpload } from './handlers/multipart.js';
import { handleCopyObject } from './handlers/copy-object.js';
import { handleBucketOps } from './handlers/bucket.js';
import { handleShareApi, handleShareDownload } from './handlers/share.js';
import { generateS3Error, S3ErrorCode } from './xml/builder.js';

dotenv.config();

const env: AppEnv = {
  TG_APP_ID: parseInt(process.env.TG_APP_ID || '0', 10),
  TG_APP_HASH: process.env.TG_APP_HASH || '',
  TG_SESSION: process.env.TG_SESSION || '',
  TG_GROUP_ID: process.env.TG_GROUP_ID || '',
  CHUNK_SIZE: parseInt(process.env.CHUNK_SIZE || '10485760', 10), // Default 10MB
  TEMP_DIR: process.env.TEMP_DIR || './data/temp',
  CACHE_DIR: process.env.CACHE_DIR || './data/cache',
  DB_PATH: process.env.DB_PATH || './data/tg-s3.db',
  S3_ADMIN_KEY: process.env.S3_ADMIN_KEY || 'admin',
  S3_ADMIN_SECRET: process.env.S3_ADMIN_SECRET || 'adminsecret',
  PORT: parseInt(process.env.PORT || '3000', 10),
};

// Simple LRU credential cache (Access Key ID -> Credential Record)
const credentialCache = new Map<string, { access_key_id: string; secret_access_key: string; buckets: string; permission: string; is_active: number }>();

async function getCredential(accessKeyId: string) {
  const cached = credentialCache.get(accessKeyId);
  if (cached) return cached;
  const cred = store.getCredentialByAccessKey(accessKeyId);
  if (cred) {
    credentialCache.set(accessKeyId, cred);
  }
  return cred;
}

// Background cleanup cron task (every 1 hour)
function startBackgroundJobs() {
  setInterval(async () => {
    try {
      store.deleteExpiredShareTokens();
      cache.cleanStaleTempFiles();
      // Clean incomplete multipart uploads older than 24 hours
      const oldUploads = store.getOldIncompleteMultipartUploads(24 * 3600);
      for (const upload of oldUploads) {
        store.abortMultipartUpload(upload.upload_id);
      }
    } catch (err) {
      console.error('Background cleanup error:', err);
    }
  }, 60 * 60 * 1000);
}

// Global request dispatcher
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return handleCors();
  }

  // Health check endpoint
  if (path === '/health') {
    return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
  }

  // Public share download route: /share/:token
  if (path.startsWith('/share/')) {
    const shareResponse = await handleShareDownload(request, url);
    return addCorsHeaders(shareResponse);
  }

  // Share API route: /api/shares
  if (path.startsWith('/api/shares')) {
    const authResult = await authenticateS3Request(request, url);
    if (authResult instanceof Response) {
      return addCorsHeaders(authResult);
    }
    const shareResponse = await handleShareApi(request, url, {
      accessKeyId: authResult.accessKeyId,
      permission: authResult.permission as any,
      buckets: authResult.buckets.split(',').map(b => b.trim()),
    });
    return addCorsHeaders(shareResponse);
  }

  // S3 API Handling
  try {
    const authResult = await authenticateS3Request(request, url);
    if (authResult instanceof Response) {
      return addCorsHeaders(authResult);
    }

    const { bucket, key } = parseS3Path(url.hostname, path);

    const s3Req: S3Request = {
      method,
      bucket,
      key,
      query: url.searchParams,
      headers: request.headers,
      body: request.body,
      url,
    };

    // Permission check
    const requiredPermission = method === 'GET' || method === 'HEAD' ? 'readonly' : 'readwrite';
    if (!hasPermission(authResult.permission, requiredPermission)) {
      return addCorsHeaders(generateS3Error(S3ErrorCode.AccessDenied, key, 'Access Denied', authResult.accessKeyId));
    }

    // Bucket authorization check
    if (!isBucketAllowed(authResult.buckets, bucket)) {
      return addCorsHeaders(generateS3Error(S3ErrorCode.AccessDenied, key, 'Access Denied to bucket', authResult.accessKeyId));
    }

    // Bucket-level S3 operations (no object key)
    if (!key) {
      const bucketResponse = await handleBucketOps(s3Req);
      return addCorsHeaders(bucketResponse);
    }

    // Copy object operation: PUT object with X-Amz-Copy-Source header
    if (method === 'PUT' && request.headers.has('x-amz-copy-source')) {
      const copyResponse = await handleCopyObject(s3Req);
      return addCorsHeaders(copyResponse);
    }

    // Multipart upload sub-resource operations
    if (
      url.searchParams.has('uploads') ||
      url.searchParams.has('uploadId')
    ) {
      const mpResponse = await handleMultipartUpload(s3Req);
      return addCorsHeaders(mpResponse);
    }

    // Object operations based on HTTP method
    let s3Response: Response;
    switch (method) {
      case 'PUT':
        s3Response = await handlePutObject(s3Req);
        break;
      case 'GET':
        s3Response = await handleGetObject(s3Req);
        break;
      case 'HEAD':
        s3Response = await handleHeadObject(s3Req);
        break;
      case 'DELETE':
        s3Response = await handleDeleteObject(s3Req);
        break;
      default:
        s3Response = generateS3Error(S3ErrorCode.MethodNotAllowed, key, 'Method Not Allowed');
        break;
    }

    return addCorsHeaders(s3Response);
  } catch (err: any) {
    console.error('Unhandled request error:', err);
    return addCorsHeaders(generateS3Error(S3ErrorCode.InternalError, '', err.message || 'Internal Error'));
  }
}

// Authenticate incoming S3 Request using SigV4 or Presigned URL
async function authenticateS3Request(
  request: Request,
  url: URL
): Promise<{ accessKeyId: string; permission: string; buckets: string } | Response> {
  const authorization = request.headers.get('Authorization');
  const hasPresignedSig = url.searchParams.has('X-Amz-Signature');

  if (!authorization && !hasPresignedSig) {
    return generateS3Error(S3ErrorCode.AccessDenied, '', 'Missing Authorization Header or Presigned Parameters');
  }

  const resolver = async (accessKeyId: string) => {
    const cred = await getCredential(accessKeyId);
    if (!cred || !cred.is_active) return null;
    return {
      secretKey: cred.secret_access_key,
      context: {
        accessKeyId: cred.access_key_id,
        permission: cred.permission as any,
        buckets: cred.buckets ? cred.buckets.split(',').map((b: string) => b.trim()) : ['*'],
      },
    };
  };

  if (authorization) {
    if (!authorization.startsWith('AWS4-HMAC-SHA256')) {
      return generateS3Error(S3ErrorCode.InvalidArgument, '', 'Unsupported Authorization scheme');
    }

    const sigResult = await verifySigV4(request, resolver);
    if ('code' in sigResult) {
      return generateS3Error((sigResult.code as S3ErrorCode) || S3ErrorCode.SignatureDoesNotMatch, '', sigResult.message || 'Invalid Signature');
    }

    return {
      accessKeyId: sigResult.accessKeyId,
      permission: sigResult.permission,
      buckets: sigResult.buckets.join(','),
    };
  } else {
    // Presigned URL Verification
    const preResult = await verifyPresignedUrl(url, getCredential);
    if (!preResult.valid) {
      return generateS3Error(preResult.errorCode || S3ErrorCode.SignatureDoesNotMatch, '', preResult.errorMessage || 'Invalid Presigned URL');
    }

    const cred = await getCredential(preResult.accessKeyId!);
    if (!cred || !cred.is_active) {
      return generateS3Error(S3ErrorCode.InvalidAccessKeyId, '', 'Access Key is inactive or invalid');
    }

    return { accessKeyId: preResult.accessKeyId!, permission: cred.permission, buckets: cred.buckets };
  }
}

// Parse S3 bucket and object key from path style or virtual host style
function parseS3Path(hostname: string, pathname: string): { bucket: string; key: string } {
  let rawPath = decodeURIComponent(pathname);
  if (rawPath.startsWith('/')) rawPath = rawPath.slice(1);

  const parts = rawPath.split('/').filter(Boolean);
  if (parts.length === 0) {
    return { bucket: '', key: '' };
  }

  const bucket = parts[0];
  const key = parts.slice(1).join('/');
  return { bucket, key };
}

function hasPermission(userPerm: string, required: 'readonly' | 'readwrite'): boolean {
  if (userPerm === 'admin') return true;
  if (userPerm === 'readwrite') return true;
  if (userPerm === 'readonly' && required === 'readonly') return true;
  return false;
}

function isBucketAllowed(allowedBucketsStr: string, targetBucket: string): boolean {
  if (!targetBucket) return true;
  if (allowedBucketsStr === '*') return true;
  const list = allowedBucketsStr.split(',').map(b => b.trim().toLowerCase());
  return list.includes(targetBucket.toLowerCase());
}

// Common Utility Functions

function generateRequestId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function handleCors(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, PATCH, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Amz-Date, X-Amz-Content-Sha256, X-Amz-Security-Token, X-Amz-Copy-Source, X-Amz-Copy-Source-Range, X-Amz-Metadata-Directive, X-Amz-Copy-Source-If-Match, X-Amz-Copy-Source-If-None-Match, X-Amz-Copy-Source-If-Modified-Since, X-Amz-Copy-Source-If-Unmodified-Since, X-Amz-Acl, X-Amz-Tagging, X-Amz-Server-Side-Encryption, X-Amz-Server-Side-Encryption-Customer-Algorithm, X-Amz-Server-Side-Encryption-Customer-Key, X-Amz-Server-Side-Encryption-Customer-Key-MD5, X-Amz-Copy-Source-Server-Side-Encryption-Customer-Algorithm, X-Amz-Copy-Source-Server-Side-Encryption-Customer-Key, X-Amz-Copy-Source-Server-Side-Encryption-Customer-Key-MD5, X-Amz-Storage-Class, Content-MD5, Content-Disposition, Content-Encoding, Content-Language, Cache-Control, Expires, Range, If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since, X-Amz-Meta-*',
      'Access-Control-Expose-Headers': 'ETag, Content-Length, Content-Range, Last-Modified, Accept-Ranges, Content-Disposition, Content-Encoding, x-amz-request-id, x-amz-id-2, x-amz-error-code, x-amz-error-message, x-amz-mp-parts-count, x-amz-bucket-region, x-amz-server-side-encryption, x-amz-server-side-encryption-customer-algorithm, x-amz-server-side-encryption-customer-key-MD5, x-amz-meta-*, Retry-After, Location, Date',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function addCorsHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');
  newHeaders.set('Access-Control-Expose-Headers', 'ETag, Content-Length, Content-Range, Last-Modified, Accept-Ranges, Content-Disposition, Content-Encoding, x-amz-request-id, x-amz-id-2, x-amz-error-code, x-amz-error-message, x-amz-mp-parts-count, x-amz-bucket-region, x-amz-server-side-encryption, x-amz-server-side-encryption-customer-algorithm, x-amz-server-side-encryption-customer-key-MD5, x-amz-meta-*, Retry-After, Location, Date');
  if (!newHeaders.has('Date')) {
    newHeaders.set('Date', new Date().toUTCString());
  }
  if (!newHeaders.has('x-amz-request-id')) {
    newHeaders.set('x-amz-request-id', generateRequestId());
  }
  if (!newHeaders.has('x-amz-id-2')) {
    newHeaders.set('x-amz-id-2', generateRequestId() + generateRequestId());
  }
  if (!newHeaders.has('Server')) {
    newHeaders.set('Server', 'AmazonS3');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

// Server Startup Initialization
async function startServer() {
  console.log('🚀 Starting tg-s3 server...');
  
  // 1. Initialize SQLite Database & Bootstrap Admin Credentials
  store.bootstrapCredentials(env.S3_ADMIN_KEY, env.S3_ADMIN_SECRET);

  // 2. Start Background Cleanup Jobs
  startBackgroundJobs();

  // 3. Start GramJS MTProto Telegram Connection if credentials provided
  if (env.TG_APP_ID && env.TG_APP_HASH && env.TG_SESSION && env.TG_GROUP_ID) {
    try {
      await MTProtoManager.init({
        appId: env.TG_APP_ID,
        appHash: env.TG_APP_HASH,
        session: env.TG_SESSION,
        groupId: String(env.TG_GROUP_ID),
        chunkSize: env.CHUNK_SIZE,
      });
      console.log('✅ Telegram MTProto client initialized and connected.');
    } catch (err) {
      console.error('⚠️ Telegram MTProto client initialization failed:', err);
      console.error('The server will start, but S3 chunk uploads/downloads to Telegram will fail until MTProto is connected.');
    }
  } else {
    console.warn('⚠️ Telegram MTProto credentials missing in environment.');
    console.warn('Please run `npm run login` to generate TG_SESSION and set TG_APP_ID, TG_APP_HASH, TG_SESSION, and TG_GROUP_ID in .env.');
  }

  // 4. Start HTTP Server using @hono/node-server
  const port = typeof env.PORT === 'number' ? env.PORT : parseInt(String(env.PORT || '3000'), 10);
  serve({
    fetch: handleRequest,
    port,
  }, (info) => {
    console.log(`🌐 S3 Server running at http://localhost:${info.port}`);
    console.log(`🔑 Admin Access Key: ${env.S3_ADMIN_KEY}`);
  });
}

startServer();

