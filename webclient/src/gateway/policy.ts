// Share-link policy: what may pass between a share viewer and the device.
//
// The share gateway holds the RustDesk session; the viewer only ever talks to
// the gateway. Every Message in either direction goes through these filters.
// Both directions are allowlists: a message type not named here is dropped.
// Pure functions, no I/O, so the whole boundary is unit-testable.

import {
  CaptureDisplays,
  DisplayInfo,
  LoginRequest,
  Message,
  Misc,
  OptionMessage,
  OptionMessage_BoolOption,
  PeerInfo,
  PermissionInfo_Permission,
  SwitchDisplay,
} from '../gen/message';

export type SharePermissions = {
  control: boolean;
  clipboard: boolean;
  files: boolean;
  terminal: boolean;
  camera: boolean;
  audio: boolean;
  chat: boolean;
};

export type ShareConnKind = 'default' | 'fileTransfer' | 'terminal' | 'viewCamera';

export const NO_PERMISSIONS: SharePermissions = {
  control: false,
  clipboard: false,
  files: false,
  terminal: false,
  camera: false,
  audio: false,
  chat: false,
};

/** Normalise untrusted input (the console's JSON) into a full permission set. */
export function normalizePermissions(raw: unknown): SharePermissions {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const on = (k: keyof SharePermissions): boolean => r[k] === true;
  return {
    control: on('control'),
    clipboard: on('clipboard'),
    files: on('files'),
    terminal: on('terminal'),
    camera: on('camera'),
    audio: on('audio'),
    chat: on('chat'),
  };
}

/** May a connection of this kind be opened at all under these permissions? */
export function connAllowed(conn: ShareConnKind, p: SharePermissions): boolean {
  switch (conn) {
    case 'default':
      return true;
    case 'fileTransfer':
      return p.files;
    case 'terminal':
      return p.terminal;
    case 'viewCamera':
      return p.camera;
  }
}

/**
 * A share limited to one display. The viewer sees that display as its only
 * one, at index 0; the gateway translates indices both ways, drops video and
 * display switches for every other display, and keeps absolute mouse
 * positions inside the shared display's rectangle.
 *
 * `device` is the device's own display index, or null for every display. Only
 * the screen connection is gated: on a camera connection "displays" are cameras.
 */
export class DisplayGate {
  /** The shared display's area in the device's desktop coordinates, once known. */
  rect: { x: number; y: number; width: number; height: number; scale: number } | undefined;

  constructor(readonly device: number | null) {}

  static forShare(display: unknown, conn: ShareConnKind): DisplayGate {
    const ok = typeof display === 'number' && Number.isSafeInteger(display) && display >= 0 && display < 64;
    return new DisplayGate(ok && conn === 'default' ? display : null);
  }

  get limited(): boolean {
    return this.device !== null;
  }

  learn(d: { x: number; y: number; width: number; height: number; scale?: number }): void {
    const scale = typeof d.scale === 'number' && Number.isFinite(d.scale) && d.scale > 0 ? d.scale : 1;
    this.rect = { x: d.x, y: d.y, width: d.width, height: d.height, scale };
  }

  /** Viewer index -> device index; undefined when the viewer names another display. */
  toDevice(i: number): number | undefined {
    if (this.device === null) return i;
    return i === 0 ? this.device : undefined;
  }

  /** Device index -> viewer index; undefined for a display the viewer may not see. */
  toViewer(i: number): number | undefined {
    if (this.device === null) return i;
    return i === this.device ? 0 : undefined;
  }

  /** Clamp an absolute desktop position into the shared display. */
  clamp(x: number, y: number): { x: number; y: number } | undefined {
    const r = this.rect;
    if (!r || r.width <= 0 || r.height <= 0) return undefined;
    const cl = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
    return { x: cl(x, r.x, r.x + r.width - 1), y: cl(y, r.y, r.y + r.height - 1) };
  }

