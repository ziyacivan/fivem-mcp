import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULTS } from "../defaults.js";
import { DESTRUCTIVE, defineTool, structured, type ToolContext } from "./_shared.js";

/** Ops each half of the mcpb resource implements (bridge/server.js, bridge/client.js). */
export const SERVER_OPS = [
  "ping",
  "players",
  "poll",
  "call_export",
  "trigger_event",
  "wait",
] as const;
export const CLIENT_OPS = [
  "ping",
  "position",
  "teleport",
  "freeze",
  "call_native",
  "send_nui",
  "nui_callback",
] as const;

const ALL_OPS = [...new Set<string>([...SERVER_OPS, ...CLIENT_OPS])] as [string, ...string[]];

const jsonObject = z.record(z.string(), z.unknown());

export function registerBridgeTools(server: McpServer, { hub }: ToolContext): void {
  defineTool(
    server,
    "bridge",
    {
      title: "Invoke a bridge operation (mcpb resource)",
      description:
        "Runs an operation through the mcpb bridge resource — the half neither devcon nor " +
        `RCON can reach. Server ops (target=server): ${SERVER_OPS.join(", ")}; call_export ` +
        "{resource, method, args}, trigger_event {event, args, toClient?, player?} " +
        "(event names must be in mcpb_event_allowlist). Client ops (target=client, needs src): " +
        `${CLIENT_OPS.join(", ")}; teleport {x,y,z,heading?}, freeze {freeze}, call_native ` +
        "{name, args}, send_nui {resource, message, event?}, nui_callback {resource, endpoint, " +
        "payload}. Client results are collected in-band via the bridge's poll queue — no " +
        "FIVEM_SERVER_LOG needed. The bridge must be installed, started and enabled " +
        "(mcpb_enabled true).",
      inputSchema: {
        target: z
          .enum(["server", "client"])
          .describe("Where the op runs — server console or game client"),
        op: z.enum(ALL_OPS).describe("Operation name (see description for which target)"),
        src: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Player server id (required for target=client)"),
        args: z
          .string()
          .optional()
          .describe('Operation arguments as a JSON object string, e.g. {"resource":"chat"}'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(60000)
          .optional()
          .describe(`Client-op result wait (default ${DEFAULTS.bridgeTimeoutMs})`),
      },
      outputSchema: {
        op: z.string(),
        target: z.enum(["server", "client"]),
        data: z.unknown(),
      },
      annotations: DESTRUCTIVE,
    },
    async (args, extra) => {
      const known: readonly string[] = args.target === "server" ? SERVER_OPS : CLIENT_OPS;
      if (!known.includes(args.op)) {
        throw new Error(
          `'${args.op}' is not a ${args.target} op — ${args.target} ops: ${known.join(", ")}`,
        );
      }
      if (args.target === "client" && args.src === undefined) {
        throw new Error("target=client needs src (the player's server id; see op=players)");
      }
      let extraArgs: Record<string, unknown> = {};
      if (args.args !== undefined && args.args !== "") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(args.args);
        } catch {
          throw new Error("args must be a JSON object string");
        }
        const checked = jsonObject.safeParse(parsed);
        if (!checked.success || Array.isArray(parsed)) {
          throw new Error("args must be a JSON object string");
        }
        extraArgs = checked.data;
      }
      const result = await hub.bridgeCall({
        target: args.target,
        op: args.op,
        src: args.src,
        extra: extraArgs,
        signal: extra.signal,
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      });
      if (!result.ok) {
        throw new Error(`bridge ${args.target}/${args.op} failed: ${result.error ?? "unknown"}`);
      }
      return structured({ op: args.op, target: args.target, data: result.data ?? null });
    },
  );
}
