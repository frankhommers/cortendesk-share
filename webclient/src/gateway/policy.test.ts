import { describe, expect, it } from 'vitest';
import {
  ControlKey,
  LoginRequest,
  Message,
  Misc,
  OptionMessage,
  OptionMessage_BoolOption,
  PeerInfo,
  PermissionInfo_Permission,
  SwitchDisplay,
} from '../gen/message';
import {
  DisplayGate,
  NO_PERMISSIONS,
  buildShareLogin,
  captureSharedDisplay,
  connAllowed,
  deniedPermissionMessages,
  fromDevice,
  fromViewer,
  normalizePermissions,
  restrictPeerInfo,
  type SharePermissions,
} from './policy';

const YES = OptionMessage_BoolOption.Yes;
const NO = OptionMessage_BoolOption.No;
const ALL: SharePermissions = { control: true, clipboard: true, files: true, terminal: true, camera: true, audio: true, chat: true };
const VIEW = NO_PERMISSIONS;

const msg = (union: Message['union']): Message => ({ union });
const misc = (union: Misc['union']): Message => msg({ $case: 'misc', misc: { union } });
const passed = (v: ReturnType<typeof fromViewer>): Message | undefined => ('pass' in v ? v.pass : undefined);

describe('normalizePermissions', () => {
  it('only accepts literal true', () => {
    expect(normalizePermissions({ control: 'yes', clipboard: 1, files: true })).toEqual({ ...VIEW, files: true });
    expect(normalizePermissions(null)).toEqual(VIEW);
  });
});

describe('connAllowed', () => {
  it('gates side connections by permission', () => {
    expect(connAllowed('default', VIEW)).toBe(true);
    expect(connAllowed('fileTransfer', VIEW)).toBe(false);
    expect(connAllowed('terminal', VIEW)).toBe(false);
    expect(connAllowed('viewCamera', VIEW)).toBe(false);
    expect(connAllowed('terminal', { ...VIEW, terminal: true })).toBe(true);
  });
});

