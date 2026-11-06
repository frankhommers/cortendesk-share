// The share gateway. A guest's browser connects here; the gateway opens the
// RustDesk session to the device itself (rendezvous, relay, signed key
// exchange, login with the stored password) and then passes plaintext
// RustDesk messages both ways through the link's allowlist
// (../gateway/policy.ts). The guest never sees the password, the login hash
// or the session keys, so it cannot reach the device except through this
// filter. Adapted from the CortenDesk fork's gateway (feature/share-links-gateway).

import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { Message, LoginRequest } from '../gen/message';
import { computeLoginH1, loginHashFromH1 } from '../core/auth';
import { sodiumReady } from '../core/crypto';
import { CLIENT_VERSION, Session } from '../core/session';
import { WsStream, type WebSocketCtor } from '../transport/ws-stream';
import {
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
} from '../gateway/policy';
import { config } from './config';
import { accessToken, getServerKey, identity } from './cortendesk';
import { endSession, getDevicePassword, linkById, linkByTokenHash, linkUsable, startSession, touchLink, type LinkRow, type Rights } from './db';
import { clientIp } from './net';
import { decrypt, sha256Hex } from './secrets';

const HELLO_TIMEOUT_MS = 10_000;
const CHECK_INTERVAL_MS = 3_000;
const PING_INTERVAL_MS = 25_000;
const MAX_VIEWER_BUFFER = 32 * 1024 * 1024;
const MAX_PENDING_BYTES = 256 * 1024;
const MAX_RELAY_BUFFER = 32 * 1024 * 1024;
const MAX_FRAME = 4 * 1024 * 1024;
const CONNECTS_PER_LINK_PER_MIN = 30;
const FAILURES_PER_IP = 20;
const FAILURE_WINDOW_MS = 10 * 60_000;
const NAME_MAX = 40;

export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'cortendesk-share', event, ...fields }));
}

export function permissionsFor(link: LinkRow): SharePermissions {
  let r: Partial<Rights> = {};
  try {
    r = JSON.parse(link.rights) as Partial<Rights>;
  } catch {
    r = {};
  }
  // Terminal and camera never go through a share.
  return normalizePermissions({ ...r, terminal: false, camera: false });
}

/** `RustdeskShare · <label> · <guest> · <ip>`, as the device shows it. */
export function rustdeskName(label: string, guest: string, ip: string): string {
  const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f·]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = [config.deviceName, clean(label).slice(0, 40), clean(guest).slice(0, NAME_MAX) || 'Guest', ip].filter(Boolean);
  return parts.join(' · ').slice(0, 120);
}

const CONN_KINDS: readonly ShareConnKind[] = ['default', 'fileTransfer'];

function tokenFrom(req: IncomingMessage): string | null {
  const header = req.headers['sec-websocket-protocol'];
  if (typeof header !== 'string') return null;
  for (const raw of header.split(',')) {
    const p = raw.trim();
    if (p.startsWith('cdshare.')) {
      const t = p.slice('cdshare.'.length);
      return /^[a-f0-9]{64}$/.test(t) ? t : null;
    }
  }
  return null;
}

