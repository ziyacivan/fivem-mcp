import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "./config.js";
import type { ConsoleLine } from "./console-buffer.js";
import type { Hub, Target } from "./hub.js";

function text(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function plain(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function renderLines(lines: ConsoleLine[]): string {
  if (lines.length === 0) return "(no output)";
  return lines.map((line) => `[${line.channel}] ${line.message}`).join("\n");
}

/** Tool failures come back as isError results with the message, never as crashes. */
function guarded<A>(handler: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };
}

const TARGET_DESCRIPTION =
  "'server' = the FXServer console (UDP RCON; needs rcon_password). " +
  "'client' = the F8 console of a running FiveM Legacy client (devcon 29200/29300) — " +
  "LOCAL console commands only (connect, quit, tooling); RegisterCommand chat commands " +
  "are not console commands.";

export function buildMcpServer(config: Config, hub: Hub): McpServer {
  const server = new McpServer({ name: "fivem-mcp-server", version: "0.1.0" });

  server.registerTool(
    "status",
    {
      title: "Connection status",
      description:
        "Report RCON configuration for the server, the devcon connection to the FiveM client " +
        "console, and the server log-file tailer. Call this first.",
      inputSchema: {},
    },
    guarded(async () => {
      return text({
        host: config.host,
        clientDevconPorts: config.clientDevconPorts,
        ...(await hub.status()),
      });
    }),
  );

  server.registerTool(
    "server_info",
    {
      title: "Query server identity (no credentials)",
      description:
        "Ask the server's getinfo out-of-band endpoint: hostname, players online, max " +
        "clients, protocol, game build. Works without rcon_password; use it to confirm " +
        "which server you are pointed at.",
      inputSchema: {},
    },
    guarded(async () => {
      return text(await hub.serverInfo());
    }),
  );

  server.registerTool(
    "server_command",
    {
      title: "Run an FXServer console command",
      description:
        "Execute a command on the server console over UDP RCON (any command the console " +
        "accepts: ensure/stop/restart, convars, registered commands). The reply carries the " +
        "command's captured console output. Needs `rcon_password` on the server and " +
        "FIVEM_RCON_PASSWORD here; rate-limited server-side (~5 burst).",
      inputSchema: {
        command: z
          .string()
          .describe("Command text without a leading slash, e.g. 'restart breeze-chat'"),
      },
    },
    guarded(async (args: { command: string }) => {
      const output = await hub.runServerCommand(args.command);
      return plain(output.trimEnd() || "(no output)");
    }),
  );

  server.registerTool(
    "client_command",
    {
      title: "Run a FiveM client (F8) console command",
      description:
        "Type a LOCAL console command into the running Legacy client's F8 console over " +
        "devcon — no screen focus needed, nothing is typed into the game window. This is " +
        "the process's console context (connect, quit, tooling commands), NOT the chat " +
        "command layer: commands registered with RegisterCommand are chat commands and " +
        "live in a different system (run them through server_command, which has console " +
        "privileges, or drive the chat UI with the M2 input tools). Waits until output " +
        "goes quiet and returns the lines the client console printed.",
      inputSchema: {
        command: z.string().describe("Command text, e.g. 'connect localhost:30120'"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(120000)
          .optional()
          .describe(`Max ms to wait for output (default ${config.commandTimeoutMs})`),
        waitForOutput: z
          .boolean()
          .optional()
          .describe("Set false to fire without waiting (long-loading maps, blocking commands)"),
      },
    },
    guarded(
      async (args: {
        command: string;
        timeoutMs?: number | undefined;
        waitForOutput?: boolean | undefined;
      }) => {
        if (args.waitForOutput === false) {
          const connection = await hub.ensureClient();
          connection.print(args.command);
          return plain(`sent to client: ${args.command}`);
        }
        const lines = await hub.runClientCommand(args.command, {
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        });
        return plain(renderLines(lines));
      },
    ),
  );

  server.registerTool(
    "read_console",
    {
      title: "Read recent console output",
      description:
        "Return recent console lines without running anything. For 'client', reads the devcon " +
        "line buffer (live from the moment this server first connected; supports afterSeq " +
        "paging). For 'server', tails FIVEM_SERVER_LOG (FXServer's redirected stdout) — the " +
        "last 512 KB, filtered; afterSeq is not supported there.",
      inputSchema: {
        target: z.enum(["server", "client"]).describe(TARGET_DESCRIPTION),
        limit: z.number().int().positive().max(1000).optional().describe("Max lines (default 100)"),
        channel: z
          .string()
          .optional()
          .describe("Exact channel name, e.g. 'breeze-chat' or 'script:breeze-chat'"),
        contains: z.string().optional().describe("Case-insensitive substring of the message"),
        pattern: z.string().optional().describe("JS regex matched against '<channel>: <message>'"),
        afterSeq: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("client only: lines after this sequence number (response carries nextSeq)"),
      },
    },
    guarded(
      async (args: {
        target: Target;
        limit?: number | undefined;
        channel?: string | undefined;
        contains?: string | undefined;
        pattern?: string | undefined;
        afterSeq?: number | undefined;
      }) => {
        const options = {
          limit: args.limit,
          channel: args.channel,
          contains: args.contains,
          pattern: args.pattern,
        };
        let lines: ConsoleLine[];
        let nextSeq: number;
        if (args.target === "server") {
          if (!hub.serverLog) {
            throw new Error(
              "server console needs FIVEM_SERVER_LOG pointed at FXServer's redirected stdout (no server devcon on modern builds)",
            );
          }
          lines = await hub.serverLog.tail(options);
          nextSeq = -1;
        } else {
          await hub.ensureClient().catch(() => undefined);
          lines = hub.clientBuffer.tail({ ...options, afterSeq: args.afterSeq });
          nextSeq = hub.clientBuffer.latestSeq;
        }
        return text({
          nextSeq,
          matched: lines.length,
          lines: lines.map((line) => ({
            seq: line.seq,
            channel: line.channel,
            message: line.message,
          })),
        });
      },
    ),
  );

  server.registerTool(
    "wait_for_console",
    {
      title: "Wait for a console line to appear",
      description:
        "Block until a line matching a regex appears. 'client' watches the live devcon stream; " +
        "'server' polls FIVEM_SERVER_LOG for newly written lines (only lines appended after " +
        "the call count). Use after a fire-and-forget command, to watch for a resource's " +
        "startup banner, an error, or a scripted RESULT: line.",
      inputSchema: {
        target: z.enum(["server", "client"]).describe(TARGET_DESCRIPTION),
        pattern: z.string().describe("JS regex, e.g. 'Started resource breeze-chat'"),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Default 10000"),
        afterSeq: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("client only: ignore lines up to this sequence number"),
      },
    },
    guarded(
      async (args: {
        target: Target;
        pattern: string;
        timeoutMs?: number | undefined;
        afterSeq?: number | undefined;
      }) => {
        const timeoutMs = args.timeoutMs ?? 10000;
        let line: ConsoleLine;
        if (args.target === "server") {
          if (!hub.serverLog) {
            throw new Error(
              "server console needs FIVEM_SERVER_LOG pointed at FXServer's redirected stdout (no server devcon on modern builds)",
            );
          }
          line = await hub.serverLog.waitFor(args.pattern, { timeoutMs });
        } else {
          await hub.ensureClient();
          line = await hub.clientBuffer.waitFor(args.pattern, {
            afterSeq: args.afterSeq,
            timeoutMs,
          });
        }
        return text({ seq: line.seq, channel: line.channel, message: line.message });
      },
    ),
  );

  server.registerTool(
    "list_commands",
    {
      title: "List client console commands",
      description:
        "The devcon handshake streams every command the client console knows (CVAR frames). " +
        "For server commands, run 'help' through server_command instead. Filter with a " +
        "case-insensitive substring.",
      inputSchema: {
        contains: z.string().optional(),
      },
    },
    guarded(async (args: { contains?: string | undefined }) => {
      const connection = await hub.ensureClient();
      const needle = args.contains?.toLowerCase();
      const commands = [...connection.commands]
        .filter((command) => needle === undefined || command.toLowerCase().includes(needle))
        .sort();
      return text({ count: commands.length, commands });
    }),
  );

  return server;
}