describe('fromViewer', () => {
  const mouse = msg({ $case: 'mouse_event', mouse_event: { mask: 1, x: 1, y: 1, modifiers: [] } });
  const key = msg({ $case: 'key_event', key_event: { down: true, press: false, modifiers: [], mode: 0, union: { $case: 'control_key', control_key: ControlKey.CtrlAltDel } } });

  it('drops input in view-only shares', () => {
    expect(passed(fromViewer(mouse, 'default', VIEW))).toBeUndefined();
    expect(passed(fromViewer(key, 'default', VIEW))).toBeUndefined();
  });

  it('passes input with control', () => {
    expect(passed(fromViewer(mouse, 'default', { ...VIEW, control: true }))).toBe(mouse);
  });

  it('drops clipboard, file and terminal traffic without their permission', () => {
    const clip = msg({ $case: 'clipboard', clipboard: { compress: false, content: new Uint8Array([65]), width: 0, height: 0, format: 0, special_name: '' } });
    expect(passed(fromViewer(clip, 'default', { ...VIEW, control: true }))).toBeUndefined();
    const fa = msg({ $case: 'file_action', file_action: { union: undefined } });
    expect(passed(fromViewer(fa, 'fileTransfer', VIEW))).toBeUndefined();
    expect(passed(fromViewer(fa, 'default', ALL))).toBeUndefined(); // wrong connection type
    expect(passed(fromViewer(fa, 'fileTransfer', { ...VIEW, files: true }))).toBe(fa);
    const ta = msg({ $case: 'terminal_action', terminal_action: { union: undefined } });
    expect(passed(fromViewer(ta, 'terminal', VIEW))).toBeUndefined();
  });

  it('never passes dangerous messages, even with every permission', () => {
    const never: Message[] = [
      misc({ $case: 'restart_remote_device', restart_remote_device: true }),
      misc({ $case: 'elevation_request', elevation_request: { union: undefined } }),
      misc({ $case: 'toggle_privacy_mode', toggle_privacy_mode: { impl_key: '', on: true } }),
      misc({ $case: 'change_display_resolution', change_display_resolution: { display: 0, resolution: { width: 1, height: 1 } } }),
      misc({ $case: 'toggle_virtual_display', toggle_virtual_display: { display: 0, on: true } }),
      misc({ $case: 'switch_sides_request', switch_sides_request: { uuid: new Uint8Array() } }),
      misc({ $case: 'permission_info', permission_info: { permission: PermissionInfo_Permission.Keyboard, enabled: true } }),
      msg({ $case: 'login_request', login_request: LoginRequest.fromPartial({}) }),
      msg({ $case: 'auth_2fa', auth_2fa: { code: '123456', hwid: new Uint8Array() } }),
      msg({ $case: 'voice_call_request', voice_call_request: { req_timestamp: 1n, is_connect: true } }),
      msg({ $case: 'audio_frame', audio_frame: { data: new Uint8Array() } }),
      msg({ $case: 'screenshot_request', screenshot_request: { display: 0, sid: '' } }),
      { union: undefined },
    ];
    for (const m of never) expect(passed(fromViewer(m, 'default', ALL)), m.union?.$case).toBeUndefined();
  });

  it('sanitises options: no lock/privacy/block, disable switches only tighten', () => {
    const o = OptionMessage.fromPartial({
      image_quality: 4,
      lock_after_session_end: YES,
      privacy_mode: YES,
      block_input: YES,
      disable_keyboard: NO,
      disable_clipboard: NO,
      disable_audio: YES,
      enable_file_transfer: YES,
      terminal_persistent: YES,
    });
    const out = passed(fromViewer(misc({ $case: 'option', option: o }), 'default', VIEW));
    const got = out?.union?.$case === 'misc' && out.union.misc.union?.$case === 'option' ? out.union.misc.union.option : undefined;
    expect(got).toBeDefined();
    expect(got!.image_quality).toBe(4);
    expect(got!.lock_after_session_end).toBe(0);
    expect(got!.privacy_mode).toBe(0);
    expect(got!.block_input).toBe(0);
    expect(got!.terminal_persistent).toBe(0);
    expect(got!.disable_keyboard).toBe(0); // NO refused without control
    expect(got!.disable_clipboard).toBe(0);
    expect(got!.disable_audio).toBe(YES);
    expect(got!.enable_file_transfer).toBe(0);
  });

  it('gates chat', () => {
    const chat = misc({ $case: 'chat_message', chat_message: { text: 'hi' } });
    expect(passed(fromViewer(chat, 'default', VIEW))).toBeUndefined();
    expect(passed(fromViewer(chat, 'default', { ...VIEW, chat: true }))).toBeDefined();
  });
});

describe('fromDevice', () => {
  it('never forwards the login challenge', () => {
    const hash = msg({ $case: 'hash', hash: { salt: 's', challenge: 'c' } });
    expect(passed(fromDevice(hash, 'default', ALL))).toBeUndefined();
  });

  it('masks permissions the share does not allow', () => {
    const on = misc({ $case: 'permission_info', permission_info: { permission: PermissionInfo_Permission.Keyboard, enabled: true } });
    const out = passed(fromDevice(on, 'default', VIEW));
    expect(out?.union?.$case === 'misc' && out.union.misc.union?.$case === 'permission_info' && out.union.misc.union.permission_info.enabled).toBe(false);
    const restart = misc({ $case: 'permission_info', permission_info: { permission: PermissionInfo_Permission.Restart, enabled: true } });
    const r = passed(fromDevice(restart, 'default', ALL));
    expect(r?.union?.$case === 'misc' && r.union.misc.union?.$case === 'permission_info' && r.union.misc.union.permission_info.enabled).toBe(false);
  });

  it('drops clipboard and audio without permission', () => {
    const audio = msg({ $case: 'audio_frame', audio_frame: { data: new Uint8Array([1]) } });
    expect(passed(fromDevice(audio, 'default', VIEW))).toBeUndefined();
    expect(passed(fromDevice(audio, 'default', { ...VIEW, audio: true }))).toBe(audio);
  });
});

