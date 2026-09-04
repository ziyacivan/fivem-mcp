import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULTS } from "../defaults.js";
import { defineTool, type ToolContext, text } from "./_shared.js";

const jsonObject = z.record(z.string(), z.unknown());

export function registerBridgeTools(server: McpServer, { hub }: ToolContext): void {
  defineTool(
    server,
    "bridge",
    {
      title: "Invoke a bridge operation (mcpb resource)",
      description:
        "Runs an operation through the mcpb bridge resource — the half neither devcon nor " +
        "RCON can reach. Server ops (target=server): ping, players, poll, call_export " +
        "{resource, method, args}, trigger_event {event, args, toClient?, player?} " +
        "(event names must be in mcpb_event_allowlist). Client ops (target=client, needs src): " +
        "ping, position, teleport {x,y,z,heading?}, freeze {freeze}, call_native {name, args}, " +
        "send_nui {resource, message, event?}, nui_callback {resource, endpoint, payload}. " +
        "Client results are collected in-band via the bridge's poll queue — no FIVEM_SERVER_LOG " +
        "needed. The bridge must be installed, started and enabled (mcpb_enabled true).",
      inputSchema: {
        target: z
          .enum(["server", "client"])
          .describe("Where the op runs — server console or game client"),
        op: z.string().describe("Operation name (see description)"),
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
    },
    async (args) => {
      let extra: Record<string, unknown> = {};
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
        extra = checked.data;
      }
      const result = await hub.bridgeCall({
        target: args.target,
        op: args.op,
        src: args.src,
        extra,
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      });
      if (!result.ok) {
        throw new Error(`bridge ${args.target}/${args.op} failed: ${result.error ?? "unknown"}`);
      }
      return text({ op: args.op, target: args.target, data: result.data });
    },
  );
}