  /** Is a cursor position inside the shared display? Same maths as the client's cursor overlay. */
  contains(x: number, y: number): boolean {
    const r = this.rect;
    if (!r) return false;
    const lx = (x - r.x) * r.scale;
    const ly = (y - r.y) * r.scale;
    return lx >= 0 && ly >= 0 && lx < r.width && ly < r.height;
  }
}

/** Every display, for callers that do not limit them. */
export const ALL_DISPLAYS = new DisplayGate(null);

/** Mouse types (low 3 bits of MouseEvent.mask) that carry an absolute position. */
const MOUSE_ABSOLUTE = new Set([0, 1, 2]); // move, down, up
const MOUSE_MOVE_RELATIVE = 5;

/**
 * The misc messages the gateway sends the device right after login, so it
 * streams the shared display and nothing else.
 */
export function captureSharedDisplay(gate: DisplayGate): Message[] {
  if (gate.device === null) return [];
  const misc = (union: Misc['union']): Message => ({ union: { $case: 'misc', misc: { union } } });
  return [
    misc({ $case: 'switch_display', switch_display: SwitchDisplay.fromPartial({ display: gate.device }) }),
    misc({ $case: 'capture_displays', capture_displays: CaptureDisplays.fromPartial({ set: [gate.device] }) }),
  ];
}

const YES = OptionMessage_BoolOption.Yes;
const NO = OptionMessage_BoolOption.No;
const NOT_SET = OptionMessage_BoolOption.NotSet;

/**
 * A "disable X" option the viewer asks for. Turning X off is always fine;
 * turning it on (No = not disabled) only when the share allows X.
 */
function disableOpt(v: OptionMessage_BoolOption, allowed: boolean): OptionMessage_BoolOption {
  if (v === YES) return YES;
  if (v === NO && allowed) return NO;
  return NOT_SET;
}

function plainBool(v: OptionMessage_BoolOption): OptionMessage_BoolOption {
  return v === YES || v === NO ? v : NOT_SET;
}

/**
 * Keep only the display/quality fields of an OptionMessage. Everything that
 * changes the device (lock after session, privacy mode, block input, terminal
 * persistence, file transfer) is dropped; "disable" switches may only tighten.
 */
export function sanitizeOption(o: OptionMessage, p: SharePermissions): OptionMessage {
  return OptionMessage.fromPartial({
    image_quality: o.image_quality,
    custom_image_quality: o.custom_image_quality,
    custom_fps: o.custom_fps,
    supported_decoding: o.supported_decoding,
    show_remote_cursor: plainBool(o.show_remote_cursor),
    follow_remote_cursor: plainBool(o.follow_remote_cursor),
    follow_remote_window: plainBool(o.follow_remote_window),
    disable_audio: disableOpt(o.disable_audio, p.audio),
    disable_clipboard: disableOpt(o.disable_clipboard, p.clipboard),
    disable_keyboard: disableOpt(o.disable_keyboard, p.control),
    disable_camera: disableOpt(o.disable_camera, p.camera),
    // enable_file_transfer is an "enable" switch: only No may pass without files.
    enable_file_transfer: o.enable_file_transfer === NO ? NO : p.files ? plainBool(o.enable_file_transfer) : NOT_SET,
  });
}

/**
 * The option block the gateway logs in with: the viewer's sanitised choices,
 * then the share's restrictions forced on so the device enforces them too.
 */
export function loginOption(viewer: OptionMessage | undefined, p: SharePermissions): OptionMessage {
  const o = sanitizeOption(viewer ?? OptionMessage.fromPartial({}), p);
  if (!p.control) o.disable_keyboard = YES;
  if (!p.clipboard) o.disable_clipboard = YES;
  if (!p.audio) o.disable_audio = YES;
  if (!p.files) o.enable_file_transfer = NO;
  if (!p.camera) o.disable_camera = YES;
  return o;
}

export type LoginContext = {
  peerId: string;
  passwordHash: Uint8Array;
  myId: string;
  myName: string;
  sessionId: bigint;
  version: string;
  conn: ShareConnKind;
};

