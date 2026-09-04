#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Hub } from "./hub.js";
import { buildMcpServer } from "./server.js";
import { releaseAllHeld } from "./win/win32.js";

const config = loadConfig();
const hub = new Hub(config);
const server = buildMcpServer(config, hub);

function releaseKeysQuietly(): void {
  try {
    releaseAllHeld();
  } catch {
    /* non-Windows or keyboard gone — nothing to release */
  }
}

let shuttingDown = false;
async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  releaseKeysQuietly();
  try {
    // Flush any in-flight response before the transport goes away.
    await server.close();
  } catch {
    /* transport already gone */
  }
  hub.closeAll();
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
// The MCP host closing our stdin is the stdio-transport way of saying goodbye;
// hosts do not reliably send a signal.
process.stdin.on("end", () => void shutdown(0));
process.on("exit", releaseKeysQuietly);

// A stray rejection must not leave W held down in the game: log to stderr
// (stdout belongs to the protocol), release, and exit non-zero.
process.on("unhandledRejection", (reason) => {
  console.error("fivem-mcp-server: unhandled rejection:", reason);
  void shutdown(1);
});
process.on("uncaughtException", (error) => {
  console.error("fivem-mcp-server: uncaught exception:", error);
  void shutdown(1);
});

await server.connect(new StdioServerTransport());

console.error(
  `fivem-mcp-server ready — host=${config.host} client-devcon=${config.clientDevconPorts.join("/")} ` +
    `rcon=${config.rconPassword ? `${config.rconHost}:${config.rconPort}` : "not configured"} ` +
    `server-log=${config.serverLogFile ?? "not configured"}`,
);
