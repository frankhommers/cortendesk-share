import { dirname, resolve } from 'node:path';
// Settings from the environment. Nothing about a particular install lives in
// the code or the image.

function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

function wsFrom(httpUrl: string, path: string): string {
  if (!httpUrl) return '';
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = path;
  u.search = '';
  return u.toString();
}

const cdUrl = trimSlash(env('CD_URL'));

export const config = {
  port: Number(env('PORT', '8090')),
  host: env('HOST', '0.0.0.0'),
  dataDir: env('DATA_DIR', '/data'),
  publicDir: env('PUBLIC_DIR') || resolve(dirname(process.argv[1] ?? '/app/dist/sidecar.mjs'), '../public'),
  publicUrl: trimSlash(env('SHARE_PUBLIC_URL')),
  secretKey: env('SHARE_SECRET_KEY'),
  cdUrl,
  cdUsername: env('CD_USERNAME'),
  cdPassword: env('CD_PASSWORD'),
  wsIdUrl: env('CD_WS_ID_URL') || wsFrom(cdUrl, '/ws/id'),
  wsRelayUrl: env('CD_WS_RELAY_URL') || wsFrom(cdUrl, '/ws/relay'),
  oidcIssuer: trimSlash(env('OIDC_ISSUER')),
  oidcClientId: env('OIDC_CLIENT_ID'),
  oidcClientSecret: env('OIDC_CLIENT_SECRET'),
  oidcScopes: env('OIDC_SCOPES', 'openid email profile'),
  allowedEmails: env('SHARE_ALLOWED_EMAILS')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  trustedProxies: env('TRUSTED_PROXIES', '127.0.0.1,::1')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean),
  deviceName: env('SHARE_DEVICE_NAME', 'RustdeskShare'),
  // Development only: skip OIDC and sign in as this email.
  devLoginEmail: env('DEV_LOGIN_EMAIL'),
};

export function configProblems(): string[] {
  const p: string[] = [];
  if (config.secretKey.length < 32) p.push('SHARE_SECRET_KEY must be at least 32 characters.');
  if (!config.cdUrl) p.push('CD_URL is not set.');
  if (!config.publicUrl) p.push('SHARE_PUBLIC_URL is not set.');
  if (!config.devLoginEmail) {
    if (!config.oidcIssuer || !config.oidcClientId) p.push('OIDC_ISSUER and OIDC_CLIENT_ID must be set.');
    if (config.allowedEmails.length === 0) p.push('SHARE_ALLOWED_EMAILS is empty, so nobody can sign in.');
  }
  return p;
}
