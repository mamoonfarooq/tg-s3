import type { S3Request, ShareTokenRow, AuthContext } from '../types.js';
import { MetadataStore } from '../storage/metadata.js';
import { CasEngine } from '../storage/cas.js';
import { createShareToken, validateShareToken, validateShareTokenWithCookie } from '../sharing/tokens.js';
import { renderSharePage, renderPasswordPage, renderExpiredPage } from '../sharing/pages.js';
import { parseRange } from '../utils/headers.js';
import { detectLang } from '../i18n.js';
import { signShareSession, verifyPassword } from '../utils/crypto.js';

function contentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_');
  const escapeQuoted = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const utf8Name = encodeURIComponent(filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  if (asciiFallback === filename) {
    return `${disposition}; filename="${escapeQuoted(filename)}"`;
  }
  return `${disposition}; filename="${escapeQuoted(asciiFallback)}"; filename*=UTF-8''${utf8Name}`;
}

function hasBucketAccess(auth: AuthContext, bucket: string): boolean {
  if (auth.buckets.includes('*')) return true;
  return auth.buckets.includes(bucket);
}

export async function handleShareApi(request: Request, url: URL, auth?: AuthContext): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (auth && auth.permission === 'readonly' && (method === 'POST' || method === 'DELETE' || method === 'PATCH')) {
    return Response.json({ error: 'Readonly credentials cannot modify shares' }, { status: 403 });
  }

  // POST /api/shares
  if (method === 'POST' && path === '/api/shares') {
    let body: { bucket: string; key: string; expiresIn?: number; password?: string; maxDownloads?: number; note?: string };
    try { body = (await request.json()) as any; } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
    if (!body.bucket || !body.key) return Response.json({ error: 'bucket and key are required' }, { status: 400 });
    if (auth && !hasBucketAccess(auth, body.bucket)) return Response.json({ error: 'Access denied for this bucket' }, { status: 403 });
    if (body.expiresIn !== undefined && body.expiresIn < 1) body.expiresIn = undefined;
    if (body.maxDownloads !== undefined && body.maxDownloads < 1) body.maxDownloads = undefined;
    const obj = MetadataStore.getObject(body.bucket, body.key);
    if (!obj) return Response.json({ error: 'Object not found' }, { status: 404 });
    const share = await createShareToken(body);
    return Response.json({ ...share, url: `${url.origin}/share/${share.token}` });
  }

  // GET /api/shares
  if (method === 'GET' && path === '/api/shares') {
    const bucket = url.searchParams.get('bucket') || undefined;
    if (auth && bucket && !hasBucketAccess(auth, bucket)) return Response.json({ error: 'Access denied for this bucket' }, { status: 403 });
    const key = url.searchParams.get('key') || undefined;
    let tokens = MetadataStore.listShareTokens(bucket, key);
    if (auth && !auth.buckets.includes('*')) {
      tokens = tokens.filter(t => hasBucketAccess(auth, t.bucket));
    }
    return Response.json(tokens);
  }

  // GET/DELETE/PATCH /api/shares/:token
  const tokenMatch = path.match(/^\/api\/shares\/([^/]+)$/);
  if (tokenMatch) {
    const token = tokenMatch[1];

    if (method === 'GET') {
      const share = MetadataStore.getShareToken(token);
      if (!share) return Response.json({ error: 'Not found' }, { status: 404 });
      if (auth && !hasBucketAccess(auth, share.bucket)) return Response.json({ error: 'Access denied' }, { status: 403 });
      return Response.json(share);
    }

    if (method === 'DELETE') {
      const share = MetadataStore.getShareToken(token);
      if (share && auth && !hasBucketAccess(auth, share.bucket)) return Response.json({ error: 'Access denied' }, { status: 403 });
      MetadataStore.deleteShareToken(token);
      return new Response(null, { status: 204 });
    }

    if (method === 'PATCH') {
      const existing = MetadataStore.getShareToken(token);
      if (!existing) return Response.json({ error: 'Not found' }, { status: 404 });
      if (auth && !hasBucketAccess(auth, existing.bucket)) return Response.json({ error: 'Access denied' }, { status: 403 });
      let body: Record<string, unknown>;
      try { body = (await request.json()) as any; } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
      const updates: Partial<Pick<ShareTokenRow, 'expires_at' | 'password_hash' | 'max_downloads' | 'note'>> = {};
      if (body.expiresIn !== undefined) {
        const expiresIn = body.expiresIn as number;
        if (expiresIn >= 1) {
          updates.expires_at = new Date(Date.now() + expiresIn * 1000).toISOString();
        }
      }
      if (body.note !== undefined) updates.note = body.note as string;
      if (body.maxDownloads !== undefined) updates.max_downloads = body.maxDownloads as number;

      MetadataStore.updateShareToken(token, updates);
      return Response.json(MetadataStore.getShareToken(token));
    }
  }

  return Response.json({ error: 'Not found' }, { status: 404 });
}

