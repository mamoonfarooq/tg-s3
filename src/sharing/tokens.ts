import type { ShareOptions, ShareTokenRow } from '../types.js';
import { MetadataStore } from '../storage/metadata.js';
import { generateToken, hashPassword, verifyPassword, verifyShareSession } from '../utils/crypto.js';

export async function createShareToken(opts: ShareOptions): Promise<ShareTokenRow> {
  const token = generateToken(32);
  const nowMs = Math.floor(Date.now() / 1000) * 1000;
  const now = new Date(nowMs).toISOString();
  const expiresAt = opts.expiresIn
    ? new Date(nowMs + opts.expiresIn * 1000).toISOString()
    : null;
  const passwordHash = opts.password
    ? await hashPassword(opts.password)
    : null;

  const row: ShareTokenRow = {
    token,
    bucket: opts.bucket,
    key: opts.key,
    created_at: now,
    expires_at: expiresAt,
    password_hash: passwordHash,
    max_downloads: opts.maxDownloads ?? null,
    download_count: 0,
    creator: null,
    note: opts.note ?? null,
  };

  MetadataStore.createShareToken(row);
  return row;
}

export async function validateShareToken(token: string): Promise<{
  valid: boolean;
  reason?: string;
  share?: ShareTokenRow;
}> {
  const share = MetadataStore.getShareToken(token);
  if (!share) return { valid: false, reason: 'Link not found' };

  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return { valid: false, reason: 'Link expired', share };
  }

  if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
    return { valid: false, reason: 'Download limit reached', share };
  }

  return { valid: true, share };
}

export async function validateShareTokenWithCookie(token: string, cookieHeader: string | null): Promise<{
  valid: boolean;
  reason?: string;
  share?: ShareTokenRow;
}> {
  const result = await validateShareToken(token);
  if (!result.valid || !result.share) return result;

  if (!cookieHeader) return { valid: false, reason: 'Authentication required', share: result.share };

  const cookies = Object.fromEntries(cookieHeader.split(';').map(c => {
    const [k, ...v] = c.trim().split('=');
    return [k, v.join('=')];
  }));

  const sessionCookie = cookies[`share_auth_${token}`];
  if (!sessionCookie) return { valid: false, reason: 'Authentication required', share: result.share };

  const isValidSession = await verifyShareSession(token, sessionCookie);
  if (!isValidSession) return { valid: false, reason: 'Session expired', share: result.share };

  return { valid: true, share: result.share };
}