describe('restrictPeerInfo', () => {
  it('hides terminal, camera and privacy mode', () => {
    const pi = PeerInfo.fromPartial({
      platform: 'Linux',
      platform_additions: JSON.stringify({ support_view_camera: true, headless: false }),
      features: { privacy_mode: true, terminal: true },
    });
    const out = restrictPeerInfo(pi, VIEW);
    expect(out.features?.terminal).toBe(false);
    expect(out.features?.privacy_mode).toBe(false);
    expect(JSON.parse(out.platform_additions)).toEqual({ headless: false });
  });
});

describe('buildShareLogin', () => {
  const ctx = { peerId: '123', passwordHash: new Uint8Array([9]), myId: 'share-1', myName: 'Share', sessionId: 5n, version: '1.4.0' };

  it('forces device-side restrictions and ignores the viewer identity', () => {
    const hello = LoginRequest.fromPartial({
      username: 'evil',
      password: new Uint8Array([1, 2, 3]),
      my_id: 'evil',
      video_ack_required: false,
      option: { disable_keyboard: NO, lock_after_session_end: YES, image_quality: 3 },
      union: { $case: 'terminal', terminal: { service_id: 'x' } },
    });
    const lr = buildShareLogin(hello, { ...ctx, conn: 'default' }, VIEW);
    expect(lr.username).toBe('123');
    expect(Array.from(lr.password)).toEqual([9]);
    expect(lr.my_id).toBe('share-1');
    expect(lr.union).toBeUndefined();
    expect(lr.video_ack_required).toBe(false);
    expect(lr.option?.disable_keyboard).toBe(YES);
    expect(lr.option?.disable_clipboard).toBe(YES);
    expect(lr.option?.disable_audio).toBe(YES);
    expect(lr.option?.enable_file_transfer).toBe(NO);
    expect(lr.option?.lock_after_session_end).toBe(0);
    expect(lr.option?.image_quality).toBe(3);
  });

  it('uses the gateway connection type, not the viewer one', () => {
    const lr = buildShareLogin(undefined, { ...ctx, conn: 'fileTransfer' }, ALL);
    expect(lr.union?.$case).toBe('file_transfer');
  });
});

describe('deniedPermissionMessages', () => {
  it('always denies restart, block input and privacy mode', () => {
    const kinds = deniedPermissionMessages(ALL).map((m) =>
      m.union?.$case === 'misc' && m.union.misc.union?.$case === 'permission_info' ? m.union.misc.union.permission_info.permission : -1,
    );
    expect(kinds.sort()).toEqual([PermissionInfo_Permission.Restart, PermissionInfo_Permission.BlockInput, PermissionInfo_Permission.PrivacyMode].sort());
    expect(deniedPermissionMessages(VIEW)).toHaveLength(7);
  });
});

