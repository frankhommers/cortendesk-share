// OIDC sign-in for the admin pages: authorization code with PKCE, then the
// email from the userinfo endpoint. Only emails on SHARE_ALLOWED_EMAILS get in.

import { createHash, randomBytes } from 'node:crypto';
import { config } from './config';

type Discovery = { authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string };
let discovery: Discovery | null = null;

async function discover(): Promise<Discovery> {
  if (discovery) return discovery;
  const res = await fetch(`${config.oidcIssuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OIDC discovery failed (HTTP ${res.status}).`);
  const d = (await res.json()) as Discovery;
  if (!d.authorization_endpoint || !d.token_endpoint || !d.userinfo_endpoint) throw new Error('OIDC discovery is missing endpoints.');
  discovery = d;
  return d;
}

export function redirectUri(): string {
  return `${config.publicUrl}/auth/callback`;
}

export type OidcStart = { url: string; state: string; verifier: string };

export async function startLogin(): Promise<OidcStart> {
  const d = await discover();
  const state = randomBytes(16).toString('hex');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: config.oidcClientId,
    redirect_uri: redirectUri(),
    scope: config.oidcScopes,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { url: `${d.authorization_endpoint}?${q}`, state, verifier };
}

/** Exchange the code and return the signed-in email, or throw. */
export async function finishLogin(code: string, verifier: string): Promise<string> {
  const d = await discover();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
    client_id: config.oidcClientId,
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (config.oidcClientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(config.oidcClientId)}:${encodeURIComponent(config.oidcClientSecret)}`).toString('base64')}`;
  }
  const tr = await fetch(d.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
  const tokens = (await tr.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!tr.ok || !tokens.access_token) throw new Error(tokens.error_description || tokens.error || `Token exchange failed (HTTP ${tr.status}).`);
  const ur = await fetch(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  const info = (await ur.json().catch(() => ({}))) as { email?: string; email_verified?: boolean };
  if (!ur.ok || typeof info.email !== 'string' || !info.email) throw new Error('The sign-in provider did not return an email address.');
  if (info.email_verified === false) throw new Error('The email address is not verified.');
  return info.email.toLowerCase();
}

export function emailAllowed(email: string): boolean {
  return config.allowedEmails.includes(email.toLowerCase());
}
