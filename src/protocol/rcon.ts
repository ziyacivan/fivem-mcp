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

/**
 * Minimal rcon client. One command is in flight at a time (the protocol carries
 * no request id, so concurrent commands could not be correlated); callers are
 * serialized internally.
 */
export class RconClient {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: RconOptions) {}

  get isConfigured(): boolean {
    return this.options.password.length > 0;
  }

  exec(command: string): Promise<string> {
    if (!this.isConfigured) {
      return Promise.reject(new RconError("no rcon password configured (FIVEM_RCON_PASSWORD)"));
    }
    const run = () => this.execOne(command);
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private execOne(command: string): Promise<string> {
    const { host, port, password, timeoutMs = DEFAULTS.rconTimeoutMs } = this.options;
    const request = encodeRconRequest(password, command);

    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      let settled = false;

      const finish = () => {
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners("message");
        socket.on("error", () => undefined); // a late error must not throw out of close()
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        finish();
        reject(
          new RconError(
            `rcon command "${command}" timed out after ${timeoutMs}ms — ` +
              `is \`rcon_password\` set on the server and is ${host}:${port} its game port?`,
          ),
        );
      }, timeoutMs);

      socket.on("message", (msg, rinfo) => {
        if (settled) return;
        // Only the server we asked may answer: a datagram from anywhere else
        // would let a third party inject fabricated console output.
        if (rinfo.port !== port || !sameHost(rinfo.address, host)) return;
        let response: RconResponse;
        try {
          response = parseRconResponse(msg);
        } catch (error) {
          finish();
          reject(error);
          return;
        }
        finish();
        if (response.kind === "error") {
          reject(new RconError(response.text.trim()));
        } else {
          resolve(response.text);
        }
      });

      socket.on("error", (error) => {
        if (settled) return;
        finish();
        reject(new RconError(String(error)));
      });

      socket.send(request, port, host, (error) => {
        if (error && !settled) {
          finish();
          reject(new RconError(String(error)));
        }
      });
    });
  }
}
