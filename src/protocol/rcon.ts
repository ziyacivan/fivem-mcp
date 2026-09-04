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
import { hashRageString } from "./hash.js";

const OOB_PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);

/** The server dispatches OOB packets by HashRageString of the key before the first space/newline. */
export const RCON_OOB_KEY_HASH = hashRageString("rcon");

export function encodeRconRequest(password: string, command: string): Buffer {
  return Buffer.concat([OOB_PREFIX, Buffer.from(`rcon\n${password} ${command}`, "utf8")]);
}

/**
 * Does a reply's source address belong to the host we sent to? Hostnames are
 * resolved by the OS at send time, so a non-literal `host` cannot be compared
 * byte-for-byte; the port check still applies, and loopback names are matched
 * against their literals.
 */
export function sameHost(replyAddress: string, requestedHost: string): boolean {
  if (replyAddress === requestedHost) return true;
  if (requestedHost === "localhost") return replyAddress === "127.0.0.1" || replyAddress === "::1";
  // Not an IP literal we can compare — trust the OS resolution.
  return !/^[\d.]+$|^[0-9a-f:]+$/i.test(requestedHost);
}

export interface RconResponse {
  kind: "print" | "error";
  text: string;
}

export function parseRconResponse(data: Buffer): RconResponse {
  let payload = data;
  if (payload.length >= 4 && payload.readUInt32BE(0) === 0xffffffff) {
    payload = payload.subarray(4);
  }
  const text = payload.toString("utf8");
  const match = /^(print|error)[ ]?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`unrecognized rcon response: ${JSON.stringify(text.slice(0, 60))}`);
  return { kind: match[1] as "print" | "error", text: match[2] ?? "" };
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
    const { host, port, password, timeoutMs = 5000 } = this.options;
    const request = encodeRconRequest(password, command);

    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.close();
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
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
        settled = true;
        let response: RconResponse;
        try {
          response = parseRconResponse(msg);
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        cleanup();
        if (response.kind === "error") {
          reject(new RconError(response.text.trim()));
        } else {
          resolve(response.text);
        }
      });

      socket.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        reject(new RconError(String(error)));
      });

      socket.send(request, port, host, (error) => {
        if (error && !settled) {
          settled = true;
          cleanup();
          reject(new RconError(String(error)));
        }
      });
    });
  }
}
