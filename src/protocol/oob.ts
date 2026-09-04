// Out-of-band UDP queries against the FXServer game port — the no-credential
// half of the server protocol. Verified live against a running FXServer on
// 2026-09-02 (hostname, client counts and build id came back unprompted).
//
// References (citizenfx/fivem@03dcc562, 2026-09-01):
//  - code/components/citizen-server-impl/include/decorators/WithOutOfBand.h
//  - code/components/citizen-server-impl/include/outofbandhandlers/GetInfoOutOfBand.h

import dgram from "node:dgram";
import { DEFAULTS } from "../defaults.js";

/** Every OOB datagram, request or reply, starts with these four bytes. */
export const OOB_PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);

export function encodeOobRequest(key: string, payload: string): Buffer {
  return Buffer.concat([OOB_PREFIX, Buffer.from(`${key}\n${payload}`, "utf8")]);
}

/** The reply payload with the 0xFFFFFFFF prefix removed (tolerates its absence). */
export function stripOobPrefix(data: Buffer): Buffer {
  return data.length >= 4 && data.readUInt32BE(0) === 0xffffffff ? data.subarray(4) : data;
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

/** `infoResponse\n\hostname\Foo\clients\0\...` -> flat key/value map. */
export function parseInfoResponse(text: string): Record<string, string> {
  const newline = text.indexOf("\n");
  const body = (newline === -1 ? text : text.slice(newline + 1)).trim();
  const tokens = body.split("\\");
  if (body.startsWith("\\")) tokens.shift();
  const info: Record<string, string> = {};
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    info[tokens[i] ?? ""] = tokens[i + 1] ?? "";
  }
  return info;
}

export interface OobOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

/** Sends one OOB datagram, resolves with the first reply's payload (prefix stripped). */
export function oobQuery(key: string, payload: string, options: OobOptions): Promise<string> {
  const { host, port, timeoutMs = DEFAULTS.oobTimeoutMs } = options;
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
    const fail = (error: unknown) => {
      if (settled) return;
      finish();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(
      () => fail(new Error(`no OOB reply to ${key} from ${host}:${port} within ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.on("message", (msg, rinfo) => {
      if (settled) return;
      if (rinfo.port !== port || !sameHost(rinfo.address, host)) return; // spoofed reply
      const text = stripOobPrefix(msg).toString("utf8");
      finish();
      resolve(text);
    });
    socket.on("error", fail);
    socket.send(encodeOobRequest(key, payload), port, host, (error) => {
      if (error) fail(error);
    });
  });
}

export async function queryServerInfo(options: OobOptions): Promise<Record<string, string>> {
  // The challenge must stay <= 8 bytes: GetInfoOutOfBand drops longer payloads
  // silently (citizenfx/fivem@03dcc562, outofbandhandlers/GetInfoOutOfBand.h:22).
  const text = await oobQuery("getinfo", "fivem0", options);
  return parseInfoResponse(text);
}
