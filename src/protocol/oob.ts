// Out-of-band UDP queries against the FXServer game port — the no-credential
// half of the server protocol. Verified live against a running FXServer on
// 2026-09-02 (hostname, client counts and build id came back unprompted).
//
// References (citizenfx/fivem@03dcc562, 2026-09-01):
//  - code/components/citizen-server-impl/include/decorators/WithOutOfBand.h
//  - code/components/citizen-server-impl/include/outofbandhandlers/GetInfoOutOfBand.h

import dgram from "node:dgram";
import { sameHost } from "./rcon.js";

const OOB_PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);

export function encodeOobRequest(key: string, payload: string): Buffer {
  return Buffer.concat([OOB_PREFIX, Buffer.from(`${key}\n${payload}`, "utf8")]);
}

/** `infoResponse\n\hostname\Foo\clients\0\...` -> flat key/value map. */
export function parseInfoResponse(text: string): Record<string, string> {
  const newline = text.indexOf("\n");
  const body = (newline === -1 ? text : text.slice(newline + 1)).trim();
  const tokens = body.split("\\");
  if (body.startsWith("\\")) tokens.shift();
  const info: Record<string, string> = {};
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    info[tokens[i] as string] = tokens[i + 1] as string;
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
  const { host, port, timeoutMs = 3000 } = options;
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(
      () => fail(new Error(`no OOB reply to ${key} from ${host}:${port} within ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.on("message", (msg, rinfo) => {
      if (settled) return;
      if (rinfo.port !== port || !sameHost(rinfo.address, host)) return; // spoofed reply
      settled = true;
      clearTimeout(timer);
      let payloadReply = msg;
      if (payloadReply.length >= 4 && payloadReply.readUInt32BE(0) === 0xffffffff) {
        payloadReply = payloadReply.subarray(4);
      }
      const text = payloadReply.toString("utf8");
      socket.close();
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
