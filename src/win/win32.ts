// Lazily-loaded Win32 bindings (koffi). Everything here is Windows-only and
// must not run at module scope: importing this file on any OS has to work for
// tests and non-Windows installs — the DLLs load on first use.

import { createRequire } from "node:module";
import type Koffi from "koffi";
import { DEFAULTS } from "../defaults.js";
import { sleep } from "../util.js";
import {
  buildKeyPress,
  buildKeyRelease,
  buildMouseInput,
  buildUnicodeText,
  INPUT_SIZE,
  MOUSEEVENTF_ABSOLUTE,
  MOUSEEVENTF_LEFTDOWN,
  MOUSEEVENTF_LEFTUP,
  MOUSEEVENTF_MOVE,
  MOUSEEVENTF_RIGHTDOWN,
  MOUSEEVENTF_RIGHTUP,
  MOUSEEVENTF_WHEEL,
} from "./keys.js";

let api: ReturnType<typeof buildApi> | null = null;
let koffiModule: typeof Koffi | null = null;

/**
 * koffi is an optionalDependency loaded on first use: the native addon must
 * not be required on Linux/macOS installs (where these tools only ever answer
 * "win32 only"), and a failed optional install must not break `npx` startup.
 */
function koffi(): typeof Koffi {
  if (koffiModule) return koffiModule;
  try {
    koffiModule = createRequire(import.meta.url)("koffi") as typeof Koffi;
  } catch (error) {
    throw new Error(
      `the koffi native module is not installed (${error instanceof Error ? error.message : String(error)}) — reinstall fivem-mcp-server on this Windows machine`,
    );
  }
  return koffiModule;
}

function buildApi() {
  const k = koffi();
  const user32 = k.load("user32.dll");
  const gdi32 = k.load("gdi32.dll");
  const kernel32 = k.load("kernel32.dll");
  return {
    user32,
    gdi32,
    kernel32,
    SendInput: user32.func(
      "uint32 __stdcall SendInput(uint32 nInputs, void* pInputs, int32 cbSize)",
    ),
    GetForegroundWindow: user32.func("void* __stdcall GetForegroundWindow()"),
    SetForegroundWindow: user32.func("bool __stdcall SetForegroundWindow(void* hwnd)"),
    SwitchToThisWindow: user32.func("void __stdcall SwitchToThisWindow(void* hwnd, bool alt)"),
    ShowWindow: user32.func("bool __stdcall ShowWindow(void* hwnd, int cmd)"),
    IsIconic: user32.func("bool __stdcall IsIconic(void* hwnd)"),
    IsWindowVisible: user32.func("bool __stdcall IsWindowVisible(void* hwnd)"),
    IsWindow: user32.func("bool __stdcall IsWindow(void* hwnd)"),
    GetWindowRect: user32.func("bool __stdcall GetWindowRect(void* hwnd, void* rect)"),
    GetWindowTextW: user32.func("int __stdcall GetWindowTextW(void* hwnd, void* text, int max)"),
    GetWindowThreadProcessId: user32.func(
      "uint32 __stdcall GetWindowThreadProcessId(void* hwnd, void* pid)",
    ),
    EnumWindows: user32.func("bool __stdcall EnumWindows(void* proc, intptr_t param)"),
    GetSystemMetrics: user32.func("int __stdcall GetSystemMetrics(int index)"),
    AttachThreadInput: user32.func(
      "bool __stdcall AttachThreadInput(uint32 a, uint32 b, bool attach)",
    ),
    GetCurrentThreadId: kernel32.func("uint32 __stdcall GetCurrentThreadId()"),
    GetWindowDC: user32.func("void* __stdcall GetWindowDC(void* hwnd)"),
    ReleaseDC: user32.func("int __stdcall ReleaseDC(void* hwnd, void* hdc)"),
    GetDC: user32.func("void* __stdcall GetDC(void* hwnd)"),
    CreateCompatibleDC: gdi32.func("void* __stdcall CreateCompatibleDC(void* hdc)"),
    CreateCompatibleBitmap: gdi32.func(
      "void* __stdcall CreateCompatibleBitmap(void* hdc, int w, int h)",
    ),
    SelectObject: gdi32.func("void* __stdcall SelectObject(void* hdc, void* obj)"),
    BitBlt: gdi32.func(
      "bool __stdcall BitBlt(void* dst, int x, int y, int w, int h, void* src, int sx, int sy, uint32 op)",
    ),
    PrintWindow: user32.func("bool __stdcall PrintWindow(void* hwnd, void* hdc, uint32 flags)"),
    GetDIBits: gdi32.func(
      "int __stdcall GetDIBits(void* hdc, void* hbmp, uint32 first, uint32 lines, void* bits, void* bmi, uint32 usage)",
    ),
    DeleteDC: gdi32.func("bool __stdcall DeleteDC(void* hdc)"),
    DeleteObject: gdi32.func("bool __stdcall DeleteObject(void* obj)"),
  };
}

