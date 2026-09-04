// Manual field probe against a real machine. Run with:  pnpm live:probe
// Needs: FXServer up (rcon_password optional), optionally a Legacy client running.

import { loadConfig } from "../dist/config.js";
import { Hub } from "../dist/hub.js";

const config = loadConfig();
const hub = new Hub(config);

console.log("status:", JSON.stringify(await hub.status(), null, 2));

try {
  console.log("getinfo:", JSON.stringify(await hub.serverInfo()));
} catch (error) {
  console.log("getinfo failed:", error.message);
}

try {
  const connection = await hub.ensureClient();
  console.log("client devcon:", connection.info?.commandLine?.slice(0, 100) ?? "(no AINF yet)");
  console.log("client channels:", [...connection.channels.values()].slice(0, 15).join(", "));
  console.log("client commands:", connection.commands.size);
} catch (error) {
  console.log("client devcon failed:", error.message);
}

// Server half: arm the log waiter BEFORE sending, so the cursor sits behind the
// line the command will echo ("waitFor" starts watching at call time).
if (hub.serverLog) {
  try {
    const linePromise = hub.serverLog.waitFor("Rcon from", { timeoutMs: 5000 });
    if (config.rconPassword) {
      // `status`/`who` are txAdmin-provided; a bare FXServer knows `refresh`.
      const out = await hub.runServerCommand("refresh");
      console.log("rcon refresh:", out.trim().split("\n").slice(0, 2).join(" | "));
    }
    const line = await linePromise;
    console.log(`log tail OK [${line.channel}] ${line.message.slice(0, 80)}`);
    const recent = await hub.serverLog.tail({ limit: 3, contains: "resource" });
    for (const x of recent) console.log(`  [${x.channel}] ${x.message.slice(0, 90)}`);
  } catch (error) {
    console.log("server half (rcon + log) failed:", error.message);
  }
} else if (config.rconPassword) {
  try {
    console.log("rcon refresh:", (await hub.runServerCommand("refresh")).trim().split("\n")[0]);
  } catch (error) {
    console.log("rcon failed:", error.message);
  }
} else {
  console.log("rcon: FIVEM_RCON_PASSWORD not set, skipping");
}

hub.closeAll();
process.exit(0);
