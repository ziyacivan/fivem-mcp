// Plumbing every tool module shares: result shaping, the error guard, and the
// `defineTool` helper that derives the handler's argument type from its zod
// shape (no hand-written duplicate of the schema).

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "../config.js";
import type { ConsoleLine } from "../console-buffer.js";
import type { Hub } from "../hub.js";
import { warn } from "../log.js";
import { errorMessage } from "../util.js";

export interface ToolContext {
  config: Config;
  hub: Hub;
}

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** The argument object a zod raw shape parses into. */
export type ArgsOf<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

export type ToolHandler<S extends z.ZodRawShape> = (
  args: ArgsOf<S>,
  extra: ToolExtra,
) => Promise<CallToolResult>;

export interface ToolSpec<S extends z.ZodRawShape> {
  title: string;
  description: string;
  inputSchema: S;
  /** Declared for tools that answer with `structured()`; the SDK validates the payload. */
  outputSchema?: z.ZodRawShape | z.ZodType;
  annotations: ToolAnnotations;
}

// ─── annotation presets ───────────────────────────────────────────────────────
// Hints only (per spec) — hosts use them to decide how much confirmation to ask for.

/** Looks at state, changes nothing, same answer for the same world. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** Acts on the game/server but can be repeated without extra harm (move, click, focus). */
export const ACTS_SAFELY: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** Can stop/kill/alter the server or game (console root, quit, arbitrary natives). */
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

// ─── results ─────────────────────────────────────────────────────────────────

/** JSON payload as text only (tools without an outputSchema). */
export function text(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/**
 * JSON payload as `structuredContent` plus a compact text rendering for clients
 * that only read `content`. Pair with `outputSchema` on the tool.
 */
export function structured<T extends Record<string, unknown>>(payload: T): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export function plain(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

export function failure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function renderLines(lines: ConsoleLine[]): string {
  if (lines.length === 0) return "(no output)";
  return lines.map((line) => `[${line.channel}] ${line.message}`).join("\n");
}

/** Tool failures come back as isError results with the message, never as crashes. */
export function guarded<S extends z.ZodRawShape>(
  name: string,
  handler: ToolHandler<S>,
): ToolHandler<S> {
  return async (args, extra) => {
    try {
      return await handler(args, extra);
    } catch (error) {
      const message = errorMessage(error);
      if (!extra.signal.aborted) warn(name, message);
      return failure(message);
    }
  };
}

/** Register a tool whose handler is typed from `inputSchema` and wrapped in `guarded`. */
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  spec: ToolSpec<S>,
  handler: ToolHandler<S>,
): void {
  server.registerTool(name, spec, guarded(name, handler) as unknown as ToolCallback<S>);
}

// ─── shared schema pieces ────────────────────────────────────────────────────

export const TARGET_DESCRIPTION =
  "'server' = the FXServer console (UDP RCON; needs rcon_password). " +
  "'client' = the F8 console of a running FiveM Legacy client (devcon 29200/29300) — " +
  "LOCAL console commands only (connect, quit, tooling); RegisterCommand chat commands " +
  "are not console commands.";

export const targetArg = z.enum(["server", "client"]).describe(TARGET_DESCRIPTION);

/**
 * One console command per call. A newline inside the text would smuggle a second
 * command into the RCON payload (`<pw> <cmd>\n<cmd2>`) or the devcon CMND frame.
 */
export const consoleCommand = z
  .string()
  .min(1)
  .regex(/^[^\r\n]*$/, "command must be a single line (no CR/LF)");

/** The shape of one console line in structured results. */
export const consoleLineShape = {
  seq: z.number().int(),
  channel: z.string(),
  message: z.string(),
};

/** A user-supplied JS regex source, compiled here so a bad pattern is a clear tool error. */
export function compileUserRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new Error(`invalid regex ${JSON.stringify(pattern)}: ${errorMessage(error)}`);
  }
}
