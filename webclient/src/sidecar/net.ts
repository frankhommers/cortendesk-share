import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { config } from './config';

function normalize(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** The guest's address: the TCP peer, or X-Forwarded-For from a trusted proxy. */
export function clientIp(req: IncomingMessage): string {
  const peer = normalize(req.socket.remoteAddress ?? '');
  if (!config.trustedProxies.includes(peer) && !config.trustedProxies.includes('*')) return peer.slice(0, 64);
  const xff = req.headers['x-forwarded-for'];
  const chain = (typeof xff === 'string' ? xff : '').split(',').map((s) => normalize(s.trim())).filter((s) => isIP(s));
  // Walk from the right past trusted hops.
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!config.trustedProxies.includes(chain[i]!)) return chain[i]!.slice(0, 64);
  }
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && isIP(real.trim())) return normalize(real.trim());
  return (chain[0] ?? peer).slice(0, 64);
}
