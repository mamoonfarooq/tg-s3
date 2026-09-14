import type { AppEnv } from '../types.js';
import { timingSafeEqual } from '../utils/crypto.js';

export function verifyBearerToken(request: Request, adminSecret?: string): boolean {
  const auth = request.headers.get('Authorization');
  if (!auth) return false;
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return false;
  const token = parts[1];
  if (adminSecret && token === adminSecret) return true;
  const envSecret = process.env.S3_ADMIN_SECRET || process.env.S3_ADMIN_KEY;
  if (envSecret && token === envSecret) return true;
  return false;
}