/**
 * Build the LoginRequest the gateway sends to the device. From the viewer's
 * hello only the codec abilities, the video-ack choice and sanitised display
 * options survive; identity, password and connection type are the gateway's.
 */
export function buildShareLogin(hello: LoginRequest | undefined, ctx: LoginContext, p: SharePermissions): LoginRequest {
  const base = {
    username: ctx.peerId,
    password: ctx.passwordHash,
    my_id: ctx.myId,
    my_name: ctx.myName,
    session_id: ctx.sessionId,
    version: ctx.version,
  };
  switch (ctx.conn) {
    case 'fileTransfer':
      return LoginRequest.fromPartial({
        ...base,
        union: { $case: 'file_transfer', file_transfer: { dir: '', show_hidden: false } },
      });
    case 'terminal':
      return LoginRequest.fromPartial({
        ...base,
        union: { $case: 'terminal', terminal: { service_id: '' } },
        option: OptionMessage.fromPartial({ terminal_persistent: NO }),
      });
    case 'viewCamera':
    case 'default':
      return LoginRequest.fromPartial({
        ...base,
        video_ack_required: hello?.video_ack_required ?? true,
        option: loginOption(hello?.option, p),
        union: ctx.conn === 'viewCamera' ? { $case: 'view_camera', view_camera: {} } : undefined,
      });
  }
}

/** `close`: the session cannot go on under this share (the shared display is gone). */
export type Verdict = { pass: Message } | { drop: string } | { close: string };

const pass = (m: Message): Verdict => ({ pass: m });
const drop = (why: string): Verdict => ({ drop: why });

function viewerMisc(misc: Misc, conn: ShareConnKind, p: SharePermissions, gate: DisplayGate): Misc | string {
  const u = misc.union;
  const screen = conn === 'default' || conn === 'viewCamera';
  switch (u?.$case) {
    case 'switch_display': {
      if (!screen) return `misc.switch_display on ${conn}`;
      const d = gate.toDevice(u.switch_display.display);
      if (d === undefined) return 'misc.switch_display to another display';
      return { union: { $case: 'switch_display', switch_display: { ...u.switch_display, display: d } } };
    }
    case 'capture_displays': {
      if (!screen) return `misc.capture_displays on ${conn}`;
      const c = u.capture_displays;
      const map = (xs: number[]): number[] | undefined => {
        const out: number[] = [];
        for (const x of xs) {
          const d = gate.toDevice(x);
          if (d === undefined) return undefined;
          out.push(d);
        }
        return out;
      };
      const add = map(c.add), sub = map(c.sub), set = map(c.set);
      if (!add || !sub || !set) return 'misc.capture_displays of another display';
      return { union: { $case: 'capture_displays', capture_displays: { add, sub, set } } };
    }
    case 'refresh_video_display': {
      if (!screen) return `misc.refresh_video_display on ${conn}`;
      const d = gate.toDevice(u.refresh_video_display);
      if (d === undefined) return 'misc.refresh_video_display of another display';
      return { union: { $case: 'refresh_video_display', refresh_video_display: d } };
    }
    case 'video_received':
    case 'refresh_video':
    case 'auto_adjust_fps':
    case 'client_record_status':
      return screen ? misc : `misc.${u.$case} on ${conn}`;
    case 'option':
      return { union: { $case: 'option', option: sanitizeOption(u.option, p) } };
    case 'chat_message':
      return p.chat ? misc : 'misc.chat_message without chat';
    default:
      return `misc.${u?.$case ?? 'empty'}`;
  }
}

