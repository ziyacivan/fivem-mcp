import {
  type BridgeResult,
  buildCommandLine,
  looksLikeMissingResource,
  newCallId,
  parseErrorLine,
  parseResultLine,
} from "./bridge-protocol.js";
import type { Config } from "./config.js";
import { ConsoleBuffer, type ConsoleLine } from "./console-buffer.js";
import { DevconConnection } from "./protocol/devcon.js";
import { queryServerInfo } from "./protocol/oob.js";
import { RconClient } from "./protocol/rcon.js";
import { ServerLogFile } from "./protocol/server-log.js";

export type Target = "server" | "client";

export interface ClientStatus {
  connected: boolean;
  process: string | null;
  channels: number;
  commands: number;
  bufferedLines: number;
  lastError: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Owns the live state: one lazy devcon connection to the FiveM client console,
 * one RCON client for the server, and an optional tail over the server's log
 * file. Modern FXServer builds listen only on the game port (no server-side
 * devcon socket), so the server half of this tool uses UDP RCON instead.
 */
export class Hub {
  private clientConnection: DevconConnection | null = null;
  private clientConnecting: Promise<DevconConnection> | null = null;
  private clientLastError: string | null = null;
  readonly clientBuffer: ConsoleBuffer;
  readonly rcon: RconClient;
  readonly serverLog: ServerLogFile | null;
  /** Poll results belonging to another caller's id wait here (sessions can overlap). */
  private readonly bridgeInbox = new Map<string, BridgeResult>();

  constructor(readonly config: Config) {
    this.clientBuffer = new ConsoleBuffer(config.logCapacity);
    this.rcon = new RconClient({
      host: config.rconHost,
      port: config.rconPort,
      password: config.rconPassword ?? "",
    });
    this.serverLog = config.serverLogFile ? new ServerLogFile(config.serverLogFile) : null;
  }

  /**
   * Return a live client devcon connection, dialing (or redialing) if needed.
   * Concurrent callers share one dial: two tool calls racing here must not open
   * two sockets (each would push every console line into the buffer twice).
   */
  ensureClient(): Promise<DevconConnection> {
    if (this.clientConnection?.isReady) return Promise.resolve(this.clientConnection);
    if (this.clientConnecting) return this.clientConnecting;
    this.clientConnecting = this.dialClient().finally(() => {
      this.clientConnecting = null;
    });
    return this.clientConnecting;
  }

  private async dialClient(): Promise<DevconConnection> {
    this.clientConnection?.destroy();
    this.clientConnection = null;

    try {
      const connection = await DevconConnection.connectFirstUsable(
        this.config.host,
        this.config.clientDevconPorts,
      );
      connection.on("print", (line) => this.clientBuffer.push(line));
      connection.on("close", () => {
        this.clientLastError ??= "connection closed";
        if (this.clientConnection === connection) this.clientConnection = null;
      });
      // A malformed frame after the handshake destroys the socket and emits
      // "error"; without a listener that would throw out of the socket callback
      // and take the whole MCP process down.
      connection.on("error", (error: unknown) => {
        this.clientLastError = `devcon protocol error: ${error instanceof Error ? error.message : String(error)}`;
      });
      this.clientConnection = connection;
      this.clientLastError = null;
      return connection;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.clientLastError = message;
      const ports = this.config.clientDevconPorts.join("/");
      const hint =
        "Is the FiveM client running and connected to a server? Enhanced clients dropped these ports.";
      throw new Error(
        `no client devcon found on ${this.config.host}:${ports} — ${message}. ${hint}`,
      );
    }
  }

  /** Type a command into the client's F8 console and collect the printed lines. */
  async runClientCommand(
    command: string,
    overrides: { quietMs?: number | undefined; timeoutMs?: number | undefined } = {},
  ): Promise<ConsoleLine[]> {
    const connection = await this.ensureClient();
    const beforeSeq = this.clientBuffer.latestSeq;
    connection.print(command);
    return this.clientBuffer.waitForQuiet(
      beforeSeq,
      overrides.quietMs ?? this.config.quietMs,
      overrides.timeoutMs ?? this.config.commandTimeoutMs,
    );
  }

  /** Run a server console command over RCON; returns the captured output text. */
  async runServerCommand(command: string): Promise<string> {
    if (!this.rcon.isConfigured) {
      const hint =
        "set `rcon_password <pw>` in server.cfg and FIVEM_RCON_PASSWORD for this MCP server.";
      throw new Error(`server console access needs RCON — ${hint}`);
    }
    return this.rcon.exec(command);
  }

  /** Password-free server identity via the getinfo OOB query. */
  serverInfo(): Promise<Record<string, string>> {
    return queryServerInfo({ host: this.config.rconHost, port: this.config.rconPort });
  }

