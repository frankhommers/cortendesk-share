// CortenDesk Share: HTTP server for the guest page, the admin pages and the
// gateway WebSocket.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { config, configProblems } from './config';
import { ensureLink, identity, linkStatus, peers, ssoPending, startSso } from './cortendesk';
import {
  activeLinks,
  devicesWithPassword,
  insertLink,
  linkById,
  linkByTokenHash,
  linkUsable,
  openDb,
  recentSessions,
  revokeLink,
  setDevicePassword,
  type Rights,
} from './db';
import { attachGateway, endLink, live, log, permissionsFor, probeDisplays, shutdownGateway } from './gateway';
import { emailAllowed, finishLogin, startLogin } from './oidc';
import { adminPage, messagePage, sharePage } from './pages';
import { encrypt, randomToken, sha256Hex, sign, unsign } from './secrets';

const VERSION = process.env.APP_VERSION || 'dev';
const SESSION_COOKIE = 'cds_session';
const OIDC_COOKIE = 'cds_oidc';
const DURATIONS = [900, 3600, 28800, 86400, 604800];
const PREVIEW_SECONDS = 180;

type AdminSession = { email: string; csrf: string };

const secureCookies = config.publicUrl.startsWith('https://');

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res: ServerResponse, name: string, value: string, maxAge: number): void {
  const prev = res.getHeader('Set-Cookie');
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  list.push(`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`);
  res.setHeader('Set-Cookie', list);
}

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), 'application/json');
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
  res.end();
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('Request too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  try {
    const v = JSON.parse((await readBody(req)) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function adminSession(req: IncomingMessage): AdminSession | null {
  const s = unsign<AdminSession>(cookies(req)[SESSION_COOKIE]);
  return s && emailAllowed(s.email) ? s : config.devLoginEmail && s ? s : null;
}

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (!path.startsWith('/rdclient/') && !path.startsWith('/assets/')) return false;
  const file = normalize(join(config.publicDir, path));
  if (!file.startsWith(normalize(config.publicDir)) || !existsSync(file) || !statSync(file).isFile()) return false;
  const type = TYPES[extname(file)];
  if (!type) return false;
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  createReadStream(file).pipe(res);
  return true;
}

function linkUrl(token: string): string {
  return `${config.publicUrl}/s#${token}`;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

async function adminApi(req: IncomingMessage, res: ServerResponse, path: string, s: AdminSession): Promise<void> {
  if (req.method !== 'GET' && req.headers['x-csrf'] !== s.csrf) return json(res, 403, { error: 'Bad request token. Reload the page.' });

  if (path === '/admin/api/status' && req.method === 'GET') {
    await ensureLink();
    const st = linkStatus();
    return json(res, 200, {
      ...st,
      cdUrl: config.cdUrl,
      rustdeskId: identity().id,
      deviceName: config.deviceName,
      ssoAvailable: true,
      ssoPending: ssoPending(),
    });
  }
  if (path === '/admin/api/sso' && req.method === 'POST') {
    try {
      return json(res, 200, { url: await startSso() });
    } catch (e) {
      return json(res, 400, { error: `Single sign-on could not start: ${(e as Error).message}` });
    }
  }
  if (path === '/admin/api/devices' && req.method === 'GET') {
    const list = await peers();
    const pw = devicesWithPassword();
    return json(res, 200, { devices: list.map((p) => ({ ...p, hasPassword: pw.has(p.id) })) });
  }
  const pwMatch = /^\/admin\/api\/devices\/([0-9A-Za-z_-]{1,40})\/password$/.exec(path);
  if (pwMatch && req.method === 'POST') {
    const body = await readJson(req);
    const pw = typeof body.password === 'string' ? body.password : '';
    setDevicePassword(pwMatch[1]!, pw ? encrypt(pw) : null);
    log('device_password', { device: pwMatch[1], by: s.email, set: !!pw });
    return json(res, 200, { ok: true });
  }
  if (path === '/admin/api/preview' && req.method === 'POST') {
    const body = await readJson(req);
    const device = String(body.device ?? '');
    const known = (await peers()).find((p) => p.id === device);
    if (!known) return json(res, 404, { error: 'That device is not visible to the service account.' });
    try {
      const probe = await probeDisplays(device);
      const displays = probe.displays.map((d) => {
        const token = randomToken();
        insertLink({
          kind: 'preview',
          token_hash: sha256Hex(token),
          label: 'preview',
          device_id: device,
          device_name: known.name,
          display: d.index,
          rights: JSON.stringify({}),
          max_viewers: 1,
          expires_at: Math.floor(Date.now() / 1000) + PREVIEW_SECONDS,
          created_by: s.email,
        });
        return { ...d, token };
      });
      return json(res, 200, { displays, needsAccept: probe.needsAccept });
    } catch (e) {
      return json(res, 502, { error: (e as Error).message });
    }
  }
  if (path === '/admin/api/links' && req.method === 'GET') {
    return json(res, 200, {
      links: activeLinks().map((l) => ({
        id: l.id,
        label: l.label,
        deviceName: l.device_name,
        deviceId: l.device_id,
        display: l.display,
        rights: permissionsFor(l),
        maxViewers: l.max_viewers,
        expiresAt: l.expires_at,
        viewers: [...live].filter((c) => c.linkId === l.id && c.conn === 'default').map((c) => ({ name: c.guestName, ip: c.ip, streaming: c.isStreaming })),
      })),
    });
  }
  if (path === '/admin/api/links' && req.method === 'POST') {
    const b = await readJson(req);
    const device = String(b.device ?? '');
    const known = (await peers()).find((p) => p.id === device);
    if (!known) return json(res, 404, { error: 'That device is not visible to the service account.' });
    const duration = DURATIONS.includes(Number(b.duration)) ? Number(b.duration) : 3600;
    const display = b.display === null || b.display === undefined ? null : clampInt(b.display, 0, 63, 0);
    const r = (b.rights ?? {}) as Partial<Rights>;
    const rights: Rights = { control: r.control === true, clipboard: r.clipboard === true, files: r.files === true, audio: r.audio === true, chat: r.chat === true };
    const token = randomToken();
    const id = insertLink({
      kind: 'share',
      token_hash: sha256Hex(token),
      label: String(b.label ?? '').trim().slice(0, 40) || known.name,
      device_id: device,
      device_name: known.name,
      display,
      rights: JSON.stringify(rights),
      max_viewers: clampInt(b.maxViewers, 1, 20, 1),
      expires_at: Math.floor(Date.now() / 1000) + duration,
      created_by: s.email,
    });
    log('link_created', { link: id, device, display, rights, by: s.email });
    return json(res, 200, { id, url: linkUrl(token) });
  }
  const endMatch = /^\/admin\/api\/links\/(\d+)\/end$/.exec(path);
  if (endMatch && req.method === 'POST') {
    const id = Number(endMatch[1]);
    revokeLink(id);
    endLink(id);
    log('link_ended', { link: id, by: s.email });
    return json(res, 200, { ok: true });
  }
  if (path === '/admin/api/log' && req.method === 'GET') {
    return json(res, 200, { sessions: recentSessions(100) });
  }
  return json(res, 404, { error: 'Not found.' });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;

  if (path === '/health') return send(res, 200, `ok ${live.size}\n`, 'text/plain');
  if (req.method === 'GET' && serveStatic(req, res, path)) return;

  // Guest side.
  if (path === '/s' && req.method === 'GET') return send(res, 200, sharePage({ thumb: false, version: VERSION }), undefined, { 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow' });
  if (path === '/p' && req.method === 'GET') {
    // Preview tiles inside the admin page only.
    if (!adminSession(req)) return send(res, 403, 'Forbidden', 'text/plain');
    return send(res, 200, sharePage({ thumb: true, version: VERSION }), undefined, { 'X-Frame-Options': 'SAMEORIGIN' });
  }
  if (path === '/s/info' && req.method === 'POST') {
    const b = await readJson(req);
    const token = String(b.token ?? '');
    const link = /^[a-f0-9]{64}$/.test(token) ? linkByTokenHash(sha256Hex(token)) : null;
    if (!linkUsable(link)) return json(res, 404, { error: link ? 'This share link has ended.' : 'This share link is not valid.' });
    if (link.kind === 'preview' && !adminSession(req)) return json(res, 404, { error: 'This share link is not valid.' });
    const p = permissionsFor(link);
    return json(res, 200, { label: link.kind === 'preview' ? '' : link.label, device_name: link.device_name, expires_at: link.expires_at, permissions: p });
  }

  // Admin sign-in.
  if (path === '/auth/login' && req.method === 'GET') {
    if (config.devLoginEmail) {
      setCookie(res, SESSION_COOKIE, sign({ email: config.devLoginEmail, csrf: randomToken(16) }, 12 * 3600), 12 * 3600);
      return redirect(res, '/admin');
    }
    try {
      const st = await startLogin();
      setCookie(res, OIDC_COOKIE, sign({ state: st.state, verifier: st.verifier }, 600), 600);
      return redirect(res, st.url);
    } catch (e) {
      return send(res, 502, messagePage('Sign-in unavailable', (e as Error).message));
    }
  }
  if (path === '/auth/callback' && req.method === 'GET') {
    const pending = unsign<{ state: string; verifier: string }>(cookies(req)[OIDC_COOKIE]);
    setCookie(res, OIDC_COOKIE, '', 0);
    const code = url.searchParams.get('code') ?? '';
    if (!pending || url.searchParams.get('state') !== pending.state || !code) {
      return send(res, 400, messagePage('Sign-in failed', url.searchParams.get('error_description') || 'The sign-in expired. Try again.', { href: '/auth/login', label: 'Sign in' }));
    }
    try {
      const email = await finishLogin(code, pending.verifier);
      if (!emailAllowed(email)) {
        log('admin_denied', { email });
        return send(res, 403, messagePage('No access', `${email} may not use this sidecar.`));
      }
      setCookie(res, SESSION_COOKIE, sign({ email, csrf: randomToken(16) }, 12 * 3600), 12 * 3600);
      log('admin_login', { email });
      return redirect(res, '/admin');
    } catch (e) {
      return send(res, 400, messagePage('Sign-in failed', (e as Error).message, { href: '/auth/login', label: 'Try again' }));
    }
  }
  if (path === '/auth/logout' && req.method === 'POST') {
    setCookie(res, SESSION_COOKIE, '', 0);
    return send(res, 200, messagePage('Signed out', 'You are signed out.', { href: '/auth/login', label: 'Sign in again' }));
  }

  // Admin pages.
  if (path === '/' || path === '/admin') {
    const s = adminSession(req);
    if (!s) return redirect(res, '/auth/login');
    const problems = configProblems();
    if (problems.length) return send(res, 500, messagePage('Configuration incomplete', problems.join(' ')));
    return send(res, 200, adminPage({ email: s.email, csrf: s.csrf, version: VERSION }), undefined, { 'X-Frame-Options': 'DENY' });
  }
  if (path.startsWith('/admin/api/')) {
    const s = adminSession(req);
    if (!s) return json(res, 401, { error: 'Signed out. Reload the page.' });
    return adminApi(req, res, path, s);
  }

  return send(res, 404, messagePage('Not found', 'There is nothing here.'));
}

function main(): void {
  const problems = configProblems();
  for (const p of problems) log('config_problem', { problem: p });
  if (config.secretKey.length < 32) process.exit(1);
  openDb();
  log('identity', { rustdesk_id: identity().id });
  const server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      log('request_failed', { path: req.url?.split('?')[0], error: e.message });
      if (!res.headersSent) json(res, 500, { error: 'Something went wrong.' });
      else res.end();
    });
  });
  attachGateway(server);
  server.listen(config.port, () => log('listening', { port: config.port, version: VERSION }));
  void ensureLink().then(() => log('cortendesk', { ...linkStatus() }));
  const stop = (): void => {
    shutdownGateway();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
