import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULTS } from "../defaults.js";
import { latestClientLog } from "../launcher.js";
import { ServerLogFile } from "../protocol/server-log.js";
import { sleep } from "../util.js";
import { compileUserRegex, defineTool, plain, text } from "./_shared.js";

export function registerMiscTools(server: McpServer): void {
  defineTool(
    server,
    "wait",
    {
      title: "Pause",
      description: "Sleep between actions — loading screens, walk cycles, held-key sequences.",
      inputSchema: { ms: z.number().int().min(0).max(120000) },
    },
    async (args) => {
      await sleep(args.ms);
      return plain(`waited ${args.ms}ms`);
    },
  );

  defineTool(
    server,
    "read_client_log",
    {
      title: "Read the FiveM client log file",
      description:
        "Tail the newest CitizenFX_log_*.log under the FiveM install — the same stream as " +
        "read_console(client) but persisted across sessions, without the channel tags.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe(`default ${DEFAULTS.readLimit}`),
        contains: z.string().optional(),
        pattern: z.string().optional(),
      },
    },
    async (args) => {
      if (args.pattern !== undefined) compileUserRegex(args.pattern);
      const file = await latestClientLog();
      if (!file) {
        throw new Error(
          "no CitizenFX_log_*.log found — is FiveM installed, and where? (checked %LOCALAPPDATA%\\FiveM\\FiveM.app\\logs)",
        );
      }
      const lines = await new ServerLogFile(file).tail({
        limit: args.limit ?? DEFAULTS.readLimit,
        contains: args.contains,
        pattern: args.pattern,
      });
      return text({
        file,
        matched: lines.length,
        lines: lines.map((l) => `${l.channel ? `[${l.channel}] ` : ""}${l.message}`),
      });
    },
  );
}