const failures = new Map<string, number[]>();
function tooManyFailures(ip: string): boolean {
  const now = Date.now();
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  if (recent.length) failures.set(ip, recent);
  else failures.delete(ip);
  return recent.length >= FAILURES_PER_IP;
}
function noteFailure(ip: string): void {
  const list = failures.get(ip) ?? [];
  list.push(Date.now());
  failures.set(ip, list);
}
const linkConnects = new Map<number, number[]>();
function linkConnectAllowed(id: number): boolean {
  const now = Date.now();
  const recent = (linkConnects.get(id) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  linkConnects.set(id, recent);
  return recent.length <= CONNECTS_PER_LINK_PER_MIN;
}
function sweepRateMaps(): void {
  const now = Date.now();
  for (const [k, list] of failures) {
    const recent = list.filter((t) => now - t < FAILURE_WINDOW_MS);
    if (recent.length) failures.set(k, recent);
    else failures.delete(k);
  }
  for (const [k, list] of linkConnects) {
    const recent = list.filter((t) => now - t < 60_000);
    if (recent.length) linkConnects.set(k, recent);
    else linkConnects.delete(k);
  }
}

export const live = new Set<ShareConnection>();

function randomSessionId(): bigint {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  b[0]! &= 0x7f;
  return new DataView(b.buffer).getBigUint64(0);
}

type DeviceTarget = { peerId: string; password: string; myName: string; conn: ShareConnKind };

/**
 * One RustDesk session from the gateway to a device: rendezvous, relay and
 * the encrypted channel. Messages after the handshake go to onMessage.
 */
class DeviceLink {
  session: Session | undefined;
  private ws1: WsStream | undefined;
  private ws2: WsStream | undefined;
  private closed = false;

  constructor(
    private readonly target: DeviceTarget,
    private readonly onMessage: (m: Message) => void,
    private readonly onEnd: (reason: string, text: string) => void,
  ) {}

  async open(): Promise<void> {
    await sodiumReady();
    const serverKey = await getServerKey();
    const Ws = WebSocket as unknown as WebSocketCtor;
    const ws1 = await WsStream.open(config.wsIdUrl, Ws);
    if (this.closed) {
      ws1.close();
      return;
    }
    this.ws1 = ws1;
    const token = accessToken();
    const session = new Session(
      {
        peerId: this.target.peerId,
        serverKeyB64: serverKey,
        wsIdUrl: config.wsIdUrl,
        wsRelayUrl: config.wsRelayUrl,
        password: '',
        myId: identity().id,
        myName: this.target.myName,
        ...(token ? { signalToken: token } : {}),
        connType: this.target.conn,
      },
      {
        sendSignaling: (b) => this.ws1?.send(b),
        sendRelay: (b) => {
          if (this.ws2 && !this.ws2.isClosed) this.ws2.send(b);
        },
        relayBuffered: () => this.ws2?.buffered() ?? 0,
        openRelay: () => void this.openRelay(),
        emit: (ev) => {
          if (ev.t === 'state' && ev.state === 'error') this.onEnd('device_error', ev.detail || 'The connection to the device failed.');
          else if (ev.t === 'state' && ev.state === 'closed') this.onEnd('device_closed', ev.detail || 'The device ended the session.');
        },
        onRawMessage: (msg) => this.onMessage(msg),
        onVideo: () => {},
        onAudioFormat: () => {},
        onAudioFrame: () => {},
        closeAll: () => this.onEnd('device_closed', 'The device ended the session.'),
      },
    );
    this.session = session;
    ws1.onMessage((b) => session.onSignalingBytes(b));
    ws1.onClose(() => {
      if (!this.ws2) this.onEnd('device_unreachable', 'Lost the connection to the ID server.');
    });
    session.start();
  }

  private async openRelay(): Promise<void> {
    try {
      const ws2 = await WsStream.open(config.wsRelayUrl, WebSocket as unknown as WebSocketCtor);
      if (this.closed) {
        ws2.close();
        return;
      }
      this.ws2 = ws2;
      ws2.onMessage((b) => void this.session?.onRelayBytes(b));
      ws2.onClose(() => this.onEnd('device_closed', 'The device connection closed.'));
      this.session?.relayOpened();
    } catch (e) {
      log('relay_failed', { error: (e as Error).message });
      this.onEnd('device_unreachable', 'Could not reach the relay.');
    }
  }

  relayBuffered(): number {
    return this.ws2?.buffered() ?? 0;
  }

  send(m: Message): void {
    this.session?.sendRawMessage(m);
  }

  /** Answer the device's hash with the login (password used once). */
  async login(salt: string, challenge: string, hello: LoginRequest | undefined, perms: SharePermissions): Promise<void> {
    const pw = this.target.password;
    const hash = pw ? await loginHashFromH1(await computeLoginH1(pw, salt), challenge) : new Uint8Array(0);
    this.target.password = '';
    const login = buildShareLogin(
      hello,
      {
        peerId: this.target.peerId,
        passwordHash: hash,
        myId: identity().id,
        myName: this.target.myName,
        sessionId: randomSessionId(),
        version: CLIENT_VERSION,
        conn: this.target.conn,
      },
      perms,
    );
    this.send({ union: { $case: 'login_request', login_request: login } });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.target.password = '';
    try {
      this.session?.disconnect();
    } catch {
      // already closed
    }
    this.ws1?.close();
    this.ws2?.close();
  }
}

function devicePassword(deviceId: string): string {
  const blob = getDevicePassword(deviceId);
  return blob ? (decrypt(blob) ?? '') : '';
}

export class ShareConnection {
  linkId = 0;
  conn: ShareConnKind = 'default';
  guestName = '';
  private sessionId = 0;
  private perms: SharePermissions = normalizePermissions({});
  private gate: DisplayGate = DisplayGate.forShare(null, 'default');
  private link: LinkRow | undefined;
  private device: DeviceLink | undefined;
  private hello: Message | undefined;
  private helloWaiter: ((m: Message | undefined) => void) | undefined;
  private streaming = false;
  private loginSent = false;
  private pending: Message[] = [];
  private pendingBytes = 0;
  ip = '';
  private ended = false;
  private droppedFromViewer = 0;
  private droppedFromDevice = 0;
  private readonly dropKinds = new Map<string, number>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  startedAt = Date.now();

  get isStreaming(): boolean {
    return this.streaming;
  }

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
    if (!CONN_KINDS.includes(conn as ShareConnKind)) return this.closeWithReason('bad_request', 'This share does not allow that.');
    this.conn = conn as ShareConnKind;
    this.guestName = (url.searchParams.get('name') ?? '').slice(0, NAME_MAX);

    const token = tokenFrom(this.req);
    if (!token) return this.closeWithReason('bad_request', 'This share link is not valid.');
    if (tooManyFailures(ip)) return this.closeWithReason('rate_limited', 'Too many attempts. Try again later.');

    const link = linkByTokenHash(sha256Hex(token));
    if (!linkUsable(link)) {
      noteFailure(ip);
      return this.closeWithReason('link_invalid', link ? 'This share link has ended.' : 'This share link is not valid.');
    }
    this.link = link;
    this.linkId = link.id;
    this.perms = permissionsFor(link);
    this.gate = DisplayGate.forShare(link.display, this.conn);

    if (!linkConnectAllowed(link.id)) {
      noteFailure(ip);
      return this.closeWithReason('rate_limited', 'Too many attempts. Try again later.');
    }
    if (!connAllowed(this.conn, this.perms)) {
      noteFailure(ip);
      return this.closeWithReason('not_allowed', 'This share does not allow that.');
    }
    const others = [...live].filter((c) => c !== this && c.linkId === link.id && !c.ended);
    const limit = Math.max(1, link.max_viewers);
    if (this.conn === 'default') {
      if (others.filter((c) => c.conn === 'default').length >= limit) {
        return this.closeWithReason('viewer_limit', 'This share link is already in use by the maximum number of viewers.');
      }
    } else {
      // File transfer is a side connection of a watching guest from the same address.
      const hasScreen = others.some((c) => c.conn === 'default' && c.isStreaming && c.ip === ip);
      if (!hasScreen || others.filter((c) => c.conn === this.conn).length >= limit) {
        return this.closeWithReason('viewer_limit', 'Open the shared screen first.');
      }
    }

    const msLeft = link.expires_at * 1000 - Date.now();
    this.expiryTimer = setTimeout(() => this.closeWithReason('expired', 'This share link has expired.'), Math.min(msLeft, 2 ** 31 - 1));

    this.sessionId = startSession({
      link_id: link.id,
      guest_name: this.guestName,
      ip,
      user_agent: String(this.req.headers['user-agent'] ?? '').slice(0, 250),
      conn: this.conn,
    });
    touchLink(link.id);
    log('viewer_connected', { link: link.id, session: this.sessionId, conn: this.conn, ip, name: this.guestName });

    const hello = this.hello ?? (await new Promise<Message | undefined>((resolve) => {
      this.helloWaiter = resolve;
      setTimeout(() => resolve(undefined), HELLO_TIMEOUT_MS);
    }));
    this.helloWaiter = undefined;
    if (this.ended) return;
    if (hello?.union?.$case !== 'login_request') {
      noteFailure(ip);
      return this.closeWithReason('bad_request', 'The viewer did not start the session.');
    }

    const myName = link.kind === 'preview' ? `${config.deviceName} · preview` : rustdeskName(link.label, this.guestName, ip);
    this.device = new DeviceLink(
      { peerId: link.device_id, password: devicePassword(link.device_id), myName, conn: this.conn },
      (m) => void this.onDeviceMessage(m),
      (reason, text) => this.closeWithReason(reason, text),
    );
    try {
      await this.device.open();
    } catch (e) {
      log('device_connect_failed', { link: link.id, error: (e as Error).message });
      this.closeWithReason('device_unreachable', 'Could not reach the device.');
    }
  }

  private async onDeviceMessage(msg: Message): Promise<void> {
    if (this.ended || !this.link) return;
    const u = msg.union;
    if (u?.$case === 'hash') {
      if (this.loginSent) return;
      this.loginSent = true;
      const helloLogin = this.hello?.union?.$case === 'login_request' ? this.hello.union.login_request : undefined;
      await this.device?.login(u.hash.salt, u.hash.challenge, helloLogin, this.perms);
      return;
    }
    if (u?.$case === 'login_response') {
      const lr = u.login_response.union;
      if (lr?.$case === 'error') {
        if (lr.error === '2FA Required' || lr.error === 'Wrong 2FA Code') {
          this.closeWithReason('device_2fa', 'This device requires two-factor authentication, which screen sharing does not support.');
          return;
        }
        // Waiting for Accept, or a refused password: the guest sees it.
        this.toViewer(msg);
        return;
      }
      const v = fromDevice(msg, this.conn, this.perms, this.gate);
      if ('close' in v) return this.closeWithReason('display_missing', 'The shared display is not connected to the device.');
      if ('pass' in v) this.toViewer(v.pass);
      for (const m of deniedPermissionMessages(this.perms)) this.toViewer(m);
      for (const m of captureSharedDisplay(this.gate)) this.device?.send(m);
      this.streaming = true;
      for (const m of this.pending.splice(0)) this.forwardFromViewer(m);
      log('streaming', { link: this.linkId, session: this.sessionId, conn: this.conn });
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
      this.pendingBytes += data.byteLength;
      if (this.pendingBytes > MAX_PENDING_BYTES) return this.closeWithReason('bad_request', 'Too much data before the session started.');
      if (this.link && !('pass' in fromViewer(msg, this.conn, this.perms, this.gate))) {
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
      if ((this.device?.relayBuffered() ?? 0) > MAX_RELAY_BUFFER) {
        this.closeWithReason('device_slow', 'The device connection is too slow.');
        return;
      }
      this.device?.send(v.pass);
      return;
    }
    if (!('drop' in v)) return;
    this.droppedFromViewer++;
    this.dropKinds.set(v.drop, (this.dropKinds.get(v.drop) ?? 0) + 1);
    if (this.dropKinds.get(v.drop) === 1) log('dropped', { link: this.linkId, session: this.sessionId, from: 'viewer', what: v.drop });
  }

  private toViewer(msg: Message): void {
    if (this.viewer.readyState !== WebSocket.OPEN) return;
    if (this.viewer.bufferedAmount > MAX_VIEWER_BUFFER) {
      this.closeWithReason('viewer_slow', 'The viewer connection is too slow.');
      return;
    }
    this.viewer.send(Message.encode(msg).finish());
  }

  /** Tell the guest why, in a way the web client shows, then end. */
  closeWithReason(reason: string, text: string): void {
    if (this.ended) return;
    if (this.streaming) {
      this.toViewer({ union: { $case: 'misc', misc: { union: { $case: 'close_reason', close_reason: text } } } });
    } else {
      this.toViewer({ union: { $case: 'login_response', login_response: { union: { $case: 'error', error: text }, enable_trusted_devices: false } } });
    }
    this.end(reason);
  }

  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    live.delete(this);
    this.helloWaiter?.(undefined);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.device?.close();
    setTimeout(() => {
      try {
        this.viewer.close(4000, reason.slice(0, 100));
      } catch {
        this.viewer.terminate();
      }
    }, 150);
    if (this.sessionId) {
      endSession(this.sessionId, reason, this.droppedFromViewer + this.droppedFromDevice);
      log('viewer_ended', {
        link: this.linkId,
        session: this.sessionId,
        conn: this.conn,
        reason,
        dropped_viewer: this.droppedFromViewer,
        dropped_device: this.droppedFromDevice,
        dropped_kinds: Object.fromEntries(this.dropKinds),
      });
    }
  }
}

