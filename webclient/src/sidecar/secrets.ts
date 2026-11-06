// Hashing, encryption and signed cookies, all keyed from SHARE_SECRET_KEY.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config';

function subKey(purpose: string): Buffer {
  return createHmac('sha256', config.secretKey).update(`cortendesk-share:${purpose}`).digest();
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** AES-256-GCM; output is base64(iv | tag | ciphertext). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', subKey('device-password'), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

export function decrypt(blob: string): string | null {
  try {
    const raw = Buffer.from(blob, 'base64');
    const d = createDecipheriv('aes-256-gcm', subKey('device-password'), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** A value with an expiry and an HMAC, for cookies. */
export function sign(value: object, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ v: value, e: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const mac = createHmac('sha256', subKey('cookie')).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function unsign<T>(signed: string | undefined): T | null {
  if (!signed) return null;
  const [body, mac] = signed.split('.');
  if (!body || !mac) return null;
  const want = createHmac('sha256', subKey('cookie')).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { v: T; e: number };
    return parsed.e > Date.now() / 1000 ? parsed.v : null;
  } catch {
    return null;
  }
}
