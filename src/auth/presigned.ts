import { hmacSha256, bufToHex } from '../utils/crypto.js';
import { formatAmzDate, formatAmzDateShort } from '../utils/headers.js';
import { MetadataStore } from '../storage/metadata.js';
import { verifySignature, awsUriEncode } from './sigv4.js';

export async function verifyPresignedUrl(
  url: URL,
  getCred: (accessKeyId: string) => Promise<any> | any
): Promise<{ valid: boolean; accessKeyId?: string; errorCode?: any; errorMessage?: string }> {
  const dummyReq = new Request(url.toString(), { method: 'GET' });
  const res = await verifySignature(dummyReq, url, async (accessKeyId: string) => {
    const cred = await getCred(accessKeyId);
    if (!cred) return null;
    return {
      secretKey: cred.secret_access_key,
      context: {
        accessKeyId: cred.access_key_id,
        permission: cred.permission as any,
        buckets: cred.buckets ? cred.buckets.split(',').map((b: string) => b.trim()) : ['*'],
      },
    };
  });

  if ('accessKeyId' in res) {
    return { valid: true, accessKeyId: res.accessKeyId };
  } else {
    return { valid: false, errorCode: res.code, errorMessage: res.message };
  }
}

/**
 * Generate a presigned URL using the first available admin credential.
 */
export async function generatePresignedUrl(params: {
  bucket: string;
  key: string;
  method?: string;
  expiresIn?: number;
  metadataStore: MetadataStore;
  baseUrl: string;
  region?: string;
}): Promise<string> {
  const { bucket, key, method = 'GET', expiresIn: rawExpires = 3600, metadataStore, baseUrl, region = 'us-east-1' } = params;

  const accessKeyId = process.env.S3_ADMIN_KEY || 'minioadmin';
  const secretAccessKey = process.env.S3_ADMIN_SECRET || 'minioadmin';

  // S3 caps presigned URL expiry at 7 days (604800 seconds)
  const expiresIn = Math.min(Math.max(1, rawExpires), 604800);
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateShort = formatAmzDateShort(now);
  const credential = `${accessKeyId}/${dateShort}/${region}/s3/aws4_request`;

  // Encode path segments to handle keys with special chars (spaces, ?, #)
  const encodedPath = '/' + bucket + '/' + key.split('/').map(s => awsUriEncode(s)).join('/');
  const url = new URL(encodedPath, baseUrl);
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', credential);
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', expiresIn.toString());
  url.searchParams.set('X-Amz-SignedHeaders', 'host');

  // SigV4 spec requires sorting by character code point, not locale order
  const sortedParams = [...url.searchParams.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const queryString = sortedParams.map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`).join('&');

  const canonicalRequest = [
    method,
    url.pathname,
    queryString,
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const { sha256Hex } = await import('../utils/crypto.js');
  const crHash = await sha256Hex(new TextEncoder().encode(canonicalRequest).buffer as ArrayBuffer);
  const scope = `${dateShort}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${crHash}`;

  const enc = new TextEncoder();
  let sigKey = await hmacSha256(enc.encode(`AWS4${secretAccessKey}`).buffer as ArrayBuffer, dateShort);
  sigKey = await hmacSha256(sigKey, region);
  sigKey = await hmacSha256(sigKey, 's3');
  sigKey = await hmacSha256(sigKey, 'aws4_request');
  const signature = bufToHex(await hmacSha256(sigKey, stringToSign));

  url.searchParams.set('X-Amz-Signature', signature);
  return url.toString();
}