export async function handleShareDownload(request: Request, url: URL): Promise<Response> {
  const tokenMatch = url.pathname.match(/^\/share\/([^/]+)$/);
  if (!tokenMatch) return new Response('Not found', { status: 404 });

  const token = tokenMatch[1];
  const lang = detectLang(request);
  const result = await validateShareToken(token);

  if (!result.valid || !result.share) {
    const reason = result.reason === 'Link expired' ? 'expired' : result.reason === 'Download limit reached' ? 'max_downloads' : 'not_found';
    return new Response(renderExpiredPage(reason, lang), {
      status: 410,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const share = result.share;
  const isDl = url.searchParams.get('dl') === '1';

  // Handle password submission
  if (request.method === 'POST' && share.password_hash) {
    try {
      const formData = await request.formData();
      const pwd = formData.get('password')?.toString();
      if (pwd && await verifyPassword(pwd, share.password_hash)) {
        const sig = await signShareSession(token);
        const redirectUrl = isDl ? `/share/${token}?dl=1` : `/share/${token}`;
        return new Response(null, {
          status: 302,
          headers: {
            'Location': redirectUrl,
            'Set-Cookie': `share_auth_${token}=${sig}; Path=/share/${token}; HttpOnly; SameSite=Lax; Max-Age=86400`,
          },
        });
      }
      return new Response(renderPasswordPage(share, url.origin, true, 0, lang), {
        status: 401,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    } catch {
      return new Response(renderPasswordPage(share, url.origin, true, 0, lang), { status: 400 });
    }
  }

  // Password-protected check
  if (share.password_hash) {
    const authResult = await validateShareTokenWithCookie(token, request.headers.get('Cookie'));
    if (!authResult.valid) {
      return new Response(renderPasswordPage(share, url.origin, false, 0, lang), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
  }

  const obj = MetadataStore.getObject(share.bucket, share.key);
  if (!obj) {
    return new Response(renderExpiredPage('not_found', lang), {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const filename = share.key.split('/').pop() || 'file';

  // Return preview landing page if not downloading directly
  if (!isDl) {
    return new Response(renderSharePage(obj, share, url.origin, lang), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // Record download count
  MetadataStore.incrementShareDownloads(token);

  // Stream file using CasEngine
  const rangeHeader = request.headers.get('range');
  const parsedRange = parseRange(rangeHeader, obj.size);

  let start: number | undefined;
  let end: number | undefined;
  let statusCode = 200;

  const validRange = parsedRange && parsedRange !== 'unsatisfiable' ? parsedRange : null;

  if (validRange) {
    start = validRange.start;
    end = validRange.end;
    statusCode = 206;
  }

  const chunks = MetadataStore.getObjectChunks(share.bucket, share.key);
  const casChunks = chunks.map(c => ({ cas_sha256: c.casSha256, size: c.size }));
  const nodeStream = await CasEngine.readStream(casChunks, start, end);
  const webStream = new ReadableStream({
    start(controller) {
      nodeStream.on('data', chunk => controller.enqueue(chunk));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', err => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    }
  });

  const responseHeaders: Record<string, string> = {
    'Content-Type': obj.content_type || 'application/octet-stream',
    'ETag': obj.etag,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': contentDisposition('attachment', filename),
  };

  if (validRange) {
    responseHeaders['Content-Range'] = `bytes ${validRange.start}-${validRange.end}/${obj.size}`;
    responseHeaders['Content-Length'] = String(validRange.end - validRange.start + 1);
  } else {
    responseHeaders['Content-Length'] = String(obj.size);
  }

  return new Response(webStream, {
    status: statusCode,
    headers: responseHeaders,
  });
}
