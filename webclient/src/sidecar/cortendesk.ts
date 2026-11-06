// Talks to the CortenDesk console through its public client API only, the
// same calls a RustDesk app makes: sign in, list devices, read the server key.

import { randomBytes, randomInt } from 'node:crypto';
import { config } from './config';
import { kvGet, kvSet } from './db';

export type Peer = { id: string; name: string; hostname: string; os: string; online: boolean };

export type LinkStatus = {
  ok: boolean;
  via: 'password' | 'sso' | null;
  error: string | null;
  checkedAt: number;
};

const PENDING = 'No authed oidc is found';

let status: LinkStatus = { ok: false, via: null, error: 'Not checked yet.', checkedAt: 0 };
let serverKey: string | null = null;
let ssoPoll: { code: string; url: string; until: number } | null = null;

export function linkStatus(): LinkStatus {
  return status;
}

export function ssoPending(): { url: string } | null {
  return ssoPoll && ssoPoll.until > Date.now() ? { url: ssoPoll.url } : null;
}

/** The sidecar's own RustDesk identity, made on first boot. */
export function identity(): { id: string; uuid: string } {
  let id = kvGet('rd_id');
  let uuid = kvGet('rd_uuid');
  if (!id || !uuid) {
    id = String(randomInt(100_000_000, 999_999_999));
    uuid = randomBytes(16).toString('base64');
    kvSet('rd_id', id);
    kvSet('rd_uuid', uuid);
  }
  return { id, uuid };
}

export function accessToken(): string {
  return kvGet('cd_token') ?? '';
}

function deviceInfo(): Record<string, string> {
  return { os: 'linux', type: 'client', name: config.deviceName };
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown, token = accessToken()): Promise<{ status: number; json: any }> {
  const res = await fetch(`${config.cdUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function setStatus(ok: boolean, error: string | null, via: LinkStatus['via'] = status.via): void {
  status = { ok, via, error, checkedAt: Date.now() };
}

/** Sign in with the service account's password. */
async function passwordLogin(): Promise<boolean> {
  if (!config.cdUsername || !config.cdPassword) return false;
  const { id, uuid } = identity();
  const r = await call('POST', '/api/login', {
    username: config.cdUsername,
    password: config.cdPassword,
    id,
    uuid,
    type: 'account',
    deviceInfo: deviceInfo(),
  }, '');
  const token = r.json?.access_token;
  if (typeof token === 'string' && token) {
    kvSet('cd_token', token);
    kvSet('cd_via', 'password');
    setStatus(true, null, 'password');
    return true;
  }
  const err = typeof r.json?.error === 'string' ? r.json.error : r.json?.type === 'email_check' ? 'The account asks for a sign-in code (2FA or email verification), which the sidecar cannot answer.' : `Sign-in failed (HTTP ${r.status}).`;
  setStatus(false, `CortenDesk refused the service account: ${err}`, null);
  return false;
}

/** Check the link, signing in again when the token is missing or rejected. */
export async function ensureLink(): Promise<boolean> {
  try {
    if (accessToken()) {
      const r = await call('POST', '/api/currentUser', {});
      if (r.status === 200 && r.json && !r.json.error) {
        setStatus(true, null, (kvGet('cd_via') as LinkStatus['via']) ?? 'password');
        return true;
      }
      kvSet('cd_token', null);
    }
    if (await passwordLogin()) return true;
    if (!config.cdUsername) setStatus(false, 'Not connected to CortenDesk. Set CD_USERNAME and CD_PASSWORD, or sign the sidecar in with single sign-on.', null);
    return false;
  } catch (e) {
    setStatus(false, `CortenDesk is unreachable: ${(e as Error).message}`);
    return false;
  }
}

/** Start the client single sign-on flow; the admin opens the returned URL. */
export async function startSso(): Promise<string> {
  const { id, uuid } = identity();
  const r = await call('POST', '/api/oidc/auth', { id, uuid, deviceInfo: deviceInfo(), op: '' }, '');
  if (typeof r.json?.url !== 'string' || typeof r.json?.code !== 'string') {
    throw new Error(typeof r.json?.error === 'string' ? r.json.error : `HTTP ${r.status}`);
  }
  ssoPoll = { code: r.json.code, url: r.json.url, until: Date.now() + 180_000 };
  void pollSso();
  return r.json.url;
}

async function pollSso(): Promise<void> {
  const { id, uuid } = identity();
  while (ssoPoll && ssoPoll.until > Date.now()) {
    await new Promise((res) => setTimeout(res, 1500));
    const p = ssoPoll;
    if (!p) return;
    try {
      const q = new URLSearchParams({ code: p.code, id, uuid });
      const r = await call('GET', `/api/oidc/auth-query?${q}`, undefined, '');
      const token = r.json?.access_token;
      if (typeof token === 'string' && token) {
        kvSet('cd_token', token);
        kvSet('cd_via', 'sso');
        setStatus(true, null, 'sso');
        ssoPoll = null;
        return;
      }
      if (typeof r.json?.error === 'string' && r.json.error !== PENDING) {
        setStatus(false, `Single sign-on failed: ${r.json.error}`, null);
        ssoPoll = null;
        return;
      }
    } catch {
      // keep polling
    }
  }
  ssoPoll = null;
}

/** Devices the service account can see. */
export async function peers(): Promise<Peer[]> {
  if (!(await ensureLink())) return [];
  const out: Peer[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await call('GET', `/api/peers?current=${page}&pageSize=500`);
    if (r.status === 401) {
      kvSet('cd_token', null);
      setStatus(false, 'CortenDesk no longer accepts the sidecar token.');
      return out;
    }
    const data = Array.isArray(r.json?.data) ? r.json.data : [];
    for (const d of data) {
      out.push({
        id: String(d.id ?? ''),
        name: String(d.alias || d.info?.device_name || d.id || ''),
        hostname: String(d.info?.device_name ?? ''),
        os: String(d.info?.os ?? ''),
        online: d.status === 1,
      });
    }
    if (out.length >= Number(r.json?.total ?? 0) || data.length === 0) break;
  }
  return out.filter((p) => p.id && p.id !== identity().id);
}

/** The server's public key, for the signed key exchange with devices. */
export async function getServerKey(): Promise<string> {
  if (serverKey) return serverKey;
  if (!(await ensureLink())) throw new Error(status.error ?? 'Not connected to CortenDesk.');
  const r = await call('POST', '/api/server-config', {});
  const key = r.json?.data?.key;
  if (typeof key !== 'string') throw new Error('CortenDesk did not return the server key.');
  serverKey = key;
  return key;
}
