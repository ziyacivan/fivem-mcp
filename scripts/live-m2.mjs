// M2 live verification against the real game window. Run from the repo root:
//   pnpm live:m2
// Sequence: launch FiveM -> wait for the game window -> screenshot -> devcon
// handshake -> tap F8 (console open/close) -> screenshot again -> restore focus -> quit.

import { loadConfig } from "../dist/config.js";
import { launchFiveM } from "../dist/launcher.js";
import { focusWindow, foregroundHwnd, pressKey } from "../dist/win/win32.js";
import {
  check,
  connectDevconRetry,
  finish,
  quitViaDevcon,
  shot,
  sleep,
  waitForGameWindow,
} from "./lib.mjs";

const config = loadConfig();
const previousForeground = foregroundHwnd();
console.log("foreground before:", previousForeground);

const launched = await launchFiveM(`${config.rconHost}:${config.rconPort}`);
check("launch", !!launched.pid, `pid ${launched.pid}`);

const game = await waitForGameWindow(100, 3000);
check("window found", !!game, game ? `'${game.title}' pid=${game.pid}` : "timeout 300s");
if (!game) process.exit(1);
console.log("window:", JSON.stringify(game));

// wait for the game to actually load (devcon socket appears early; NUI takes longer)
await sleep(45000);

check("focus", focusWindow(game.hwnd));
const first = shot(game, "m2-loading");
check(
  "screenshot not black",
  first.brightness > 0.05,
  `brightness ${(first.brightness * 100).toFixed(1)}%`,
);

const connection = await connectDevconRetry(config, 3, 2000);
check(
  "devcon handshake (live)",
  !!connection?.info?.commandLine,
  `channels=${connection?.channels.size ?? 0}`,
);

// console open/close via real key injection
focusWindow(game.hwnd);
await pressKey("f8");
await sleep(400);
shot(game, "m2-f8-open");
await pressKey("f8");
await sleep(400);
shot(game, "m2-f8-close");
check("game still up after key taps", !!(await waitForGameWindow(1, 0)));

// graceful exit last
if (connection) check("quit via devcon closes the game", await quitViaDevcon(connection));

await sleep(500);
if (previousForeground) focusWindow(previousForeground);
finish("M2 LIVE");
