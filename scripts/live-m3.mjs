// M3 live verification. Launches FiveM if needed and waits for the REAL game
// window (the bootstrapper is titled "FiveM" too — only "by Cfx.re" means the
// game process), then: players -> position(no-ped/coords) -> Enter to select ->
// spawn -> teleport -> read back -> screenshot -> quit.

import { writeFileSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { Hub } from "../dist/hub.js";
import { latestClientLog, launchFiveM } from "../dist/launcher.js";
import { DevconConnection } from "../dist/protocol/devcon.js";
import { ServerLogFile } from "../dist/protocol/server-log.js";
import { downscaleRgb, encodePng } from "../dist/win/png.js";
import {
  bgraToRgb,
  captureWindow,
  findGameWindow,
  focusWindow,
  pressKey,
} from "../dist/win/win32.js";

const OUT = "C:\\Users\\yusuf\\AppData\\Local\\Temp\\opencode\\";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const hub = new Hub(loadConfig());

const realGameWindow = () => {
  const g = findGameWindow();
  return g && /cfx\.re/i.test(g.title) ? g : null;
};

// [0] boot the game and wait for the actual game window (not the bootstrapper)
let game = realGameWindow();
if (!game) {
  console.log("game window (Cfx.re) not up — launching");
  await launchFiveM("localhost:30120").catch(() => undefined);
  for (let i = 0; i < 120 && !game; i++) {
    await sleep(3000);
    game = realGameWindow();
  }
}
check("game window", !!game, game?.title);
if (!game) process.exit(1);

// [1] devcon may need a few tries while the game process loads
let connection = null;
for (let i = 0; i < 10 && !connection; i++) {
  try {
    connection = await DevconConnection.connectFirstUsable("127.0.0.1", [29200, 29300]);
  } catch (error) {
    await sleep(3000);
  }
}
check("devcon", !!connection);

// [2] wait for the join, polling the bridge server half (tolerate transient errors)
let src = 0;
let lastError = "";
for (let i = 0; i < 80 && !src; i++) {
  try {
    const players = await hub.bridgeCall({ target: "server", op: "players" });
    if (players.ok && Array.isArray(players.data) && players.data.length > 0) {
      src = players.data[0].src;
      check(
        "bridge players sees the join",
        true,
        JSON.stringify(players.data.map((p) => `${p.src}:${p.name}`)),
      );
    } else if (!players.ok) {
      lastError = String(players.error);
    }
  } catch (error) {
    lastError = String(error.message ?? error);
  }
  if (!src) await sleep(3000);
}
check("player connected", src > 0, lastError);
if (!src) process.exit(1);

// [3] client op: at the character screen 'no ped' is the right answer
let spawned = null;
const pos = await hub
  .bridgeCall({ target: "client", op: "position", src, timeoutMs: 12000 })
  .catch((e) => ({ ok: false, error: String(e.message) }));
const noPed = !pos.ok && /no local ped/i.test(String(pos.error));
if (pos.ok) spawned = pos.data;
check(
  "position answers (no-ped or coords)",
  noPed || pos.ok,
  JSON.stringify(pos.data ?? pos.error),
);

// [4] if parked on the character screen: pick the first character with a real Enter
if (!spawned) {
  focusWindow(game.hwnd);
  pressKey("enter");
  console.log("  Enter pressed — waiting for the spawn flow...");
  for (let i = 0; i < 40 && !spawned; i++) {
    await sleep(3000);
    const tryPos = await hub
      .bridgeCall({ target: "client", op: "position", src, timeoutMs: 8000 })
      .catch(() => null);
    if (tryPos?.ok) spawned = tryPos.data;
  }
}
check("position after spawn (in-game)", !!spawned, JSON.stringify(spawned));

// [5] teleport through the bridge, read back
if (spawned) {
  const target = { x: spawned.x + 10, y: spawned.y, z: spawned.z };
  await hub.bridgeCall({ target: "client", op: "teleport", src, extra: target, timeoutMs: 8000 });
  await sleep(1500);
  const after = await hub.bridgeCall({ target: "client", op: "position", src, timeoutMs: 8000 });
  const moved = after.ok && Math.abs(after.data.x - (spawned.x + 10)) < 5;
  check(
    "teleport -> position moved",
    moved,
    `${spawned.x?.toFixed?.(1)} -> ${after.data?.x?.toFixed?.(1)}`,
  );
}

// [6] screenshot + client log cross-check, then a graceful quit
game = realGameWindow() ?? game;
focusWindow(game.hwnd);
await sleep(1000);
const frame = captureWindow(game.hwnd);
const scaled = downscaleRgb(bgraToRgb(frame.pixels), frame.width, frame.height, 1280);
writeFileSync(`${OUT}m3-final.png`, encodePng(scaled.width, scaled.height, scaled.rgb));
check(
  "final screenshot",
  frame.brightness > 0.05,
  `brightness ${(frame.brightness * 100).toFixed(0)}%, ${frame.method}`,
);

const clientLog = latestClientLog();
if (clientLog) {
  const lines = await new ServerLogFile(clientLog).tail({ limit: 200, contains: "mcpb" });
  check("client log shows bridge activity", lines.length > 0, `${lines.length} mcpb lines`);
}

if (connection) {
  connection.print("quit");
  await Promise.race([new Promise((r) => connection.once("close", r)), sleep(15000)]);
  console.log("  quit sent");
}
hub.closeAll();
console.log(failures === 0 ? "M3 LIVE: ALL PASSED" : `M3 LIVE: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