describe('DisplayGate (one display)', () => {
  const displays = [
    { x: 0, y: 0, width: 1920, height: 1080, name: 'a', online: true, cursor_embedded: false, scale: 1 },
    { x: 1920, y: 0, width: 1280, height: 1024, name: 'b', online: true, cursor_embedded: false, scale: 1 },
  ];
  const pi = () => PeerInfo.fromPartial({ platform: 'Linux', displays, current_display: 0 });
  const loginWith = (p: PeerInfo): Message => msg({ $case: 'login_response', login_response: { union: { $case: 'peer_info', peer_info: p }, enable_trusted_devices: false } });
  const ctl = { ...VIEW, control: true };

  const gated = () => {
    const g = DisplayGate.forShare(1, 'default');
    const out = passed(fromDevice(loginWith(pi()), 'default', ctl, g));
    return { g, out };
  };

  it('shows only the shared display, as display 0', () => {
    const { out } = gated();
    const got = out?.union?.$case === 'login_response' && out.union.login_response.union?.$case === 'peer_info' ? out.union.login_response.union.peer_info : undefined;
    expect(got?.displays).toHaveLength(1);
    expect(got?.displays[0]?.x).toBe(1920);
    expect(got?.current_display).toBe(0);
  });

  it('closes when the device lacks the display', () => {
    const g = DisplayGate.forShare(5, 'default');
    expect('close' in fromDevice(loginWith(pi()), 'default', ctl, g)).toBe(true);
  });

  it('passes video of the shared display only, renumbered', () => {
    const { g } = gated();
    const frame = (display: number): Message => msg({ $case: 'video_frame', video_frame: { display, union: undefined } });
    expect(passed(fromDevice(frame(0), 'default', ctl, g))).toBeUndefined();
    const out = passed(fromDevice(frame(1), 'default', ctl, g));
    expect(out?.union?.$case === 'video_frame' && out.union.video_frame.display).toBe(0);
  });

  it('maps display switches and refuses other displays', () => {
    const { g } = gated();
    const sw = (display: number) => misc({ $case: 'switch_display', switch_display: SwitchDisplay.fromPartial({ display }) });
    const toDev = passed(fromViewer(sw(0), 'default', ctl, g));
    expect(toDev?.union?.$case === 'misc' && toDev.union.misc.union?.$case === 'switch_display' && toDev.union.misc.union.switch_display.display).toBe(1);
    expect(passed(fromViewer(sw(1), 'default', ctl, g))).toBeUndefined();
    const cap = (set: number[]) => misc({ $case: 'capture_displays', capture_displays: { add: [], sub: [], set } });
    expect(passed(fromViewer(cap([0, 1]), 'default', ctl, g))).toBeUndefined();
    const c = passed(fromViewer(cap([0]), 'default', ctl, g));
    expect(c?.union?.$case === 'misc' && c.union.misc.union?.$case === 'capture_displays' && c.union.misc.union.capture_displays.set).toEqual([1]);
    expect(passed(fromDevice(sw(0), 'default', ctl, g))).toBeUndefined();
    const back = passed(fromDevice(sw(1), 'default', ctl, g));
    expect(back?.union?.$case === 'misc' && back.union.misc.union?.$case === 'switch_display' && back.union.misc.union.switch_display.display).toBe(0);
  });

  it('keeps the mouse on the shared display and drops relative moves', () => {
    const { g } = gated();
    const mouse = (mask: number, x: number, y: number) => msg({ $case: 'mouse_event', mouse_event: { mask, x, y, modifiers: [] } });
    const out = passed(fromViewer(mouse(1 | (1 << 3), 100, 2000), 'default', ctl, g));
    expect(out?.union?.$case === 'mouse_event' && [out.union.mouse_event.x, out.union.mouse_event.y]).toEqual([1920, 1023]);
    expect(passed(fromViewer(mouse(5, 10, 10), 'default', ctl, g))).toBeUndefined();
    const wheel = mouse(3, 0, -120);
    expect(passed(fromViewer(wheel, 'default', ctl, g))).toBe(wheel);
  });

  it('hides the cursor on other displays', () => {
    const { g } = gated();
    const cur = (x: number) => msg({ $case: 'cursor_position', cursor_position: { x, y: 10 } });
    expect(passed(fromDevice(cur(10), 'default', ctl, g))).toBeUndefined();
    expect(passed(fromDevice(cur(2000), 'default', ctl, g))).toBeDefined();
  });

  it('does not gate cameras or unlimited shares', () => {
    expect(DisplayGate.forShare(1, 'viewCamera').limited).toBe(false);
    expect(DisplayGate.forShare(null, 'default').limited).toBe(false);
    expect(DisplayGate.forShare('1', 'default').limited).toBe(false);
    expect(captureSharedDisplay(DisplayGate.forShare(null, 'default'))).toHaveLength(0);
    expect(captureSharedDisplay(DisplayGate.forShare(1, 'default'))).toHaveLength(2);
  });
});