  /**
   * Invoke an operation on the mcpb bridge resource. Server ops answer inside
   * the RCON capture; client ops round-trip through the game client and are
   * collected in-band with the bridge's `poll` op (~100 ms backoff, no file
   * tailing). A pre-0.5 bridge resource without `poll` falls back to reading
   * MCP_RESULT lines off FIVEM_SERVER_LOG, when it is configured.
   */
  async bridgeCall(options: {
    target: Target;
    op: string;
    src?: number | null | undefined;
    extra?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<BridgeResult> {
    const { target, op, src = null, extra = {}, timeoutMs = 8000 } = options;
    if (!this.rcon.isConfigured) {
      throw new Error("the bridge drives its server half over RCON — set FIVEM_RCON_PASSWORD");
    }
    const id = newCallId();
    // Arm the legacy tailer BEFORE dispatching — an answer landing between the
    // dispatch and the poll-unknown verdict must not be missed.
    const legacyWait =
      target === "client" && this.serverLog
        ? this.serverLog
            .waitFor(`MCP_RESULT ${id}`, { timeoutMs: timeoutMs + 1500, pollMs: 150 })
            .catch(() => null)
        : null;

    const reply = await this.rcon.exec(
      buildCommandLine(id, target, src, this.withToken({ op, ...extra })),
    );
    if (looksLikeMissingResource(reply)) {
      throw new Error(
        "mcpb is not installed — copy the bridge/ folder from fivem-mcp into the server's resources and add `ensure mcpb`; then set mcpb_enabled true (dev servers only)",
      );
    }
    if (target === "server") {
      return (
        this.scanReply(reply, id) ?? {
          ok: false,
          error: `bridge server op produced no MCP_RESULT line in the reply: ${reply.slice(0, 160)}`,
        }
      );
    }

    const deadline = Date.now() + timeoutMs;
    let delay = 100;
    let legacy = false;
    for (;;) {
      const buffered = this.bridgeInbox.get(id);
      if (buffered) {
        this.bridgeInbox.delete(id);
        return buffered;
      }
      const poll = await this.pollBridge();
      if (poll.legacy) {
        if (!legacyWait) {
          throw new Error(
            "this mcpb resource predates the in-band 'poll' op — update the files and `restart mcpb`, or set FIVEM_SERVER_LOG for the log-tail fallback",
          );
        }
        legacy = true;
        const line = await legacyWait;
        const result = line ? parseResultLine(line.message, id) : null;
        if (result) return result;
        break;
      }
      let mine: BridgeResult | null = null;
      for (const entry of poll.entries) {
        if (entry.id === id) mine = entry.result;
        else this.bridgeInbox.set(entry.id, entry.result);
      }
      if (mine) return mine;
      if (Date.now() >= deadline) break;
      await sleep(Math.min(delay, deadline - Date.now()));
      delay = Math.min(1000, Math.round(delay * 1.5));
    }
    const hint = legacy
      ? "the legacy log tail saw no MCP_RESULT line — check FIVEM_SERVER_LOG points at the live stdout"
      : "is mcpb started, is the player connected, and is its client script loaded?";
    throw new Error(
      `bridge client op '${op}' (src ${src}) did not answer within ${timeoutMs}ms: ${hint}`,
    );
  }

  private withToken(req: Record<string, unknown>): Record<string, unknown> {
    const token = this.config.mcpbToken;
    return token ? { ...req, token } : req;
  }

  private scanReply(reply: string, id: string): BridgeResult | null {
    for (const line of reply.split(/\r?\n/)) {
      const error = parseErrorLine(line, id);
      if (error) return { ok: false, error };
      const result = parseResultLine(line, id);
      if (result) return result;
    }
    return null;
  }

  private async pollBridge(): Promise<{
    entries: Array<{ id: string; result: BridgeResult }>;
    legacy: boolean;
  }> {
    const pollId = newCallId();
    const reply = await this.rcon.exec(
      buildCommandLine(pollId, "server", null, this.withToken({ op: "poll" })),
    );
    const result = this.scanReply(reply, pollId);
    if (!result) return { entries: [], legacy: false };
    if (!result.ok && /unknown server op/.test(String(result.error))) {
      return { entries: [], legacy: true };
    }
    if (result.ok && Array.isArray(result.data)) {
      return { entries: result.data as Array<{ id: string; result: BridgeResult }>, legacy: false };
    }
    return { entries: [], legacy: false };
  }

  async status(): Promise<Record<string, unknown>> {
    const connection = this.clientConnection;
    const alive = connection?.isReady ?? false;
    return {
      client: {
        connected: alive,
        process: alive ? (connection?.info?.commandLine ?? null) : null,
        channels: connection?.channels.size ?? 0,
        commands: connection?.commands.size ?? 0,
        bufferedLines: this.clientBuffer.size,
        lastError: this.clientLastError,
      } satisfies ClientStatus,
      server: {
        rcon: {
          configured: this.rcon.isConfigured,
          address: `${this.config.rconHost}:${this.config.rconPort}`,
        },
        logFile: this.serverLog
          ? { path: this.serverLog.path, exists: await this.serverLog.exists() }
          : null,
      },
    };
  }

  closeAll(): void {
    this.clientConnection?.destroy();
    this.clientConnection = null;
  }
}
