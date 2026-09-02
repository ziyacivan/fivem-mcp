import { DEVCON_CLIENT_PORTS } from "./protocol/devcon.js";

export interface Config {
  /** Machine running the FiveM client (devcon binds 127.0.0.1 by default). */
  host: string;
  /** Tried in order; 29200 is a Legacy/CL1 client, 29300 a CL2 client. */
  clientDevconPorts: number[];
  rconHost: string;
  rconPort: number;
  /** Matches `rcon_password` in server.cfg. Without it the server tools cannot run. */
  rconPassword?: string;
  /**
   * FXServer's redirected stdout (e.g. `... +exec server.cfg > server.log`).
   * Enables read_console/wait_for_console for the server; modern FXServer
   * builds expose no server-side console socket.
   */
  serverLogFile?: string;
  /** Console lines kept for the client target. */
  logCapacity: number;
  /** Defaults for client command output capture. */
  quietMs: number;
  commandTimeoutMs: number;
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function splitAddress(raw: string | undefined, fallbackHost: string, fallbackPort: number) {
  if (!raw) return { host: fallbackHost, port: fallbackPort };
  const index = raw.lastIndexOf(":");
  if (index === -1) return { host: raw, port: fallbackPort };
  return {
    host: raw.slice(0, index),
    port: positiveInt(raw.slice(index + 1), fallbackPort, "rcon address port"),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.FIVEM_HOST ?? "127.0.0.1";
  const rcon = splitAddress(env.FIVEM_RCON_ADDRESS, host, 30120);
  const config: Config = {
    host,
    clientDevconPorts: env.FIVEM_CLIENT_DEVCON_PORT
      ? [positiveInt(env.FIVEM_CLIENT_DEVCON_PORT, 0, "FIVEM_CLIENT_DEVCON_PORT")]
      : [...DEVCON_CLIENT_PORTS],
    rconHost: rcon.host,
    rconPort: rcon.port,
    logCapacity: positiveInt(env.FIVEM_CONSOLE_CAPACITY, 5000, "FIVEM_CONSOLE_CAPACITY"),
    quietMs: positiveInt(env.FIVEM_QUIET_MS, 400, "FIVEM_QUIET_MS"),
    commandTimeoutMs: positiveInt(env.FIVEM_COMMAND_TIMEOUT_MS, 5000, "FIVEM_COMMAND_TIMEOUT_MS"),
  };
  if (env.FIVEM_RCON_PASSWORD) config.rconPassword = env.FIVEM_RCON_PASSWORD;
  if (env.FIVEM_SERVER_LOG) config.serverLogFile = env.FIVEM_SERVER_LOG;
  return config;
}