/** A message from the viewer, on its way to the device. */
export function fromViewer(msg: Message, conn: ShareConnKind, p: SharePermissions, gate: DisplayGate = ALL_DISPLAYS): Verdict {
  const u = msg.union;
  switch (u?.$case) {
    case 'test_delay':
      return pass(msg);
    case 'misc': {
      const m = viewerMisc(u.misc, conn, p, gate);
      return typeof m === 'string' ? drop(m) : pass({ union: { $case: 'misc', misc: m } });
    }
    case 'mouse_event': {
      if (conn !== 'default' || !p.control) return drop('mouse_event without control');
      if (!gate.limited) return pass(msg);
      const type = u.mouse_event.mask & 0x7;
      if (type === MOUSE_MOVE_RELATIVE) return drop('relative mouse_event with one display');
      if (!MOUSE_ABSOLUTE.has(type)) return pass(msg); // wheel and trackpad carry deltas
      const at = gate.clamp(u.mouse_event.x, u.mouse_event.y);
      if (!at) return drop('mouse_event before the display is known');
      return pass({ union: { $case: 'mouse_event', mouse_event: { ...u.mouse_event, x: at.x, y: at.y } } });
    }
    case 'key_event':
    case 'pointer_device_event':
      return conn === 'default' && p.control ? pass(msg) : drop(`${u.$case} without control`);
    case 'clipboard':
    case 'multi_clipboards':
      return conn === 'default' && p.clipboard ? pass(msg) : drop(`${u.$case} without clipboard`);
    case 'file_action':
    case 'file_response':
      return conn === 'fileTransfer' && p.files ? pass(msg) : drop(`${u.$case} without files`);
    case 'terminal_action':
      return conn === 'terminal' && p.terminal ? pass(msg) : drop('terminal_action without terminal');
    default:
      return drop(u?.$case ?? 'empty');
  }
}

function deviceMisc(misc: Misc, conn: ShareConnKind, p: SharePermissions, gate: DisplayGate): Misc | string {
  const u = misc.union;
  switch (u?.$case) {
    case 'switch_display': {
      const v = gate.toViewer(u.switch_display.display);
      if (v === undefined) return 'misc.switch_display of another display';
      if (gate.limited) gate.learn(u.switch_display);
      return { union: { $case: 'switch_display', switch_display: { ...u.switch_display, display: v } } };
    }
    case 'follow_current_display': {
      const v = gate.toViewer(u.follow_current_display);
      if (v === undefined) return 'misc.follow_current_display of another display';
      return { union: { $case: 'follow_current_display', follow_current_display: v } };
    }
    case 'close_reason':
    case 'uac':
    case 'supported_encoding':
    case 'back_notification':
    case 'foreground_window_elevated':
      return misc;
    case 'permission_info':
      return { union: { $case: 'permission_info', permission_info: { ...u.permission_info, enabled: u.permission_info.enabled && permissionAllowed(u.permission_info.permission, p) } } };
    case 'audio_format':
      return p.audio ? misc : 'misc.audio_format without audio';
    case 'chat_message':
      return p.chat ? misc : 'misc.chat_message without chat';
    default:
      return `misc.${u?.$case ?? 'empty'}`;
  }
}

