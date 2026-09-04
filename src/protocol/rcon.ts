// FiveM's "RCON": an out-of-band UDP datagram against the game port.
//
// References (citizenfx/fivem@03dcc56, 2026-09-01):
//  - code/components/citizen-server-impl/include/decorators/WithOutOfBand.h
//    OOB datagrams start with 0xFFFFFFFF, then `<handlerName>\n<payload>`.
//  - code/components/citizen-server-impl/include/outofbandhandlers/RconOutOfBand.h
//    payload is `<password> <command>`; the reply (also 0xFFFFFFFF-prefixed) is
//    `print <captured console output>` or `error <text>`.
//  - docs: refs/fivem-docs content/docs/server-manual/server-commands.md —
//    "Sets the RCon password, if unset then RCon will be disabled. FXServer RCon
//    uses UDP." Server rate limit is 0.2/s, burst 5 until authorized.

import dgram from "node:dgram";
import { DEFAULTS } from "../defaults.js";
import { debug } from "../log.js";
import { encodeOobRequest, sameHost, stripOobPrefix } from "./oob.js";

export function encodeRconRequest(password: string, command: string): Buffer {
  return encodeOobRequest("rcon", `${password} ${command}`);
}

export interface RconResponse {
  kind: "print" | "error";
  text: string;
}

export function parseRconResponse(data: Buffer): RconResponse {
  const text = stripOobPrefix(data).toString("utf8");
  const match = /^(print|error)[ ]?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`unrecognized rcon response: ${JSON.stringify(text.slice(0, 60))}`);
  return { kind: match[1] === "error" ? "error" : "print", text: match[2] ?? "" };
}

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

export class RconError extends Error {}

interface Pending {
  command: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Minimal rcon client. One command is in flight at a time (the protocol carries
 * no request id, so concurrent commands could not be correlated); callers are
 * serialized internally. One UDP socket lives for the client's lifetime — the
 * bridge poll loop issues several commands a second, and opening/closing a
 * socket per command was pure churn. `close()` releases it.
 */
export class RconClient {
  private queue: Promise<unknown> = Promise.resolve();
  private socket: dgram.Socket | null = null;
  private pending: Pending | null = null;
  private closed = false;

  constructor(private readonly options: RconOptions) {}

  get isConfigured(): boolean {
    return this.options.password.length > 0;
  }

  exec(command: string): Promise<string> {
    if (!this.isConfigured) {
      return Promise.reject(new RconError("no rcon password configured (FIVEM_RCON_PASSWORD)"));
    }
    if (this.closed) return Promise.reject(new RconError("rcon client is closed"));
    const run = () => this.execOne(command);
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Release the UDP socket; any in-flight command fails. */
  close(): void {
    this.closed = true;
    this.settle((pending) => pending.reject(new RconError("rcon client closed")));
    this.dropSocket();
  }

  private ensureSocket(): dgram.Socket {
    if (this.socket) return this.socket;
    const socket = dgram.createSocket("udp4");
    socket.on("message", (msg, rinfo) => {
      // Only the server we asked may answer: a datagram from anywhere else
      // would let a third party inject fabricated console output.
      if (rinfo.port !== this.options.port || !sameHost(rinfo.address, this.options.host)) return;
      this.settle((pending) => {
        let response: RconResponse;
        try {
          response = parseRconResponse(msg);
        } catch (error) {
          pending.reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        debug("rcon", `<- ${response.kind} ${response.text.length}B`);
        if (response.kind === "error") pending.reject(new RconError(response.text.trim()));
        else pending.resolve(response.text);
      });
    });
    socket.on("error", (error) => {
      // Socket-level failure: fail the current command and start fresh next time.
      this.settle((pending) => pending.reject(new RconError(String(error))));
      this.dropSocket();
    });
    socket.unref();
    this.socket = socket;
    return socket;
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.removeAllListeners("message");
    socket.on("error", () => undefined); // a late error must not throw out of close()
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }

  /** Complete the in-flight command exactly once. */
  private settle(complete: (pending: Pending) => void): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    complete(pending);
  }

  private execOne(command: string): Promise<string> {
    const { host, port, password, timeoutMs = DEFAULTS.rconTimeoutMs } = this.options;
    const request = encodeRconRequest(password, command);
    debug("rcon", `-> ${command}`);

    return new Promise((resolve, reject) => {
      const socket = this.ensureSocket();
      const timer = setTimeout(() => {
        this.settle((pending) =>
          pending.reject(
            new RconError(
              `rcon command "${pending.command}" timed out after ${timeoutMs}ms — ` +
                `is \`rcon_password\` set on the server and is ${host}:${port} its game port?`,
            ),
          ),
        );
      }, timeoutMs);
      this.pending = { command, resolve, reject, timer };
      socket.send(request, port, host, (error) => {
        if (error) this.settle((pending) => pending.reject(new RconError(String(error))));
      });
    });
  }
}