function need(): NonNullable<typeof api> {
  if (process.platform !== "win32") {
    throw new Error("this tool drives the Windows game window and only runs on win32");
  }
  if (!api) api = buildApi();
  return api;
}

/** koffi hands `void*` results back as bigint-compatible values; normalise once here. */
function asHwnd(value: unknown): bigint {
  return typeof value === "bigint" ? value : BigInt((value as number | bigint | null) ?? 0);
}

export interface GameWindow {
  hwnd: bigint;
  title: string;
  pid: number;
}

export interface WindowRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const TITLE_BUFFER = Buffer.alloc(512); // 256 UTF-16 units; reused across calls (single-threaded)

function readWindowText(a: NonNullable<typeof api>, hwnd: bigint): string {
  const len = a.GetWindowTextW(hwnd, TITLE_BUFFER, 256);
  if (len <= 0) return "";
  return TITLE_BUFFER.toString("utf16le", 0, len * 2);
}

function readWindowPid(a: NonNullable<typeof api>, hwnd: bigint): number {
  const buf = Buffer.alloc(4);
  a.GetWindowThreadProcessId(hwnd, buf);
  return buf.readUInt32LE(0);
}

/**
 * Is this window title the FiveM game window? The game's title is
 * `FiveM® by Cfx.re - <server>` (or plain `FiveM`); a title merely *starting*
 * with the letters five-m is not enough — browser tabs open on this very repo
 * ("fivem-mcp/... - Google Chrome") matched a naive /^FiveM/i once.
 */
export function isGameWindowTitle(title: string): boolean {
  return /^FiveM(?![-_a-z0-9])/i.test(title);
}

/** The FiveM game window: titled per isGameWindowTitle, visible, with real area. */
let enumProc: ReturnType<typeof Koffi.proto> | null = null;

/** Last window we found; re-validated on the next call before enumerating again. */
let cachedGame: GameWindow | null = null;

/**
 * Find the FiveM game window. Every input/screenshot tool calls this, so the
 * previous hit is checked first (IsWindow + visible + title still matches) and
 * the full EnumWindows walk only runs when it has gone away.
 */
export function findGameWindow(): GameWindow | null {
  const a = need();
  if (cachedGame) {
    const { hwnd } = cachedGame;
    if (a.IsWindow(hwnd) && a.IsWindowVisible(hwnd)) {
      const title = readWindowText(a, hwnd);
      if (isGameWindowTitle(title)) {
        if (title !== cachedGame.title) cachedGame = { ...cachedGame, title };
        return cachedGame;
      }
    }
    cachedGame = null;
  }
  cachedGame = enumerateGameWindow(a);
  return cachedGame;
}

function enumerateGameWindow(a: NonNullable<typeof api>): GameWindow | null {
  let found: GameWindow | null = null;
  const k = koffi();
  if (!enumProc) enumProc = k.proto("bool EnumWindowsProc(void* hwnd, intptr_t param)");
  const callback = k.register((hwnd: bigint) => {
    if (found) return false;
    if (!a.IsWindowVisible(hwnd)) return true;
    const title = readWindowText(a, hwnd);
    if (!isGameWindowTitle(title)) return true;
    const rect = getWindowRectOf(hwnd);
    if (!rect || rect.right - rect.left < DEFAULTS.minGameWindowWidth) return true;
    found = { hwnd, title, pid: readWindowPid(a, hwnd) };
    return false; // stop enumerating
  }, k.pointer(enumProc));
  try {
    a.EnumWindows(callback, 0);
  } finally {
    k.unregister(callback);
  }
  return found;
}

export function getWindowRectOf(hwnd: bigint): WindowRect | null {
  const a = need();
  const buf = Buffer.alloc(16);
  if (!a.GetWindowRect(hwnd, buf)) return null;
  return {
    left: buf.readInt32LE(0),
    top: buf.readInt32LE(4),
    right: buf.readInt32LE(8),
    bottom: buf.readInt32LE(12),
  };
}

