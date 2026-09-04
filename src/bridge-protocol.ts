// Pure encode/parse for the mcpb bridge protocol — the string-level contract
// between the MCP tools and bridge/server.js. Everything rides either the RCON
// reply (server ops print inside the capture scope) or the server log tail
// (client ops come back as MCP_RESULT lines).

import type { Target } from "./types.js";

export interface BridgeResult {
  ok: boolean;
  data?: unknown;
  error?: string | undefined;
}

export function newCallId(): string {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function encodeRequest(req: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(req), "utf8").toString("base64");
}

/** Console command line: `mcpb <id> <target> <src|-> <base64 json>` — no spaces in tokens. */
export function buildCommandLine(
  id: string,
  target: Target,
  src: number | null,
  req: Record<string, unknown>,
): string {
  return `mcpb ${id} ${target} ${src ?? "-"} ${encodeRequest(req)}`;
}

function afterPrefix(line: string, prefix: string): string | null {
  const index = line.indexOf(prefix);
  if (index === -1) return null;
  return line.slice(index + prefix.length).trim();
}

/** `MCP_RESULT <id> <json>` → parsed result, or null when the line is about another id. */
export function parseResultLine(line: string, id: string): BridgeResult | null {
  const rest = afterPrefix(line, `MCP_RESULT ${id} `);
  if (rest === null || rest.length === 0) return null;
  try {
    return JSON.parse(rest) as BridgeResult;
  } catch {
    return { ok: false, error: `unparseable bridge result JSON: ${rest.slice(0, 120)}` };
  }
}

export function parseErrorLine(line: string, id: string): string | null {
  const rest = afterPrefix(line, `MCPB_ERR ${id} `);
  return rest;
}

export function looksLikeMissingResource(output: string): boolean {
  return /no such command\b.*mcpb/i.test(output);
}
