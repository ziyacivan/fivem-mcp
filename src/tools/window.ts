// M2 — window automation (Windows only; win32.ts reports the platform clearly).
// Launch/quit the client, find and focus its window, screenshot it, and drive
// keyboard/mouse through SendInput.

import { once } from "node:events";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DEFAULTS } from "../defaults.js";
import { forceQuitFiveM, launchFiveM } from "../launcher.js";
import { type CropRect, cropRgb, downscaleRgb, encodePng } from "../win/png.js";
import {
  bgraToRgb,
  captureWindow,
  findGameWindow,
  focusWindow,
  foregroundHwnd,
  type GameWindow,
  getWindowRectOf,
  holdKey,
  mouseClick,
  mouseMove,
  mouseScroll,
  pressKey,
  releaseAllHeld,
  releaseKey,
  typeText,
} from "../win/win32.js";
import {
  ACTS_SAFELY,
  type ArgsOf,
  DESTRUCTIVE,
  defineTool,
  plain,
  READ_ONLY,
  structured,
  type ToolContext,
  type ToolExtra,
  type ToolSpec,
} from "./_shared.js";

const KEY_DOC =
  "Key name: W A S D E F Q space enter esc tab shift ctrl alt arrows up down left right, f1-f12, letters/digits.";

const cropRectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