export function foregroundHwnd(): bigint | null {
  const a = need();
  const hwnd = a.GetForegroundWindow();
  return hwnd ? asHwnd(hwnd) : null;
}

const SW_RESTORE = 9;

/** Best-effort focus: restore if minimized, SetForegroundWindow, then the
 *  AttachThreadInput fallback for the Windows foreground-stealing guard. */
export function focusWindow(hwnd: bigint): boolean {
  const a = need();
  if (a.IsIconic(hwnd)) a.ShowWindow(hwnd, SW_RESTORE);
  if (a.SetForegroundWindow(hwnd)) return true;
  const fg = a.GetForegroundWindow();
  if (!fg) return false;
  const fgThread = a.GetWindowThreadProcessId(asHwnd(fg), Buffer.alloc(4));
  const selfThread = a.GetCurrentThreadId();
  a.AttachThreadInput(fgThread, selfThread, true);
  const ok = a.SetForegroundWindow(hwnd);
  a.AttachThreadInput(fgThread, selfThread, false);
  if (!ok) a.SwitchToThisWindow(hwnd, true);
  return ok || asHwnd(a.GetForegroundWindow()) === hwnd;
}

function sendInputs(buf: Buffer): void {
  const a = need();
  const n = Math.floor(buf.length / INPUT_SIZE);
  const sent = a.SendInput(n, buf, INPUT_SIZE);
  if (sent !== n) {
    const hint = "Windows UIPI blocks synthetic input from lower-integrity processes.";
    throw new Error(
      `SendInput delivered ${sent}/${n} events — is the game running elevated while this tool is not? ${hint}`,
    );
  }
}

/**
 * Tap a key: press, hold `holdMs`, release. The hold is an awaited timer, not a
 * busy-wait: a spin would freeze the event loop (devcon reads, RCON replies,
 * MCP requests) for up to the 5 s the tool allows.
 */
export async function pressKey(name: string, holdMs = 20): Promise<void> {
  sendInputs(buildKeyPress(name));
  await sleep(holdMs);
  sendInputs(buildKeyRelease(name));
}

/** Keys currently held via hold_key — released on quit/exit so nothing sprints into a wall. */
const heldKeys = new Set<string>();

export function holdKey(name: string): void {
  sendInputs(buildKeyPress(name));
  heldKeys.add(name.toLowerCase());
}

export function releaseKey(name: string): void {
  sendInputs(buildKeyRelease(name));
  heldKeys.delete(name.toLowerCase());
}

export function releaseAllHeld(): string[] {
  const released = [...heldKeys];
  for (const name of released) {
    try {
      releaseKey(name);
    } catch {
      /* keyboard gone (game closed) — the key is down nowhere anyway */
    }
    heldKeys.delete(name);
  }
  return released;
}

export function typeText(text: string): void {
  sendInputs(buildUnicodeText(text));
}

/** Relative dx/dy drives the in-game camera; absolute x,y (screen coords) targets the cursor for NUI. */
export function mouseMove(fields: {
  dx?: number | undefined;
  dy?: number | undefined;
  x?: number | undefined;
  y?: number | undefined;
}): void {
  const a = need();
  if (fields.x !== undefined && fields.y !== undefined) {
    const screenW = a.GetSystemMetrics(0);
    const screenH = a.GetSystemMetrics(1);
    sendInputs(
      buildMouseInput({
        dx: Math.round((fields.x * 65535) / (screenW - 1)),
        dy: Math.round((fields.y * 65535) / (screenH - 1)),
        flags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
      }),
    );
  } else {
    sendInputs(
      buildMouseInput({ dx: fields.dx ?? 0, dy: fields.dy ?? 0, flags: MOUSEEVENTF_MOVE }),
    );
  }
}

export function mouseClick(button: "left" | "right", double = false): void {
  const down = buildMouseInput({
    flags: button === "left" ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_RIGHTDOWN,
  });
  const up = buildMouseInput({
    flags: button === "left" ? MOUSEEVENTF_LEFTUP : MOUSEEVENTF_RIGHTUP,
  });
  sendInputs(Buffer.concat(double ? [down, up, down, up] : [down, up]));
}

export function mouseScroll(amount: number): void {
  sendInputs(buildMouseInput({ data: amount * 120, flags: MOUSEEVENTF_WHEEL }));
}

