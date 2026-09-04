// Console tools: connection status, the FXServer console over RCON, the client
// F8 console over devcon, and the read/wait primitives over both.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleLine } from "../console-buffer.js";
import { DEFAULTS } from "../defaults.js";
import {
  compileUserRegex,
  consoleCommand,
  defineTool,
  plain,
  renderLines,
  type ToolContext,
  targetArg,
  text,
} from "./_shared.js";

export function registerConsoleTools(server: McpServer, { config, hub }: ToolContext): void {
  defineTool(
    server,
    "status",
    {
      title: "Connection status",
      description:
        "Report RCON configuration for the server, the devcon connection to the FiveM client " +
        "console, and the server log-file tailer. Call this first.",
      inputSchema: {},
    },
    async () =>
      text({
        host: config.host,
        clientDevconPorts: config.clientDevconPorts,
        ...(await hub.status()),
      }),
  );

  defineTool(
    server,
    "server_info",
    {
      title: "Query server identity (no credentials)",
      description:
        "Ask the server's getinfo out-of-band endpoint: hostname, players online, max " +
        "clients, protocol, game build. Works without rcon_password; use it to confirm " +
        "which server you are pointed at.",
      inputSchema: {},
    },
    async () => text(await hub.serverInfo()),
  );

  defineTool(
    server,
    "server_command",
    {
      title: "Run an FXServer console command",
      description:
        "Execute a command on the server console over UDP RCON (any command the console " +
        "accepts: ensure/stop/restart, convars, registered commands). The reply carries the " +
        "command's captured console output. Needs `rcon_password` on the server and " +
        "FIVEM_RCON_PASSWORD here; rate-limited server-side (~5 burst).",
      inputSchema: {
        command: consoleCommand.describe(
          "Command text without a leading slash, e.g. 'restart breeze-chat'",
        ),
      },
    },
    async (args) => {
      const output = await hub.runServerCommand(args.command);
      return plain(output.trimEnd() || "(no output)");
    },
  );

  defineTool(
    server,
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
        command: consoleCommand.describe("Command text, e.g. 'connect localhost:30120'"),
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
    async (args) => {
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
  );

  defineTool(
    server,
    "read_console",
    {
      title: "Read recent console output",
      description:
        "Return recent console lines without running anything. For 'client', reads the devcon " +
        "line buffer (live from the moment this server first connected; supports afterSeq " +
        "paging). For 'server', tails FIVEM_SERVER_LOG (FXServer's redirected stdout) — the " +
        `last ${DEFAULTS.logTailBytes / 1024} KB, filtered; afterSeq is not supported there.`,
      inputSchema: {
        target: targetArg,
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe(`Max lines (default ${DEFAULTS.readLimit})`),
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
    async (args) => {
      if (args.pattern !== undefined) compileUserRegex(args.pattern);
      const options = {
        limit: args.limit ?? DEFAULTS.readLimit,
        channel: args.channel,
        contains: args.contains,
        pattern: args.pattern,
      };
      let lines: ConsoleLine[];
      let nextSeq: number;
      let clientError: string | null = null;
      if (args.target === "server") {
        lines = await hub.requireServerLog().tail(options);
        nextSeq = -1;
      } else {
        // A dead client is not an error here — the buffer still holds what was
        // seen — but say why it is not live instead of silently serving stale lines.
        await hub.ensureClient().catch(() => undefined);
        clientError = hub.lastClientError;
        lines = hub.clientBuffer.tail({ ...options, afterSeq: args.afterSeq });
        nextSeq = hub.clientBuffer.latestSeq;
      }
      return text({
        nextSeq,
        matched: lines.length,
        ...(clientError ? { clientError } : {}),
        lines: lines.map((line) => ({
          seq: line.seq,
          channel: line.channel,
          message: line.message,
        })),
      });
    },
  );

  defineTool(
    server,
    "wait_for_console",
    {
      title: "Wait for a console line to appear",
      description:
        "Block until a line matching a regex appears. 'client' watches the live devcon stream; " +
        "'server' polls FIVEM_SERVER_LOG for newly written lines (only lines appended after " +
        "the call count). Use after a fire-and-forget command, to watch for a resource's " +
        "startup banner, an error, or a scripted RESULT: line.",
      inputSchema: {
        target: targetArg,
        pattern: z.string().describe("JS regex, e.g. 'Started resource breeze-chat'"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(120000)
          .optional()
          .describe(`Default ${DEFAULTS.waitForConsoleTimeoutMs}`),
        afterSeq: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("client only: ignore lines up to this sequence number"),
      },
    },
    async (args) => {
      compileUserRegex(args.pattern);
      const timeoutMs = args.timeoutMs ?? DEFAULTS.waitForConsoleTimeoutMs;
      let line: ConsoleLine;
      if (args.target === "server") {
        line = await hub.requireServerLog().waitFor(args.pattern, { timeoutMs });
      } else {
        await hub.ensureClient();
        line = await hub.clientBuffer.waitFor(args.pattern, {
          afterSeq: args.afterSeq,
          timeoutMs,
        });
      }
      return text({ seq: line.seq, channel: line.channel, message: line.message });
    },
  );

  defineTool(
    server,
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
    async (args) => {
      const connection = await hub.ensureClient();
      const needle = args.contains?.toLowerCase();
      const commands = [...connection.commands]
        .filter((command) => needle === undefined || command.toLowerCase().includes(needle))
        .sort();
      return text({ count: commands.length, commands });
    },
  );
}