/** Crop arrives as a JSON string (kept for compatibility) or an object; both are validated. */
function parseCrop(raw: string | CropRect | undefined): CropRect | undefined {
  if (raw === undefined) return undefined;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`crop must be a JSON object like {"x":0,"y":0,"width":100,"height":100}`);
    }
  }
  const parsed = cropRectSchema.safeParse(value);
  if (!parsed.success) throw new Error(`crop: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

export function registerWindowTools(server: McpServer, { config, hub }: ToolContext): void {
  /** The window that had focus before we stole it, for restore_focus. */
  let savedForeground: bigint | null = null;

  const ensureGameFocused = (): GameWindow => {
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

  /** Like defineTool, but the game window is focused first and handed to the handler. */
  const defineFocusedTool = <S extends z.ZodRawShape>(
    name: string,
    spec: ToolSpec<S>,
    handler: (args: ArgsOf<S>, game: GameWindow, extra: ToolExtra) => Promise<CallToolResult>,
  ): void =>
    defineTool(server, name, spec, (args, extra) => handler(args, ensureGameFocused(), extra));

  defineTool(
    server,
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
      annotations: ACTS_SAFELY,
    },
    async (args) => {
      const target = args.connectTo ?? `${config.rconHost}:${config.rconPort}`;
      const result = await launchFiveM(target);
      return plain(`launched ${result.exe} (pid ${result.pid}) -> fivem://connect/${target}`);
    },
  );

  defineTool(
    server,
    "quit_game",
    {
      title: "Close the FiveM client",
      description:
        "Graceful path: prints 'quit' to the client console over devcon and waits for the " +
        "game to close (nothing is typed into the window). force: true kills the FiveM " +
        "process tree instead — use it only when the game is wedged.",
      inputSchema: { force: z.boolean().optional() },
      annotations: DESTRUCTIVE,
    },
    async (args) => {
      releaseAllHeld();
      if (args.force) {
        const code = await forceQuitFiveM();
        hub.closeAll();
        return plain(`taskkill exited ${code} (0 = killed)`);
      }
      const connection = await hub.ensureClient();
      const waitMs = DEFAULTS.quitGameCloseWaitMs;
      // events.once with a timeout signal: no leaked listener, no dangling timer.
      const closed = once(connection, "close", { signal: AbortSignal.timeout(waitMs) })
        .then(() => true)
        .catch(() => false);
      connection.print("quit");
      return plain(
        (await closed)
          ? "quit accepted — client console socket closed (game is exiting)"
          : `quit sent but the console socket stayed open for ${waitMs / 1000}s; check window_status or use force`,
      );
    },
  );

  defineTool(
    server,
    "window_status",
    {
      title: "Game window state",
      description:
        "Whether the FiveM game window exists, its title/pid, on-screen rect, and whether " +
        "it is the foreground window. Input/screenshot tools focus it automatically.",
      inputSchema: {},
      outputSchema: {
        found: z.boolean(),
        focused: z.boolean(),
        title: z.string().optional(),
        pid: z.number().int().optional(),
        rect: z
          .object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() })
          .nullable()
          .optional(),
      },
      annotations: READ_ONLY,
    },
    async () => {
      const game = findGameWindow();
      if (!game) return structured({ found: false, focused: false });
      return structured({
        found: true,
        title: game.title,
        pid: game.pid,
        rect: getWindowRectOf(game.hwnd),
        focused: foregroundHwnd() === game.hwnd,
      });
    },
  );

  defineTool(
    server,
    "focus_window",
    {
      title: "Bring the game to the foreground",
      description:
        "Restores/minimizes-out if needed and steals foreground (remembering the previous " +
        "window for restore_focus). Every input/screenshot tool calls this automatically.",
      inputSchema: {},
      annotations: ACTS_SAFELY,
    },
    async () => {
      const game = ensureGameFocused();
      return plain(`focused '${game.title}' (pid ${game.pid})`);
    },
  );

  defineTool(
    server,
    "restore_focus",
    {
      title: "Give focus back to the previous window",
      description:
        "Returns foreground to whatever window was focused before this tool focused the game.",
      inputSchema: {},
      annotations: ACTS_SAFELY,
    },
    async () => {
      if (savedForeground === null) return plain("nothing saved — the game was already foreground");
      const target = savedForeground;
      savedForeground = null;
      const back = focusWindow(target);
      return plain(
        back ? `restored focus to window ${target}` : `could not restore focus to ${target}`,
      );
    },
  );

  defineFocusedTool(
    "screenshot",
    {
      title: "Capture the game window",
      description:
        "PNG of the FiveM window (PrintWindow with PW_RENDERFULLCONTENT; falls back to a " +
        "screen BitBlt of the window rect when the swapchain returns black, which means " +
        "whatever covers the window is also captured — the game is focused first). " +
        "Downscaled so vision models can read it cheaply. COST WARNING: every screenshot " +
        "stays in the transcript and is re-sent on every later turn - many shots multiply " +
        "session latency. Prefer text probes (read_console, wait_for_console, bridge ops); " +
        "when pixels are the evidence, keep maxSide small (640 suffices for layout checks) " +
        "and crop to the panel of interest.",
      inputSchema: {
        maxSide: z
          .number()
          .int()
          .min(320)
          .max(4096)
          .optional()
          .describe(`Downscale longest side (default ${DEFAULTS.screenshotMaxSide})`),
        crop: z
          .union([z.string(), cropRectSchema])
          .optional()
          .describe(
            'Window-pixel rect, as an object or JSON string, e.g. {"x":300,"y":200,"width":400,"height":300}',
          ),
      },
      annotations: ACTS_SAFELY,
    },
    async (args, game) => {
      const cropRect = parseCrop(args.crop);
      const frame = captureWindow(game.hwnd);
      const cropped = cropRgb(bgraToRgb(frame.pixels), frame.width, frame.height, cropRect);
      const scaled = downscaleRgb(
        cropped.rgb,
        cropped.width,
        cropped.height,
        args.maxSide ?? DEFAULTS.screenshotMaxSide,
      );
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
    },
  );

  defineFocusedTool(
    "press_key",
    {
      title: "Tap a key",
      description: `Press and release a key (scan codes — what GTA's DirectInput/raw input reads). ${KEY_DOC}`,
      inputSchema: {
        key: z.string(),
        holdMs: z.number().int().min(0).max(5000).optional().describe("Hold duration (default 20)"),
      },
      annotations: ACTS_SAFELY,
    },
    async (args) => {
      pressKey(args.key, args.holdMs);
      return plain(`tapped ${args.key}`);
    },
  );

  defineFocusedTool(
    "hold_key",
    {
      title: "Hold a key down",
      description: `Key stays pressed until release_key. Use for movement (W) and camera. ${KEY_DOC} Held keys are released if this process exits.`,
      inputSchema: { key: z.string() },
      annotations: ACTS_SAFELY,
    },
    async (args) => {
      holdKey(args.key);
      return plain(`holding ${args.key}`);
    },
  );

  defineTool(
    server,
    "release_key",
    {
      title: "Release held key(s)",
      description: "Release one held key, or all of them with key='all'.",
      inputSchema: { key: z.string() },
      annotations: ACTS_SAFELY,
    },
    async (args) => {
      if (args.key.toLowerCase() === "all") {
        const released = releaseAllHeld();
        return plain(released.length ? `released ${released.join(", ")}` : "nothing held");
      }
      releaseKey(args.key);
      return plain(`released ${args.key}`);
    },
  );

  defineFocusedTool(
    "type_text",
    {
      title: "Type literal text",
      description:
        "Sends Unicode key events — the F8 console and chat/NUI inputs read these " +
        "normally. Open the target input first (e.g. client_command to focus, or a chat " +
        "key like T). Does not press Enter.",
      inputSchema: { text: z.string() },
      annotations: ACTS_SAFELY,
    },
    async (args) => {
      typeText(args.text);
      return plain(`typed ${args.text.length} chars`);
    },
  );

  defineFocusedTool(
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
      annotations: ACTS_SAFELY,
    },
    async (args) => {
      mouseMove(args);
      return plain(
        `mouse ${args.x !== undefined ? `-> (${args.x},${args.y})` : `by (${args.dx ?? 0},${args.dy ?? 0})`}`,
      );
    },
  );

  defineFocusedTool(
    "click",
    {
      title: "Mouse click",
      description:
        "Click at the current cursor position (position it with mouse_move absolute first for NUI).",
      inputSchema: {
        button: z.enum(["left", "right"]).optional().describe("default left"),
        double: z.boolean().optional(),
      },
      annotations: ACTS_SAFELY,
    },
    async (args) => {
      mouseClick(args.button ?? "left", args.double ?? false);
      return plain(`${args.button ?? "left"} click`);
    },
  );

  defineFocusedTool(
    "scroll",
    {
      title: "Mouse wheel",
      description: "Scroll the wheel (positive = up). NUI lists respond to it.",
      inputSchema: { amount: z.number().int().min(-50).max(50) },
      annotations: ACTS_SAFELY,
    },
    async (args) => {
      mouseScroll(args.amount);
      return plain(`scrolled ${args.amount}`);
    },
  );
}
