// CortenDesk share gateway.
//
// A share viewer's browser connects here (nginx bridges /share-gw on the
// console origin to this process on loopback). The gateway looks the share up
// in the console, opens the RustDesk session to the device itself — rendezvous,
// relay, signed key exchange, login with the stored password — and then passes
// plaintext RustDesk Messages between the two through the share's allowlist
// (./policy.ts). The viewer never sees the password, the login hash or the
// session keys, so it cannot reach the device except through this filter.
//
// Environment:
//   CORTENDESK_SHARE_GATEWAY_SECRET   shared with the console (required)
//   CORTENDESK_SHARE_GATEWAY_PORT     listen port on 127.0.0.1 (default 21190)
//   CORTENDESK_HTTP_PORT              console port on loopback (default 8080)
//   CORTENDESK_SHARE_GATEWAY_CONSOLE  console base URL override

import { createServer, type IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { Message } from '../gen/message';
import { computeLoginH1, loginHashFromH1 } from '../core/auth';
import { sodiumReady } from '../core/crypto';
import { CLIENT_VERSION, Session } from '../core/session';
import { WsStream, type WebSocketCtor } from '../transport/ws-stream';
import {
  ALL_DISPLAYS,
  buildShareLogin,
  captureSharedDisplay,
  connAllowed,
  DisplayGate,
  deniedPermissionMessages,
  fromDevice,
  fromViewer,
  normalizePermissions,
  type ShareConnKind,
  type SharePermissions,
} from './policy';

const SECRET = (process.env.CORTENDESK_SHARE_GATEWAY_SECRET ?? '').trim();
const PORT = Number(process.env.CORTENDESK_SHARE_GATEWAY_PORT ?? 21190);
const CONSOLE = (process.env.CORTENDESK_SHARE_GATEWAY_CONSOLE
  ?? `http://127.0.0.1:${process.env.CORTENDESK_HTTP_PORT ?? 8080}`).replace(/\/+$/, '');

const HELLO_TIMEOUT_MS = 10_000;
const CHECK_INTERVAL_MS = 4_000;
const PING_INTERVAL_MS = 25_000;
const MAX_VIEWER_BUFFER = 32 * 1024 * 1024;
const MAX_PENDING_BYTES = 256 * 1024;
const MAX_RELAY_BUFFER = 32 * 1024 * 1024;
const MAX_FRAME = 4 * 1024 * 1024;
const CONNECTS_PER_SHARE_PER_MIN = 30;
const CHECK_FAIL_CLOSED_MS = 30_000;
const FAILURES_PER_IP = 20;
const FAILURE_WINDOW_MS = 10 * 60_000;

type Resolved = {
  ok: true;
  share_id: number;
  session_id: number;
  peer_id: string;
  password: string;
  permissions: unknown;
  max_viewers: number;
  display?: number | null;
  expires_at: number;
  server_key: string;
  ws_id_url: string;
  ws_relay_url: string;
  signal_token: string;
  my_id: string;
  my_name: string;
};
type Refused = { ok: false; reason: string; message?: string };

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'share-gateway', event, ...fields }));
}

