// Diagnostics. stdout belongs to the MCP protocol, so everything here goes to
// stderr — and, once a client is connected, warnings also travel as MCP
// `notifications/message` so the host can show them next to the tool result.
//
// FIVEM_MCP_DEBUG=1 turns on the chatty per-frame / per-datagram trace.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const DEBUG = process.env.FIVEM_MCP_DEBUG === "1" || process.env.FIVEM_MCP_DEBUG === "true";

let mcp: McpServer | null = null;

/** Route warnings to the connected MCP client as logging notifications. */
export function attachMcpLogging(server: McpServer): void {
  mcp = server;
}

export function debug(scope: string, message: string): void {
  if (!DEBUG) return;
  process.stderr.write(`[fivem-mcp:${scope}] ${message}\n`);
}

export function warn(scope: string, message: string): void {
  process.stderr.write(`[fivem-mcp:${scope}] WARN ${message}\n`);
  if (mcp?.isConnected()) {
    void mcp.server
      .sendLoggingMessage({ level: "warning", logger: `fivem-mcp/${scope}`, data: message })
      .catch(() => undefined);
  }
}

export const debugEnabled = DEBUG;
