import { once } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "./config.js";
import type { ConsoleLine } from "./console-buffer.js";
import type { Hub, Target } from "./hub.js";
import { forceQuitFiveM, latestClientLog, launchFiveM } from "./launcher.js";
import { ServerLogFile } from "./protocol/server-log.js";
import { downscaleRgb, encodePng } from "./win/png.js";
import {
  bgraToRgb,
  captureWindow,
  findGameWindow,
  focusWindow,
  foregroundHwnd,
  getWindowRectOf,
  holdKey,
  mouseClick,
  mouseMove,
  mouseScroll,
  pressKey,
  releaseAllHeld,
  releaseKey,
  typeText,
} from "./win/win32.js";

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
  const server = new McpServer({ name: "fivem-mcp-server", version: "0.4.0" });

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

  // ─────────────────────────────────────────────────────────────────────────
  // M2 — window automation (Windows only; handlers report it clearly elsewhere)
  // ─────────────────────────────────────────────────────────────────────────

  let savedForeground: bigint | null = null;

  const ensureGameFocused = () => {
    const game = findGameWindow();
    if (!game) {
      throw new Error(
        "no FiveM game window found — start the client first (launch tool) and wait for it to reach the game",
      );
    }
    const fg = foregroundHwnd();
    if (fg !== game.hwnd) {
      if (savedForeground === null && fg) savedForeground = fg;
      if (!focusWindow(game.hwnd)) {
        throw new Error("could not bring the game window to the foreground (Alt-Tab lock?)");
      }
    }
    return game;
  };

  server.registerTool(
    "launch",
    {
      title: "Start the FiveM client",
      description:
        "Launch FiveM, optionally straight into a server via the fivem://connect link. " +
        "Default target is the configured game port. Returns immediately — watch " +
        "window_status/client_command to see when the game is up.",
      inputSchema: {
        connectTo: z
          .string()
          .optional()
          .describe("host:port to connect to (default: the configured rcon host:port)"),
      },
    },
    guarded(async (args: { connectTo?: string | undefined }) => {
      const target = args.connectTo ?? `${config.rconHost}:${config.rconPort}`;
      const result = await launchFiveM(target);
      return plain(`launched ${result.exe} (pid ${result.pid}) -> fivem://connect/${target}`);
    }),
  );

  server.registerTool(
    "quit_game",
    {
      title: "Close the FiveM client",
      description:
        "Graceful path: prints 'quit' to the client console over devcon and waits for the " +
        "game to close (nothing is typed into the window). force: true kills the FiveM " +
        "process tree instead — use it only when the game is wedged.",
      inputSchema: { force: z.boolean().optional() },
    },
    guarded(async (args: { force?: boolean | undefined }) => {
      releaseAll();
      if (args.force) {
        const code = await forceQuitFiveM();
        hub.closeAll();
        return plain(`taskkill exited ${code} (0 = killed)`);
      }
      const connection = await hub.ensureClient();
      const closed = once(connection, "close");
      connection.print("quit");
      const winner = await Promise.race([
        closed.then(() => "closed"),
        new Promise((r) => setTimeout(() => r("timeout"), 15000)),
      ]);
      return plain(
        winner === "closed"
          ? "quit accepted — client console socket closed (game is exiting)"
          : "quit sent but the console socket stayed open for 15s; check window_status or use force",
      );
    }),
  );

  server.registerTool(
    "window_status",
    {
      title: "Game window state",
      description:
        "Whether the FiveM game window exists, its title/pid, on-screen rect, and whether " +
        "it is the foreground window. Input/screenshot tools focus it automatically.",
      inputSchema: {},
    },
    guarded(async () => {
      const game = findGameWindow();
      if (!game) return text({ found: false, focused: false });
      const rect = getWindowRectOf(game.hwnd);
      return text({
        found: true,
        title: game.title,
        pid: game.pid,
        rect,
        focused: foregroundHwnd() === game.hwnd,
      });
    }),
  );

  server.registerTool(
    "focus_window",
    {
      title: "Bring the game to the foreground",
      description:
        "Restores/minimizes-out if needed and steals foreground (remembering the previous " +
        "window for restore_focus). Every input/screenshot tool calls this automatically.",
      inputSchema: {},
    },
    guarded(async () => {
      const game = ensureGameFocused();
      return plain(`focused '${game.title}' (pid ${game.pid})`);
    }),
  );

  server.registerTool(
    "restore_focus",
    {
      title: "Give focus back to the previous window",
      description:
        "Returns foreground to whatever window was focused before this tool focused the game.",
      inputSchema: {},
    },
    guarded(async () => {
      if (savedForeground === null) return plain("nothing saved — the game was already foreground");
      const back = focusWindow(savedForeground);
      const target = savedForeground;
      savedForeground = null;
      return plain(
        back ? `restored focus to window ${target}` : `could not restore focus to ${target}`,
      );
    }),
  );

  server.registerTool(
    "screenshot",
    {
      title: "Capture the game window",
      description:
        "PNG of the FiveM window (PrintWindow with PW_RENDERFULLCONTENT; falls back to a " +
        "screen BitBlt of the window rect when the swapchain returns black, which means " +
        "whatever covers the window is also captured — the game is focused first). " +
        "Downscaled so vision models can read it cheaply.",
      inputSchema: {
        maxSide: z
          .number()
          .int()
          .min(320)
          .max(4096)
          .optional()
          .describe("Downscale longest side (default 1280)"),
      },
    },
    guarded(async (args: { maxSide?: number | undefined }) => {
      const game = ensureGameFocused();
      const frame = captureWindow(game.hwnd);
      const rgb = bgraToRgb(frame.pixels);
      const scaled = downscaleRgb(rgb, frame.width, frame.height, args.maxSide ?? 1280);
      const png = encodePng(scaled.width, scaled.height, scaled.rgb);
      return {
        content: [
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
          {
            type: "text",
            text: `captured ${frame.width}x${frame.height} via ${frame.method} -> ${scaled.width}x${scaled.height} png; brightness ${(frame.brightness * 100).toFixed(0)}%`,
          },
        ],
      };
    }),
  );

  const KEY_DOC =
    "Key name: W A S D E F Q space enter esc tab shift ctrl alt arrows up down left right, f1-f12, letters/digits.";

  server.registerTool(
    "press_key",
    {
      title: "Tap a key",
      description: `Press and release a key (scan codes — what GTA's DirectInput/raw input reads). ${KEY_DOC}`,
      inputSchema: {
        key: z.string(),
        holdMs: z.number().int().min(0).max(5000).optional().describe("Hold duration (default 20)"),
      },
    },
    guarded(async (args: { key: string; holdMs?: number | undefined }) => {
      ensureGameFocused();
      pressKey(args.key, args.holdMs);
      return plain(`tapped ${args.key}`);
    }),
  );

  server.registerTool(
    "hold_key",
    {
      title: "Hold a key down",
      description: `Key stays pressed until release_key. Use for movement (W) and camera. ${KEY_DOC} Held keys are released if this process exits.`,
      inputSchema: { key: z.string() },
    },
    guarded(async (args: { key: string }) => {
      ensureGameFocused();
      holdKey(args.key);
      return plain(`holding ${args.key}`);
    }),
  );

  server.registerTool(
    "release_key",
    {
      title: "Release held key(s)",
      description: "Release one held key, or all of them with key='all'.",
      inputSchema: { key: z.string() },
    },
    guarded(async (args: { key: string }) => {
      if (args.key.toLowerCase() === "all") {
        const released = releaseAll();
        return plain(released.length ? `released ${released.join(", ")}` : "nothing held");
      }
      releaseKey(args.key);
      return plain(`released ${args.key}`);
    }),
  );

  server.registerTool(
    "type_text",
    {
      title: "Type literal text",
      description:
        "Sends Unicode key events — the F8 console and chat/NUI inputs read these " +
        "normally. Open the target input first (e.g. client_command to focus, or a chat " +
        "key like T). Does not press Enter.",
      inputSchema: { text: z.string() },
    },
    guarded(async (args: { text: string }) => {
      ensureGameFocused();
      typeText(args.text);
      return plain(`typed ${args.text.length} chars`);
    }),
  );

  server.registerTool(
    "mouse_move",
    {
      title: "Move the mouse",
      description:
        "Relative dx/dy drives the in-game camera; absolute x/y (screen pixels) positions " +
        "the real cursor for NUI elements.",
      inputSchema: {
        dx: z.number().int().optional(),
        dy: z.number().int().optional(),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
      },
    },
    guarded(
      async (args: {
        dx?: number | undefined;
        dy?: number | undefined;
        x?: number | undefined;
        y?: number | undefined;
      }) => {
        ensureGameFocused();
        mouseMove(args);
        return plain(
          `mouse ${args.x !== undefined ? `-> (${args.x},${args.y})` : `by (${args.dx ?? 0},${args.dy ?? 0})`}`,
        );
      },
    ),
  );

  server.registerTool(
    "click",
    {
      title: "Mouse click",
      description:
        "Click at the current cursor position (position it with mouse_move absolute first for NUI).",
      inputSchema: {
        button: z.enum(["left", "right"]).optional().describe("default left"),
        double: z.boolean().optional(),
      },
    },
    guarded(
      async (args: { button?: "left" | "right" | undefined; double?: boolean | undefined }) => {
        ensureGameFocused();
        mouseClick(args.button ?? "left", args.double ?? false);
        return plain(`${args.button ?? "left"} click`);
      },
    ),
  );

  server.registerTool(
    "scroll",
    {
      title: "Mouse wheel",
      description: "Scroll the wheel (positive = up). NUI lists respond to it.",
      inputSchema: { amount: z.number().int().min(-50).max(50) },
    },
    guarded(async (args: { amount: number }) => {
      ensureGameFocused();
      mouseScroll(args.amount);
      return plain(`scrolled ${args.amount}`);
    }),
  );

  server.registerTool(
    "wait",
    {
      title: "Pause",
      description: "Sleep between actions — loading screens, walk cycles, held-key sequences.",
      inputSchema: { ms: z.number().int().min(0).max(120000) },
    },
    guarded(async (args: { ms: number }) => {
      await new Promise((r) => setTimeout(r, args.ms));
      return plain(`waited ${args.ms}ms`);
    }),
  );

  server.registerTool(
    "read_client_log",
    {
      title: "Read the FiveM client log file",
      description:
        "Tail the newest CitizenFX_log_*.log under the FiveM install — the same stream as " +
        "read_console(client) but persisted across sessions, without the channel tags.",
      inputSchema: {
        limit: z.number().int().positive().max(1000).optional().describe("default 100"),
        contains: z.string().optional(),
        pattern: z.string().optional(),
      },
    },
    guarded(
      async (args: {
        limit?: number | undefined;
        contains?: string | undefined;
        pattern?: string | undefined;
      }) => {
        const file = latestClientLog();
        if (!file) {
          throw new Error(
            "no CitizenFX_log_*.log found — is FiveM installed, and where? (checked %LOCALAPPDATA%\\FiveM\\FiveM.app\\logs)",
          );
        }
        const lines = await new ServerLogFile(file).tail({
          limit: args.limit ?? 100,
          contains: args.contains,
          pattern: args.pattern,
        });
        return text({
          file,
          matched: lines.length,
          lines: lines.map((l) => `${l.channel ? `[${l.channel}] ` : ""}${l.message}`),
        });
      },
    ),
  );

  server.registerTool(
    "bridge",
    {
      title: "Invoke a bridge operation (mcpb resource)",
      description:
        "Runs an operation through the mcpb bridge resource — the half neither devcon nor " +
        "RCON can reach. Server ops (target=server): ping, players, call_export " +
        "{resource, method, args}, trigger_event {event, args, toClient?, player?} " +
        "(event names must be in mcpb_event_allowlist). Client ops (target=client, needs src): " +
        "ping, position, teleport {x,y,z,heading?}, freeze {freeze}, call_native {name, args}, " +
        "send_nui {resource, message, event?}, nui_callback {resource, endpoint, payload}. " +
        "Client results come back as MCP_RESULT lines on the server console (needs " +
        "FIVEM_SERVER_LOG). The bridge must be installed, started and enabled (mcpb_enabled true).",
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
          .describe("Client-op result wait (default 8000)"),
      },
    },
    guarded(
      async (args: {
        target: Target;
        op: string;
        src?: number | undefined;
        args?: string | undefined;
        timeoutMs?: number | undefined;
      }) => {
        let extra: Record<string, unknown> = {};
        if (args.args !== undefined && args.args !== "") {
          const parsed = JSON.parse(args.args);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("args must be a JSON object string");
          }
          extra = parsed as Record<string, unknown>;
        }
        const result = await hub.bridgeCall({
          target: args.target,
          op: args.op,
          src: args.src,
          extra,
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        });
        if (!result.ok) {
          return {
            content: [
              {
                type: "text",
                text: `bridge ${args.target}/${args.op} failed: ${result.error ?? "unknown"}`,
              },
            ],
            isError: true,
          };
        }
        return text({ op: args.op, target: args.target, data: result.data });
      },
    ),
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Prompts — playbooks distilled from the live-verified loops
  // ─────────────────────────────────────────────────────────────────────────

  server.registerPrompt(
    "test_resource",
    {
      title: "End-to-end test a FiveM resource",
      description:
        "Drive a resource from a clean restart through in-game behavior and produce an " +
        "evidence-backed PASS/FAIL report. Needs a running server and (for the game-side " +
        "steps) a connected client with the mcpb bridge installed.",
      argsSchema: {
        resource: z.string().describe("Resource name, e.g. 'breeze-chat'"),
        expectations: z
          .string()
          .optional()
          .describe("What must hold in-game — the scenario to run and observe"),
      },
    },
    ({ resource, expectations }) => ({
      description: `Verify ${resource} end to end`,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Verify the FiveM resource "${resource}" end to end with the fivem-mcp tools. Work the steps in order and read every result — never assume a step passed.`,
              "",
              "1. GROUND STATE — status; server_info (confirm this is the intended dev server by hostname and build); bridge target=server op=players if available (note tester srcs), else read_console to find who joined.",
              `2. CLEAN START — server_command: restart ${resource}; then wait_for_console target=server for 'Started resource ${resource}' and immediately read_console the window after it with pattern '[Ee]rror|failed|exception' to catch load-time failures. A restart that printed nothing but 'Started' is not enough — the error scan must be empty.`,
              "3. CLIENT HALF — read_console target=client with a pattern matching the resource name. Client-side errors never reach the server log; this is where a broken screen or NUI 404 shows up.",
              expectations
                ? `4. SCENARIO — ${expectations}`
                : "4. SCENARIO — drive a representative player flow: position baseline via bridge op=position, then the UI path (type_text / press_key / mouse on screenshot findings) or bridge op=nui_callback / call_export to assert server-side state directly.",
              "5. CAPTURE EVIDENCE — screenshot before and after the key moment; bridge op=position or call_export to read the state the scenario promised; for DB-backed claims use what the resource's own exports/console report, and say what the tool cannot see.",
              "6. REPORT — a PASS/FAIL table per expectation, each row citing the exact console line (channel + message) or coordinates that decided it. Anything unverifiable is listed as UNVERIFIED, not passed. Restore focus when done.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "smoke_check",
    {
      title: "Quick health sweep",
      description:
        "Fast 'is anything on fire?' pass over the server and the running client — connections, errors, window state.",
      argsSchema: {},
    },
    () => ({
      description: "Health sweep",
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Run a health sweep of the FiveM setup and report a short table.",
              "",
              "- status (devcon/rcon/log-file state) and server_info (which server, how many players).",
              "- read_console target=server pattern='[Ee]rror|fail|exception|crash' over the recent window; same scan on target=client when the F8 stream is connected.",
              "- window_status (is the game open? focused?) and one screenshot if a game window exists.",
              "- read_client_log with contains='error' as the persisted cross-check of the client.",
              "",
              "Output: one line per area — OK / WARN (with the exact log lines as evidence) / DOWN (with the tool's error text). No fixes, this is diagnosis only.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}

function releaseAll(): string[] {
  // Local alias so the guarded closures don't capture the win32 module directly.
  return releaseAllHeld();
}