const SRCCOPY = 0x00cc0020;
const PW_RENDERFULLCONTENT = 2;

export interface CapturedFrame {
  width: number;
  height: number;
  /** BGRA rows, top-down. */
  pixels: Buffer;
  method: "printwindow" | "bitblt-screen";
  /** Fraction of non-black pixels — catches PrintWindow's black swapchain frame. */
  brightness: number;
}

/** BGRA → RGB drop-in conversion. */
export function bgraToRgb(bgra: Buffer): Buffer {
  const out = Buffer.alloc((bgra.length / 4) * 3);
  for (let i = 0, j = 0; i < bgra.length; i += 4, j += 3) {
    out[j] = bgra[i + 2] ?? 0;
    out[j + 1] = bgra[i + 1] ?? 0;
    out[j + 2] = bgra[i] ?? 0;
  }
  return out;
}

export function captureWindow(hwnd: bigint): CapturedFrame {
  const a = need();
  const rect = getWindowRectOf(hwnd);
  if (!rect) throw new Error("window has no rect (minimized?)");
  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;
  if (w <= 0 || h <= 0) throw new Error(`degenerate window rect ${w}x${h}`);

  const bits = Buffer.alloc(w * h * 4);
  const bmi = Buffer.alloc(40);
  bmi.writeUInt32LE(40, 0);
  bmi.writeInt32LE(w, 4);
  bmi.writeInt32LE(-h, 8); // top-down
  bmi.writeUInt16LE(1, 12);
  bmi.writeUInt16LE(32, 14);

  let method: CapturedFrame["method"] = "printwindow";
  // Every GDI object acquired below is released in the finally block, in
  // reverse order, whatever throws in between — a failed screenshot must not
  // leak a DC or bitmap per attempt.
  const hdcWindow = a.GetWindowDC(hwnd);
  if (!hdcWindow) throw new Error("GetWindowDC failed (window gone?)");
  let hdcMem: unknown = null;
  let hbmp: unknown = null;
  let old: unknown = null;
  let hdcScreen: unknown = null;
  try {
    hdcMem = a.CreateCompatibleDC(hdcWindow);
    hbmp = a.CreateCompatibleBitmap(hdcWindow, w, h);
    if (!hdcMem || !hbmp) throw new Error("could not create an offscreen GDI surface");
    old = a.SelectObject(hdcMem, hbmp);
    let ok = a.PrintWindow(hwnd, hdcMem, PW_RENDERFULLCONTENT);
    a.GetDIBits(hdcMem, hbmp, 0, h, bits, bmi, 0);
    let brightness = measureBrightness(bits);
    if (!ok || brightness < DEFAULTS.blackFrameThreshold) {
      // GTA renders through a flip-model swapchain: PrintWindow can hand back a
      // black frame. Screen BitBlt then captures what the player actually sees —
      // the window must be unoccluded (hence ensureFocused at the tool layer).
      method = "bitblt-screen";
      hdcScreen = a.GetDC(BigInt(0));
      ok = a.BitBlt(hdcMem, 0, 0, w, h, hdcScreen, rect.left, rect.top, SRCCOPY);
      a.GetDIBits(hdcMem, hbmp, 0, h, bits, bmi, 0);
      brightness = measureBrightness(bits);
    }
    if (!ok) throw new Error("window capture failed (PrintWindow and BitBlt both returned false)");
    return { width: w, height: h, pixels: bits, method, brightness };
  } finally {
    if (hdcScreen) a.ReleaseDC(BigInt(0), hdcScreen);
    if (hdcMem && old) a.SelectObject(hdcMem, old);
    if (hbmp) a.DeleteObject(hbmp);
    if (hdcMem) a.DeleteDC(hdcMem);
    a.ReleaseDC(hwnd, hdcWindow);
  }
}

/** Fraction of lit pixels, sampled every 16th pixel: plenty to tell a black swapchain frame. */
export function measureBrightness(bgra: Buffer): number {
  const step = 4 * 16;
  let lit = 0;
  let sampled = 0;
  for (let i = 0; i + 2 < bgra.length; i += step) {
    sampled++;
    const sum = (bgra[i] as number) + (bgra[i + 1] as number) + (bgra[i + 2] as number);
    if (sum > DEFAULTS.litPixelMinSum) lit++;
  }
  return sampled === 0 ? 0 : lit / sampled;
}
