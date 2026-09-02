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

/**
 * Owns the live state: one lazy devcon connection to the FiveM client console,
 * one RCON client for the server, and an optional tail over the server's log
 * file. Modern FXServer builds listen only on the game port (no server-side
 * devcon socket), so the server half goes over UDP RCON instead.
 */
export class Hub {
  private clientConnection: DevconConnection | null = null;
  private clientLastError: string | null = null;
  readonly clientBuffer: ConsoleBuffer;
  readonly rcon: RconClient;
  readonly serverLog: ServerLogFile | null;

  constructor(readonly config: Config) {
    this.clientBuffer = new ConsoleBuffer(config.logCapacity);
    this.rcon = new RconClient({
      host: config.rconHost,
      port: config.rconPort,
      password: config.rconPassword ?? "",
    });
    this.serverLog = config.serverLogFile ? new ServerLogFile(config.serverLogFile) : null;
  }

  /** Return a live client devcon connection, dialing (or redialing) if needed. */
  async ensureClient(): Promise<DevconConnection> {
    if (this.clientConnection?.isReady) return this.clientConnection;
    this.clientConnection?.destroy();

    try {
      const connection = await DevconConnection.connectFirstUsable(
        this.config.host,
        this.config.clientDevconPorts,
      );
      connection.on("print", (line) => this.clientBuffer.push(line));
      connection.on("close", () => {
        this.clientLastError = "connection closed";
        if (this.clientConnection === connection) this.clientConnection = null;
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
