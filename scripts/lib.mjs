// Shared helpers for the live-verification scripts (real FXServer + real game).
// The scripts import the built `dist/` — run `pnpm live:<name>` so it is fresh.

import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DevconConnection } from "../dist/protocol/devcon.js";
import { encodePng, renderFrame } from "../dist/win/png.js";
import { captureWindow, findGameWindow } from "../dist/win/win32.js";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where screenshots and captures land: $FIVEM_LIVE_OUT or a temp folder. */
export const OUT_DIR = process.env.FIVEM_LIVE_OUT ?? path.join(os.tmpdir(), "fivem-mcp-live");
mkdirSync(OUT_DIR, { recursive: true });

let failures = 0;
export const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
export const failureCount = () => failures;
export function finish(label) {
  console.log(failures === 0 ? `${label}: ALL PASSED` : `${label}: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * The real game window only. The bootstrapper is titled plain "FiveM"; the game
 * process says "FiveM® by Cfx.re - <server>" — only that means natives exist.
 */
export function realGameWindow() {
  const game = findGameWindow();
  return game && /cfx\.re/i.test(game.title) ? game : null;
}

/** Poll for the real game window; `attempts` x `everyMs`. */
export async function waitForGameWindow(attempts = 120, everyMs = 3000) {
  for (let i = 0; i < attempts; i++) {
    const game = realGameWindow();
    if (game) return game;
    await sleep(everyMs);
  }
  return null;
}

/** Devcon may need a few tries while the game process loads. */
export async function connectDevconRetry(config, attempts = 10, everyMs = 3000) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await DevconConnection.connectFirstUsable(config.host, config.clientDevconPorts);
    } catch {
      await sleep(everyMs);
    }
  }
  return null;
}

/** Capture, downscale and save a PNG of the game window; returns the frame stats. */
export function shot(game, label, maxSide = 1280) {
  const frame = captureWindow(game.hwnd);
  const scaled = renderFrame(frame.pixels, frame.width, frame.height, { maxSide });
  const png = encodePng(scaled.width, scaled.height, scaled.rgb);
  const file = path.join(OUT_DIR, `${label}.png`);
  writeFileSyncSafe(file, png);
  console.log(
    `  shot ${label}: ${frame.width}x${frame.height} via ${frame.method}, brightness ${(frame.brightness * 100).toFixed(0)}%, ${(png.length / 1024).toFixed(0)} KB -> ${file}`,
  );
  return frame;
}

async function writeFileSyncSafeImport() {
  return (await import("node:fs")).writeFileSync;
}
const writeFileSync = await writeFileSyncSafeImport();
function writeFileSyncSafe(file, data) {
  writeFileSync(file, data);
}

/** Graceful quit over devcon; resolves true when the socket closed within `waitMs`. */
export async function quitViaDevcon(connection, waitMs = 15000) {
  if (!connection) return false;
  connection.print("quit");
  return Promise.race([
    new Promise((resolve) => connection.once("close", () => resolve(true))),
    sleep(waitMs).then(() => false),
  ]);
}
