// M2 live verification against the real game window. Run from the repo root:
//   node scripts/live-m2.mjs
// Sequence: launch FiveM -> wait for window -> screenshot -> devcon handshake ->
// tap F8 (console open/close) -> screenshot again -> restore focus -> quit.

import { writeFileSync } from "node:fs";
import { launchFiveM } from "../dist/launcher.js";
import { DevconConnection } from "../dist/protocol/devcon.js";
import { downscaleRgb, encodePng } from "../dist/win/png.js";
import {
  bgraToRgb,
  captureWindow,
  findGameWindow,
  focusWindow,
  foregroundHwnd,
  pressKey,
} from "../dist/win/win32.js";

const OUT = "C:\\Users\\yusuf\\AppData\\Local\\Temp\\opencode\\";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const previousForeground = foregroundHwnd();
console.log("foreground before:", previousForeground);

const launched = await launchFiveM("localhost:30120");
check("launch", !!launched.pid, `pid ${launched.pid}`);

// wait for the game window
let game = null;
for (let i = 0; i < 100; i++) {
  await sleep(3000);
  game = findGameWindow();
  if (game) break;
}
check("window found", !!game, game ? `'${game.title}' pid=${game.pid}` : "timeout 300s");
if (!game) process.exit(1);
console.log("window:", JSON.stringify(game));

// wait for the game to actually load (devcon socket appears early; NUI takes longer)
await sleep(45000);

function shot(label) {
  const frame = captureWindow(game.hwnd);
  const scaled = downscaleRgb(bgraToRgb(frame.pixels), frame.width, frame.height, 1280);
  const png = encodePng(scaled.width, scaled.height, scaled.rgb);
  const file = `${OUT}m2-${label}.png`;
  writeFileSync(file, png);
  console.log(
    `  shot ${label}: ${frame.width}x${frame.height} via ${frame.method}, brightness ${(frame.brightness * 100).toFixed(0)}%, ${(png.length / 1024).toFixed(0)} KB -> ${file}`,
  );
  return frame;
}

check("focus", focusWindow(game.hwnd));
const f1 = shot("loading");
check(
  "screenshot not black",
  f1.brightness > 0.05,
  `brightness ${(f1.brightness * 100).toFixed(1)}%`,
);

// devcon from this same machine, while the game is up
let connection = null;
try {
  connection = await DevconConnection.connectFirstUsable("127.0.0.1", [29200, 29300]);
  check(
    "devcon handshake (live)",
    !!connection.info?.commandLine,
    `channels=${connection.channels.size}`,
  );
} catch (error) {
  check("devcon handshake (live)", false, error.message);
}

// console open/close via real key injection
focusWindow(game.hwnd);
pressKey("f8");
await sleep(400);
const f2 = shot("f8-open");
pressKey("f8");
await sleep(400);
shot("f8-close");
check("game still up after key taps", !!findGameWindow());

// graceful exit last
if (connection) {
  connection.print("quit");
  const closed = await Promise.race([
    new Promise((r) => connection.once("close", () => r(true))),
    sleep(15000).then(() => false),
  ]);
  check("quit via devcon closes the game", !!closed);
}

await sleep(500);
focusWindow(previousForeground);
console.log(failures === 0 ? "M2 LIVE: ALL PASSED" : `M2 LIVE: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