/** End every guest of a link at once (the owner pressed End). */
export function endLink(linkId: number, text = 'The owner ended this share.'): void {
  for (const c of [...live]) if (c.linkId === linkId) c.closeWithReason('revoked', text);
}

/** Safety net: close guests whose link was revoked or expired. */
function sweepLive(): void {
  const seen = new Map<number, boolean>();
  for (const c of [...live]) {
    if (!c.linkId) continue;
    if (!seen.has(c.linkId)) seen.set(c.linkId, linkUsable(linkById(c.linkId)));
    if (!seen.get(c.linkId)) c.closeWithReason('revoked', 'This share link has ended.');
  }
}

export type DisplayInfo = { index: number; width: number; height: number; name: string; primary: boolean };

/**
 * Connect to a device view-only, read its display list from the login
 * answer and disconnect. Used for the screen picker.
 */
export function probeDisplays(deviceId: string): Promise<{ displays: DisplayInfo[]; needsAccept: boolean }> {
  return new Promise((resolve, reject) => {
    const perms = normalizePermissions({});
    const password = devicePassword(deviceId);
    let done = false;
    let link: DeviceLink;
    const finish = (err: Error | null, value?: { displays: DisplayInfo[]; needsAccept: boolean }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      link.close();
      if (err) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error(password ? 'The device did not answer in time.' : 'Nobody accepted the connection on the device in time.')), password ? 20_000 : 60_000);
    link = new DeviceLink(
      { peerId: deviceId, password, myName: `${config.deviceName} · preview`, conn: 'default' },
      (msg) => {
        const u = msg.union;
        if (u?.$case === 'hash') {
          void link.login(u.hash.salt, u.hash.challenge, undefined, perms);
          return;
        }
        if (u?.$case === 'login_response') {
          const lr = u.login_response.union;
          if (lr?.$case === 'peer_info') {
            const pi = lr.peer_info;
            finish(null, {
              needsAccept: !password,
              displays: pi.displays.map((d, i) => ({
                index: i,
                width: d.width,
                height: d.height,
                name: d.name,
                primary: i === pi.current_display,
              })),
            });
          } else if (lr?.$case === 'error') {
            log('probe_login_error', { device: deviceId, error: lr.error });
            if (/wrong password/i.test(lr.error) && password) finish(new Error('The stored password was refused by the device.'));
            else if (!/wait/i.test(lr.error)) finish(new Error(lr.error));
          }
        }
      },
      (_reason, text) => finish(new Error(text)),
    );
    link.open().catch((e: Error) => finish(e));
  });
}

export function attachGateway(server: import('node:http').Server): void {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME,
    handleProtocols: (protocols) => (protocols.has('cdshare') ? 'cdshare' : false),
  });
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== '/gw') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c = new ShareConnection(ws, req);
      live.add(c);
      c.start().catch((e: Error) => {
        log('connection_failed', { error: e.message });
        c.end('internal_error');
      });
    });
  });
  setInterval(sweepLive, CHECK_INTERVAL_MS);
  setInterval(sweepRateMaps, 60_000);
}

export function shutdownGateway(): void {
  for (const c of [...live]) c.closeWithReason('shutdown', 'The server is restarting.');
}