/** A message from the device, on its way to the viewer. */
export function fromDevice(msg: Message, conn: ShareConnKind, p: SharePermissions, gate: DisplayGate = ALL_DISPLAYS): Verdict {
  const u = msg.union;
  switch (u?.$case) {
    case 'video_frame': {
      const v = gate.toViewer(u.video_frame.display);
      if (v === undefined) return drop('video_frame of another display');
      return v === u.video_frame.display ? pass(msg) : pass({ union: { $case: 'video_frame', video_frame: { ...u.video_frame, display: v } } });
    }
    case 'cursor_position':
      return !gate.limited || gate.contains(u.cursor_position.x, u.cursor_position.y) ? pass(msg) : drop('cursor_position on another display');
    case 'cursor_data':
    case 'cursor_id':
    case 'test_delay':
    case 'message_box':
      return pass(msg);
    case 'login_response': {
      const lr = u.login_response.union;
      if (lr?.$case === 'peer_info') {
        const pi = gateDisplays(restrictPeerInfo(lr.peer_info, p), gate);
        if (!pi) return { close: 'display_missing' };
        return pass({ union: { $case: 'login_response', login_response: { ...u.login_response, union: { $case: 'peer_info', peer_info: pi } } } });
      }
      return pass(msg);
    }
    case 'peer_info': {
      const pi = gateDisplays(restrictPeerInfo(u.peer_info, p), gate);
      if (!pi) return { close: 'display_missing' };
      return pass({ union: { $case: 'peer_info', peer_info: pi } });
    }
    case 'misc': {
      const m = deviceMisc(u.misc, conn, p, gate);
      return typeof m === 'string' ? drop(m) : pass({ union: { $case: 'misc', misc: m } });
    }
    case 'clipboard':
    case 'multi_clipboards':
      return p.clipboard ? pass(msg) : drop(`${u.$case} without clipboard`);
    case 'audio_frame':
      return p.audio ? pass(msg) : drop('audio_frame without audio');
    case 'file_response':
    case 'file_action':
      return conn === 'fileTransfer' && p.files ? pass(msg) : drop(`${u.$case} without files`);
    case 'terminal_response':
      return conn === 'terminal' && p.terminal ? pass(msg) : drop('terminal_response without terminal');
    default:
      return drop(u?.$case ?? 'empty');
  }
}

function permissionAllowed(perm: PermissionInfo_Permission, p: SharePermissions): boolean {
  switch (perm) {
    case PermissionInfo_Permission.Keyboard:
      return p.control;
    case PermissionInfo_Permission.Clipboard:
      return p.clipboard;
    case PermissionInfo_Permission.Audio:
      return p.audio;
    case PermissionInfo_Permission.File:
      return p.files;
    case PermissionInfo_Permission.Recording:
      return true;
    default:
      // Restart, BlockInput, PrivacyMode and anything newer: never via a share.
      return false;
  }
}

/**
 * Show the viewer only the shared display, as its display 0. Null when the
 * device does not have that display (any more).
 */
export function gateDisplays(pi: PeerInfo, gate: DisplayGate): PeerInfo | null {
  if (gate.device === null) return pi;
  const d: DisplayInfo | undefined = pi.displays[gate.device];
  if (!d) return null;
  gate.learn(d);
  const isCurrent = pi.current_display === gate.device;
  return { ...pi, displays: [d], current_display: 0, resolutions: isCurrent ? pi.resolutions : undefined };
}

/** Hide device features the share does not allow, so the UI never offers them. */
export function restrictPeerInfo(pi: PeerInfo, p: SharePermissions): PeerInfo {
  let additions = pi.platform_additions;
  if (!p.camera && additions) {
    try {
      const parsed: unknown = JSON.parse(additions);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const rec = { ...(parsed as Record<string, unknown>) };
        delete rec.support_view_camera;
        additions = JSON.stringify(rec);
      }
    } catch {
      additions = '';
    }
  }
  return {
    ...pi,
    platform_additions: additions,
    features: pi.features
      ? { ...pi.features, terminal: pi.features.terminal && p.terminal, privacy_mode: false }
      : pi.features,
  };
}

/**
 * permission_info messages the gateway sends the viewer right after login, so
 * the client hides what the share does not allow even before the device says
 * anything about its own settings.
 */
export function deniedPermissionMessages(p: SharePermissions): Message[] {
  const denied: PermissionInfo_Permission[] = [
    PermissionInfo_Permission.Restart,
    PermissionInfo_Permission.BlockInput,
    PermissionInfo_Permission.PrivacyMode,
  ];
  if (!p.control) denied.push(PermissionInfo_Permission.Keyboard);
  if (!p.clipboard) denied.push(PermissionInfo_Permission.Clipboard);
  if (!p.audio) denied.push(PermissionInfo_Permission.Audio);
  if (!p.files) denied.push(PermissionInfo_Permission.File);
  return denied.map((permission) => ({
    union: { $case: 'misc', misc: { union: { $case: 'permission_info', permission_info: { permission, enabled: false } } } },
  }));
}
