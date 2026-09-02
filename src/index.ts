#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Hub } from "./hub.js";
import { buildMcpServer } from "./server.js";

const config = loadConfig();
const hub = new Hub(config);
const server = buildMcpServer(config, hub);

await server.connect(new StdioServerTransport());

// stdout belongs to the MCP protocol; diagnostics go to stderr.
console.error(
  `fivem-mcp-server ready — host=${config.host} client-devcon=${config.clientDevconPorts.join("/")} ` +
    `rcon=${config.rconPassword ? `${config.rconHost}:${config.rconPort}` : "not configured"} ` +
    `server-log=${config.serverLogFile ?? "not configured"}`,
);

const shutdown = () => {
  hub.closeAll();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
