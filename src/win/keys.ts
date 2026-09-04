// Pure INPUT-byte construction for SendInput — no FFI here, so the wire layout
// of every event is unit-testable on any platform.

export interface KeySpec {
  vk: number;
  scan: number;
  /** E0-prefixed key: arrows, right Ctrl/Alt, Ins/Del/Home/End/PgUp/PgDn, NumLock, PrintScreen. */
  extended?: boolean;
}

const KEYEVENTF_EXTENDEDKEY = 0x1;
const KEYEVENTF_KEYUP = 0x2;
const KEYEVENTF_UNICODE = 0x4;
const KEYEVENTF_SCANCODE = 0x8;

export const INPUT_SIZE = 40;
export const INPUT_MOUSE = 0;
export const INPUT_KEYBOARD = 1;

// Scan codes are the Set 1 make codes; GTA reads the keyboard through DirectInput
// and raw input, which key off the scan code, not the virtual key.
const KEYS: Record<string, KeySpec> = {
  escape: { vk: 0x1b, scan: 0x01 },
  esc: { vk: 0x1b, scan: 0x01 },
  "1": { vk: 0x31, scan: 0x02 },
  "2": { vk: 0x32, scan: 0x03 },
  "3": { vk: 0x33, scan: 0x04 },
  "4": { vk: 0x34, scan: 0x05 },
  "5": { vk: 0x35, scan: 0x06 },
  "6": { vk: 0x36, scan: 0x07 },
  "7": { vk: 0x37, scan: 0x08 },
  "8": { vk: 0x38, scan: 0x09 },
  "9": { vk: 0x39, scan: 0x0a },
  "0": { vk: 0x30, scan: 0x0b },
  enter: { vk: 0x0d, scan: 0x1c },
  control: { vk: 0xa2, scan: 0x1d },
  ctrl: { vk: 0xa2, scan: 0x1d },
  lcontrol: { vk: 0xa2, scan: 0x1d },
  rcontrol: { vk: 0xa3, scan: 0x1d, extended: true },
  shift: { vk: 0x10, scan: 0x2a },
  lshift: { vk: 0x10, scan: 0x2a },
  // VK_RSHIFT is 0xA1 (0x11 would be VK_CONTROL); scan 0x36 is not E0-prefixed.
  rshift: { vk: 0xa1, scan: 0x36 },
  alt: { vk: 0xa4, scan: 0x38 },
  lalt: { vk: 0xa4, scan: 0x38 },
  ralt: { vk: 0xa5, scan: 0x38, extended: true },
  space: { vk: 0x20, scan: 0x39 },
  tab: { vk: 0x09, scan: 0x0f },
  backspace: { vk: 0x08, scan: 0x0e },
  f1: { vk: 0x70, scan: 0x3b },
  f2: { vk: 0x71, scan: 0x3c },
  f3: { vk: 0x72, scan: 0x3d },
  f4: { vk: 0x73, scan: 0x3e },
  f5: { vk: 0x74, scan: 0x3f },
  f6: { vk: 0x75, scan: 0x40 },
  f7: { vk: 0x76, scan: 0x41 },
  f8: { vk: 0x77, scan: 0x42 },
  f9: { vk: 0x78, scan: 0x43 },
  f10: { vk: 0x79, scan: 0x44 },
  f11: { vk: 0x7a, scan: 0x45 },
  f12: { vk: 0x7b, scan: 0x46 },
  up: { vk: 0x26, scan: 0x48, extended: true },
  down: { vk: 0x28, scan: 0x50, extended: true },
  left: { vk: 0x25, scan: 0x4b, extended: true },
  right: { vk: 0x27, scan: 0x4d, extended: true },
  insert: { vk: 0x2d, scan: 0x52, extended: true },
  delete: { vk: 0x2e, scan: 0x53, extended: true },
  home: { vk: 0x24, scan: 0x47, extended: true },
  end: { vk: 0x23, scan: 0x4f, extended: true },
  pageup: { vk: 0x21, scan: 0x49, extended: true },
  pagedown: { vk: 0x22, scan: 0x51, extended: true },
  a: { vk: 0x41, scan: 0x1e },
  b: { vk: 0x42, scan: 0x30 },
  c: { vk: 0x43, scan: 0x2e },
  d: { vk: 0x44, scan: 0x20 },
  e: { vk: 0x45, scan: 0x12 },
  f: { vk: 0x46, scan: 0x21 },
  g: { vk: 0x47, scan: 0x22 },
  h: { vk: 0x48, scan: 0x23 },
  i: { vk: 0x49, scan: 0x17 },
  j: { vk: 0x4a, scan: 0x24 },
  k: { vk: 0x4b, scan: 0x25 },
  l: { vk: 0x4c, scan: 0x26 },
  m: { vk: 0x4d, scan: 0x32 },
  n: { vk: 0x4e, scan: 0x31 },
  o: { vk: 0x4f, scan: 0x18 },
  p: { vk: 0x50, scan: 0x19 },
  q: { vk: 0x51, scan: 0x10 },
  r: { vk: 0x52, scan: 0x13 },
  s: { vk: 0x53, scan: 0x1f },
  t: { vk: 0x54, scan: 0x14 },
  u: { vk: 0x55, scan: 0x16 },
  v: { vk: 0x56, scan: 0x2f },
  w: { vk: 0x57, scan: 0x11 },
  x: { vk: 0x58, scan: 0x2d },
  y: { vk: 0x59, scan: 0x15 },
  z: { vk: 0x5a, scan: 0x2c },
};