async function consoleCall<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${CONSOLE}/api/internal/share-gateway/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Share-Gateway-Secret': SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok && res.status !== 403 && res.status !== 404 && res.status !== 410) {
    throw new Error(`console ${path}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const CONN_KINDS: readonly ShareConnKind[] = ['default', 'fileTransfer', 'terminal', 'viewCamera'];

function tokenFrom(req: IncomingMessage): string | null {
  const header = req.headers['sec-websocket-protocol'];
  if (typeof header !== 'string') return null;
  for (const raw of header.split(',')) {
    const p = raw.trim();
    if (p.startsWith('cdshare.')) {
      const t = p.slice('cdshare.'.length);
      return /^[A-Za-z0-9]{32,128}$/.test(t) ? t : null;
    }
  }
  return null;
}

function clientIp(req: IncomingMessage): string {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real.slice(0, 64);
  return (req.socket.remoteAddress ?? '').slice(0, 64);
}

// Failed lookups per address, so a token cannot be guessed at line speed
// (it is 256 bits; this only keeps the console from being hammered).
const failures = new Map<string, number[]>();
function tooManyFailures(ip: string): boolean {
  const now = Date.now();
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  if (recent.length) failures.set(ip, recent);
  else failures.delete(ip);
  return recent.length >= FAILURES_PER_IP;
}

// Connection attempts per share, so one link cannot be used to flood the
// console with lookups and audit rows.
const shareConnects = new Map<number, number[]>();
function shareConnectAllowed(shareId: number): boolean {
  const now = Date.now();
  const recent = (shareConnects.get(shareId) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  shareConnects.set(shareId, recent);
  return recent.length <= CONNECTS_PER_SHARE_PER_MIN;
}

function sweepRateMaps(): void {
  const now = Date.now();
  for (const [ip, list] of failures) {
    const recent = list.filter((t) => now - t < FAILURE_WINDOW_MS);
    if (recent.length) failures.set(ip, recent);
    else failures.delete(ip);
  }
  for (const [id, list] of shareConnects) {
    const recent = list.filter((t) => now - t < 60_000);
    if (recent.length) shareConnects.set(id, recent);
    else shareConnects.delete(id);
  }
}
function noteFailure(ip: string): void {
  const list = failures.get(ip) ?? [];
  list.push(Date.now());
  failures.set(ip, list);
}

const live = new Set<ShareConnection>();

function randomSessionId(): bigint {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  b[0]! &= 0x7f;
  return new DataView(b.buffer).getBigUint64(0);
}

class ShareConnection {
  shareId = 0;
  conn: ShareConnKind = 'default';
  private sessionId = 0;
  private perms: SharePermissions = normalizePermissions({});
  private gate: DisplayGate = ALL_DISPLAYS;
  private share: Resolved | undefined;
  private session: Session | undefined;
  private ws1: WsStream | undefined;
  private ws2: WsStream | undefined;
  private hello: Message | undefined;
  private helloWaiter: ((m: Message | undefined) => void) | undefined;
  private streaming = false;
  private loginSent = false;
  private pending: Message[] = [];
  private pendingBytes = 0;
  private ip = '';
  get isStreaming(): boolean {
    return this.streaming;
  }
  get viewerIp(): string {
    return this.ip;
  }
  private ended = false;
  private droppedFromViewer = 0;
  private droppedFromDevice = 0;
  private readonly dropKinds = new Map<string, number>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly viewer: WebSocket,
    private readonly req: IncomingMessage,
  ) {}

  async start(): Promise<void> {
    const ip = clientIp(this.req);
    this.ip = ip;
    this.viewer.binaryType = 'nodebuffer';
    this.viewer.on('message', (data, isBinary) => this.onViewerFrame(data as Buffer, isBinary));
    this.viewer.on('close', () => this.end('viewer_closed'));
    this.viewer.on('error', () => this.end('viewer_error'));
    this.pingTimer = setInterval(() => {
      if (this.viewer.readyState === WebSocket.OPEN) this.viewer.ping();
    }, PING_INTERVAL_MS);

    const url = new URL(this.req.url ?? '/', 'http://gateway');
    const conn = url.searchParams.get('conn') ?? 'default';
    if (!CONN_KINDS.includes(conn as ShareConnKind)) return this.refuse('bad_request', 'Unknown connection type.');
    this.conn = conn as ShareConnKind;

    const token = tokenFrom(this.req);
    if (!token) return this.refuse('bad_request', 'This share link is not valid.');
    if (tooManyFailures(ip)) return this.refuse('rate_limited', 'Too many attempts. Try again later.');

    let res: Resolved | Refused;
    try {
      res = await consoleCall<Resolved | Refused>('resolve', {
        token,
        conn: this.conn,
        ip,
        user_agent: String(this.req.headers['user-agent'] ?? '').slice(0, 255),
      });
    } catch (e) {
      log('resolve_failed', { error: (e as Error).message });
      return this.refuse('unavailable', 'The share service is unavailable.');
    }
    if (this.ended) return;
    if (!res.ok) {
      noteFailure(ip);
      return this.refuse(res.reason, res.message ?? 'This share link is not valid or has expired.');
    }
    this.share = res;
    this.shareId = res.share_id;
    this.sessionId = res.session_id;
    this.perms = normalizePermissions(res.permissions);
    this.gate = DisplayGate.forShare(res.display, this.conn);

    if (!shareConnectAllowed(this.shareId)) {
      noteFailure(ip);
      return this.refuse('rate_limited', 'Too many attempts. Try again later.');
    }
    if (!connAllowed(this.conn, this.perms)) {
      noteFailure(ip);
      return this.refuse('not_allowed', 'This share does not allow that.');
    }
    const others = [...live].filter((c) => c !== this && c.shareId === this.shareId);
    const limit = Math.max(1, res.max_viewers);
    if (this.conn === 'default') {
      if (others.filter((c) => c.conn === 'default').length >= limit) {
        noteFailure(ip);
        return this.refuse('viewer_limit', 'This share link is already in use by the maximum number of viewers.');
      }
    } else {
      // Files, terminal and camera are side connections of a watching viewer:
      // they need a live screen session of this share from the same address,
      // and count against the same limit per kind.
      const hasScreen = others.some((c) => c.conn === 'default' && c.isStreaming && c.viewerIp === ip);
      if (!hasScreen || others.filter((c) => c.conn === this.conn).length >= limit) {
        noteFailure(ip);
        return this.refuse('viewer_limit', 'Open the shared screen first.');
      }
    }

    const msLeft = res.expires_at * 1000 - Date.now();
    if (msLeft <= 0) return this.refuse('expired', 'This share link has expired.');
    this.expiryTimer = setTimeout(() => this.closeWithReason('expired', 'This share link has expired.'), Math.min(msLeft, 2 ** 31 - 1));

    log('viewer_connected', { share: this.shareId, session: this.sessionId, conn: this.conn, ip });

    const hello = this.hello ?? (await new Promise<Message | undefined>((resolve) => {
      this.helloWaiter = resolve;
      setTimeout(() => resolve(undefined), HELLO_TIMEOUT_MS);
    }));
    this.helloWaiter = undefined;
    if (this.ended) return;
    if (hello?.union?.$case !== 'login_request') {
      noteFailure(ip);
      return this.refuse('bad_request', 'The viewer did not start the session.');
    }

    try {
      await sodiumReady();
      await this.openDevice(res);
    } catch (e) {
      log('device_connect_failed', { share: this.shareId, error: (e as Error).message });
      this.closeWithReason('device_unreachable', 'Could not reach the device.');
    }
  }

  private async openDevice(res: Resolved): Promise<void> {
    const Ws = WebSocket as unknown as WebSocketCtor;
    const ws1 = await WsStream.open(res.ws_id_url, Ws);
    if (this.ended) {
      ws1.close();
      return;
    }
    this.ws1 = ws1;
    const session = new Session(
      {
        peerId: res.peer_id,
        serverKeyB64: res.server_key,
        wsIdUrl: res.ws_id_url,
        wsRelayUrl: res.ws_relay_url,
        password: '',
        myId: res.my_id,
        myName: res.my_name,
        ...(res.signal_token ? { signalToken: res.signal_token } : {}),
        connType: this.conn,
      },
      {
        sendSignaling: (b) => this.ws1?.send(b),
        sendRelay: (b) => {
          if (this.ws2 && !this.ws2.isClosed) this.ws2.send(b);
        },
        relayBuffered: () => this.ws2?.buffered() ?? 0,
        openRelay: () => void this.openRelay(res.ws_relay_url),
        emit: (ev) => {
          if (ev.t === 'state' && ev.state === 'error') {
            this.closeWithReason('device_error', ev.detail || 'The connection to the device failed.');
          } else if (ev.t === 'state' && ev.state === 'closed') {
            this.closeWithReason('device_closed', ev.detail || 'The device ended the session.');
          }
        },
        onRawMessage: (msg) => void this.onDeviceMessage(msg),
        onVideo: () => {},
        onAudioFormat: () => {},
        onAudioFrame: () => {},
        closeAll: () => this.end('device_closed'),
      },
    );
    this.session = session;
    ws1.onMessage((b) => session.onSignalingBytes(b));
    ws1.onClose(() => {
      // The ID-server socket only matters until the relay pairs.
      if (!this.ws2) this.closeWithReason('device_unreachable', 'Lost the connection to the ID server.');
    });
    session.start();
  }

  private async openRelay(url: string): Promise<void> {
    try {
      const ws2 = await WsStream.open(url, WebSocket as unknown as WebSocketCtor);
      if (this.ended) {
        ws2.close();
        return;
      }
      this.ws2 = ws2;
      ws2.onMessage((b) => void this.session?.onRelayBytes(b));
      ws2.onClose(() => this.closeWithReason('device_closed', 'The device connection closed.'));
      this.session?.relayOpened();
    } catch (e) {
      log('relay_failed', { share: this.shareId, error: (e as Error).message });
      this.closeWithReason('device_unreachable', 'Could not reach the relay.');
    }
  }

  private async onDeviceMessage(msg: Message): Promise<void> {
    if (this.ended || !this.share) return;
    const u = msg.union;
    if (u?.$case === 'hash') {
      if (this.loginSent) return;
      this.loginSent = true;
      const pw = this.share.password;
      const hash = pw
        ? await loginHashFromH1(await computeLoginH1(pw, u.hash.salt), u.hash.challenge)
        : new Uint8Array(0);
      // The password is needed exactly once; drop our copy.
      this.share.password = '';
      const helloLogin = this.hello?.union?.$case === 'login_request' ? this.hello.union.login_request : undefined;
      const login = buildShareLogin(helloLogin, {
        peerId: this.share.peer_id,
        passwordHash: hash,
        myId: this.share.my_id,
        myName: this.share.my_name,
        sessionId: randomSessionId(),
        version: CLIENT_VERSION,
        conn: this.conn,
      }, this.perms);
      this.session?.sendRawMessage({ union: { $case: 'login_request', login_request: login } });
      return;
    }
    if (u?.$case === 'login_response') {
      const lr = u.login_response.union;
      if (lr?.$case === 'error') {
        if (lr.error === '2FA Required' || lr.error === 'Wrong 2FA Code') {
          this.closeWithReason('device_2fa', 'This device requires two-factor authentication, which screen sharing does not support.');
          return;
        }
        // Manual accept ("wait for the remote side to accept") passes through
        // so the viewer sees the waiting state; a refused password does too.
        this.toViewer(msg);
        return;
      }
      const v = fromDevice(msg, this.conn, this.perms, this.gate);
      if ('close' in v) return this.closeWithReason('display_missing', 'The shared display is not connected to the device.');
      if ('pass' in v) this.toViewer(v.pass);
      for (const m of deniedPermissionMessages(this.perms)) this.toViewer(m);
      // One display only: make the device stream that display, whatever it showed first.
      for (const m of captureSharedDisplay(this.gate)) this.session?.sendRawMessage(m);
      this.streaming = true;
      for (const m of this.pending.splice(0)) this.forwardFromViewer(m);
      log('streaming', { share: this.shareId, session: this.sessionId, conn: this.conn });
      return;
    }
    const v = fromDevice(msg, this.conn, this.perms, this.gate);
    if ('close' in v) return this.closeWithReason('display_missing', 'The shared display is not connected to the device.');
    if ('pass' in v) return this.toViewer(v.pass);
    this.droppedFromDevice++;
    const kind = `device: ${v.drop}`;
    this.dropKinds.set(kind, (this.dropKinds.get(kind) ?? 0) + 1);
  }

  private onViewerFrame(data: Buffer, isBinary: boolean): void {
    if (this.ended) return;
    if (!isBinary) return this.closeWithReason('bad_request', 'Unexpected data from the viewer.');
    let msg: Message;
    try {
      msg = Message.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } catch {
      return this.closeWithReason('bad_request', 'Malformed data from the viewer.');
    }
    if (!this.hello) {
      this.hello = msg;
      this.helloWaiter?.(msg);
      return;
    }
    if (!this.streaming) {
      // Held until the device has let us in; bounded by bytes, not count.
      this.pendingBytes += data.byteLength;
      if (this.pendingBytes > MAX_PENDING_BYTES) return this.closeWithReason('bad_request', 'Too much data before the session started.');
      if (this.share && !('pass' in fromViewer(msg, this.conn, this.perms, this.gate))) {
        this.droppedFromViewer++;
        return;
      }
      this.pending.push(msg);
      return;
    }
    this.forwardFromViewer(msg);
  }

  private forwardFromViewer(msg: Message): void {
    const v = fromViewer(msg, this.conn, this.perms, this.gate);
    if ('pass' in v) {
      if ((this.ws2?.buffered() ?? 0) > MAX_RELAY_BUFFER) {
        this.closeWithReason('device_slow', 'The device connection is too slow.');
        return;
      }
      this.session?.sendRawMessage(v.pass);
      return;
    }
    if (!('drop' in v)) return;
    this.droppedFromViewer++;
    this.dropKinds.set(v.drop, (this.dropKinds.get(v.drop) ?? 0) + 1);
    // One line per kind; the totals go into viewer_ended.
    if (this.dropKinds.get(v.drop) === 1) log('dropped', { share: this.shareId, session: this.sessionId, from: 'viewer', what: v.drop });
  }

  private toViewer(msg: Message): void {
    if (this.viewer.readyState !== WebSocket.OPEN) return;
    if (this.viewer.bufferedAmount > MAX_VIEWER_BUFFER) {
      this.closeWithReason('viewer_slow', 'The viewer connection is too slow.');
      return;
    }
    this.viewer.send(Message.encode(msg).finish());
  }

  /** Tell the viewer why, in a way the web client shows, then end. */
  closeWithReason(reason: string, text: string): void {
    if (this.ended) return;
    if (this.streaming) {
      this.toViewer({ union: { $case: 'misc', misc: { union: { $case: 'close_reason', close_reason: text } } } });
    } else {
      this.toViewer({ union: { $case: 'login_response', login_response: { union: { $case: 'error', error: text }, enable_trusted_devices: false } } });
    }
    this.end(reason);
  }

  private refuse(reason: string, text: string): void {
    this.closeWithReason(reason, text);
  }

  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    live.delete(this);
    this.helloWaiter?.(undefined);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      this.session?.disconnect();
    } catch {
      // already closed
    }
    this.ws1?.close();
    this.ws2?.close();
    // Give the last frame (the reason) a moment to flush.
    setTimeout(() => {
      try {
        this.viewer.close(4000, reason.slice(0, 100));
      } catch {
        this.viewer.terminate();
      }
    }, 150);
    if (this.share) this.share.password = '';
    if (this.sessionId) {
      log('viewer_ended', { share: this.shareId, session: this.sessionId, conn: this.conn, reason, dropped_viewer: this.droppedFromViewer, dropped_device: this.droppedFromDevice, dropped_kinds: Object.fromEntries(this.dropKinds) });
      consoleCall('ended', {
        session_id: this.sessionId,
        reason,
        dropped_viewer: this.droppedFromViewer,
        dropped_device: this.droppedFromDevice,
      }).catch((e: Error) => log('ended_report_failed', { error: e.message }));
    }
  }
}

let lastCheckOk = Date.now();

/**
 * Close sessions whose share was revoked, expired or deleted. Fails closed:
 * if the console cannot confirm the shares for CHECK_FAIL_CLOSED_MS, every
 * session ends, so a revoke can never be outlived by an outage.
 */
async function checkLive(): Promise<void> {
  const ids = [...new Set([...live].map((c) => c.shareId).filter((id) => id > 0))];
  if (ids.length === 0) {
    lastCheckOk = Date.now();
    return;
  }
  try {
    const res = await consoleCall<{ active?: number[] }>('check', { share_ids: ids });
    if (!Array.isArray(res.active)) throw new Error('check: unexpected answer');
    lastCheckOk = Date.now();
    const active = new Set(res.active ?? []);
    for (const c of [...live]) {
      if (c.shareId > 0 && !active.has(c.shareId)) c.closeWithReason('revoked', 'The owner ended this share.');
    }
  } catch (e) {
    log('check_failed', { error: (e as Error).message });
    if (Date.now() - lastCheckOk > CHECK_FAIL_CLOSED_MS) {
      for (const c of [...live]) {
        if (c.shareId > 0) c.closeWithReason('unavailable', 'The share service is unavailable.');
      }
    }
  }
}

function main(): void {
  if (SECRET.length < 32) {
    log('fatal', { error: 'CORTENDESK_SHARE_GATEWAY_SECRET is missing or too short' });
    process.exit(1);
  }
  const http = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`ok ${live.size}\n`);
      return;
    }
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('WebSocket only\n');
  });
  const wss = new WebSocketServer({
    server: http,
    maxPayload: MAX_FRAME,
    handleProtocols: (protocols) => (protocols.has('cdshare') ? 'cdshare' : false),
  });
  wss.on('connection', (ws, req) => {
    const c = new ShareConnection(ws, req);
    live.add(c);
    c.start().catch((e: Error) => {
      log('connection_failed', { error: e.message });
      c.end('internal_error');
    });
  });
  setInterval(() => void checkLive(), CHECK_INTERVAL_MS);
  setInterval(sweepRateMaps, 60_000);
  http.listen(PORT, '127.0.0.1', () => log('listening', { port: PORT, console: CONSOLE }));
  const stop = (): void => {
    for (const c of [...live]) c.closeWithReason('shutdown', 'The server is restarting.');
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
