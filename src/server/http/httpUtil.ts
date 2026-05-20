import type { IncomingMessage, ServerResponse } from 'http';

export function parsePath(url: string | undefined): string {
  if (!url) return '/';
  const q = url.indexOf('?');
  return q >= 0 ? url.slice(0, q) : url;
}

export function parseQuery(url: string | undefined): Record<string, string> {
  if (!url) return {};
  const q = url.indexOf('?');
  if (q < 0) return {};
  const params = new URLSearchParams(url.slice(q + 1));
  const out: Record<string, string> = {};
  params.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** Strip mount prefix; returns path starting with `/` or `null` if no match */
export function pathUnderPrefix(pathname: string, prefix: string): string | null {
  const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (pathname === p) return '/';
  if (!pathname.startsWith(p + '/') && pathname !== p) return null;
  const rest = pathname === p ? '/' : pathname.slice(p.length) || '/';
  return rest.startsWith('/') ? rest : `/${rest}`;
}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

export function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/**
 * Supabase PostgrestError and similar plain objects stringify to "[object Object]" — normalize for JSON API.
 */
export function serializeErrorForHttp(e: unknown): Record<string, unknown> {
  if (e instanceof Error) {
    return { error: e.message };
  }
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if (typeof o.message === 'string') {
      const out: Record<string, unknown> = { error: o.message };
      if (typeof o.code === 'string') out.code = o.code;
      if (typeof o.details === 'string' && o.details) out.details = o.details;
      if (typeof o.hint === 'string' && o.hint) out.hint = o.hint;
      return out;
    }
  }
  try {
    return { error: JSON.stringify(e) };
  } catch {
    return { error: 'Unknown error' };
  }
}