export function keySpec(name: string): KeySpec | null {
  return KEYS[name.toLowerCase()] ?? null;
}

function inputBuffer(): Buffer {
  const buf = Buffer.alloc(INPUT_SIZE);
  return buf;
}

/** INPUT.keyboard bytes: wVk@8 wScan@10 dwFlags@12 time@16 dwExtraInfo@24 (x64). */
export function buildKeyboardInput(
  spec: KeySpec,
  options: { up?: boolean; unicodeChar?: number } = {},
): Buffer {
  const buf = inputBuffer();
  buf.writeUInt32LE(INPUT_KEYBOARD, 0);
  if (options.unicodeChar !== undefined) {
    buf.writeUInt16LE(0, 8);
    buf.writeUInt16LE(options.unicodeChar, 10);
    let flags = KEYEVENTF_UNICODE;
    if (options.up) flags |= KEYEVENTF_KEYUP;
    buf.writeUInt32LE(flags, 12);
    return buf;
  }
  buf.writeUInt16LE(spec.vk, 8);
  buf.writeUInt16LE(spec.scan, 10);
  let flags = KEYEVENTF_SCANCODE;
  if (spec.extended) flags |= KEYEVENTF_EXTENDEDKEY;
  if (options.up) flags |= KEYEVENTF_KEYUP;
  buf.writeUInt32LE(flags, 12);
  return buf;
}

export function buildKeyPress(name: string): Buffer {
  const spec = keySpec(name);
  if (!spec) throw new Error(`unknown key '${name}' (see the key table in src/win/keys.ts)`);
  return buildKeyboardInput(spec);
}

export function buildKeyRelease(name: string): Buffer {
  const spec = keySpec(name);
  if (!spec) throw new Error(`unknown key '${name}'`);
  return buildKeyboardInput(spec, { up: true });
}

/** Press+release pairs for literal text via KEYEVENTF_UNICODE (what console/NUI inputs read). */
export function buildUnicodeText(text: string): Buffer {
  const units: number[] = [];
  for (const ch of text) units.push(...toUtf16Units(ch));
  const parts: Buffer[] = [];
  for (const unit of units) {
    parts.push(buildKeyboardInput({ vk: 0, scan: 0 }, { unicodeChar: unit }));
    parts.push(buildKeyboardInput({ vk: 0, scan: 0 }, { unicodeChar: unit, up: true }));
  }
  return Buffer.concat(parts);
}

function toUtf16Units(text: string): number[] {
  const units: number[] = [];
  for (let i = 0; i < text.length; i++) units.push(text.charCodeAt(i));
  return units;
}

// MOUSE flags
export const MOUSEEVENTF_MOVE = 0x1;
export const MOUSEEVENTF_LEFTDOWN = 0x2;
export const MOUSEEVENTF_LEFTUP = 0x4;
export const MOUSEEVENTF_RIGHTDOWN = 0x8;
export const MOUSEEVENTF_RIGHTUP = 0x10;
export const MOUSEEVENTF_WHEEL = 0x800;
export const MOUSEEVENTF_ABSOLUTE = 0x4000;

/** INPUT.mouse bytes: dx@8 dy@12 mouseData@16 dwFlags@20 time@24 dwExtraInfo@32 (x64). */
export function buildMouseInput(fields: {
  dx?: number;
  dy?: number;
  data?: number;
  flags: number;
}): Buffer {
  const buf = inputBuffer();
  buf.writeUInt32LE(INPUT_MOUSE, 0);
  buf.writeInt32LE(fields.dx ?? 0, 8);
  buf.writeInt32LE(fields.dy ?? 0, 12);
  buf.writeInt32LE(fields.data ?? 0, 16);
  buf.writeUInt32LE(fields.flags, 20);
  return buf;
}
