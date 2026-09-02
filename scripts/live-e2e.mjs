// Live end-to-end client verification. Needs: FXServer up + FiveM Legacy client
// running (connected or not). Assertions reflect the live-verified semantics:
// devcon CMND drives LOCAL console commands; resource chat commands are not in
// that context (see docs/protocol.md §3.3).

import { loadConfig } from "../dist/config.js";
import { Hub } from "../dist/hub.js";

const hub = new Hub(loadConfig());
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// [1] handshake
const connection = await hub.ensureClient();
check("handshake", !!connection.info?.commandLine, connection.info?.commandLine.slice(0, 90));
check("channels learned", connection.channels.size > 0, `${connection.channels.size} channels`);

// [2] CMND executes + PRNT streams back. 'connect' is a glue console command;
//     typing it while connected prints 'Ignoring ConnectTo' from [glue].
const lines = await hub.runClientCommand("connect localhost:30120", { timeoutMs: 6000 });
const glueEcho = lines.find(
  (line) => line.channel === "glue" && /ConnectTo|connect/i.test(line.message),
);
check(
  "CMND -> PRNT round trip",
  !!glueEcho,
  lines.map((l) => `[${l.channel}] ${l.message.slice(0, 60)}`).join(" | ") || "no lines",
);

// [3] server half (needs FIVEM_RCON_PASSWORD + FIVEM_SERVER_LOG)
if (hub.rcon.isConfigured && hub.serverLog) {
  const wait = hub.serverLog.waitFor("Scanning resources", { timeoutMs: 8000 });
  const out = await hub.runServerCommand("refresh");
  check(
    "rcon round trip",
    /Scanning resources/i.test(out),
    out.trim().split("\n")[0]?.slice(0, 60),
  );
  try {
    const hit = await wait;
    check("server log waitFor", true, `[${hit.channel}] ${hit.message.slice(0, 60)}`);
  } catch (error) {
    check("server log waitFor", false, error.message);
  }
  const info = await hub.serverInfo();
  check(
    "getinfo identity",
    !!info.hostname,
    `hostname=${info.hostname} clients=${info.clients}/${info.sv_maxclients} iv=${info.iv}`,
  );
} else {
  console.log("SKIP server half — set FIVEM_RCON_PASSWORD and FIVEM_SERVER_LOG");
}

hub.closeAll();
console.log(failures === 0 ? "ALL LIVE CHECKS PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
