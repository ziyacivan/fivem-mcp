// DevCon — the console socket every FXServer and FiveM (Legacy) client listens on.
//
// Reference implementation: citizenfx/fivem@03dcc56 (2026-09-01),
// code/components/devcon/src/DevConServer.cpp. The full wire format is
// documented in docs/protocol.md; this module is a clean-room TypeScript client
// written against that source, not a port of it.
//
// Every frame starts with: magic (4 ASCII bytes), protocol (u16 BE), length
// (u32 BE, counted from the first magic byte). FXServer listens on 29100;
// the FiveM client on 29200 (CL1) / 29300 (CL2). Enhanced clients dropped the
// client-side ports (fivem-docs legacy-vs-enhanced.md), so client devcon is
// Legacy-only.

import { EventEmitter } from "node:events";
import net from "node:net";
import { DEFAULTS } from "../defaults.js";
import { debug, debugEnabled } from "../log.js";

export const DEVCON_PROTOCOL = 211;
/**
 * The server-side port the devcon component *defines* (DevConServer.cpp:256).
 * Verified against a live FXServer on 2026-09-02: the socket does not actually
 * bind on modern server builds, so the server half of this tool uses RCON over
 * UDP instead. Kept for reference.
 */
export const DEVCON_SERVER_PORT = 29100;
export const DEVCON_CLIENT_PORTS = [29200, 29300];

/** magic + protocol + length */
const FRAME_HEADER_SIZE = 10;
const MAX_FRAME_SIZE = 1_048_576;

export interface DevconChannelEntry {
  id: number;
  name: string;
}

export interface DevconCommandEntry {
  name: string;
}

export type DevconFrame =
  | { type: "ainf"; commandLine: string; gameName: string; appName: string }
  | { type: "chan"; channels: DevconChannelEntry[] }
  | { type: "cvar"; command: string }
  | { type: "prnt"; channelId: number; message: string };

export class DevconProtocolError extends Error {}

/**
 * First bytes a devcon connection must send; the process answers with
 * AINF + CHAN + CVAR. The magic is the four ASCII characters "PPCR" — the
 * server matches it as the little-endian uint32 0x52435050.
 */
export function encodeHello(): Buffer {
  return Buffer.from("PPCR", "ascii");
}

function frameHeader(magic: string, totalLength: number): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  header.write(magic, 0, "ascii");
  header.writeUInt16BE(DEVCON_PROTOCOL, 4);
  header.writeUInt32BE(totalLength, 6);
  return header;
}

/**
 * A `CMND` frame: header, u16 zero, then the command text and **one trailing byte,
 * which must be `"\n"`**. The server reads `remaining - 1` bytes — leaving the last
 * byte at its original value — then appends its own `"\n"`. A trailing NUL therefore
 * stays embedded in the command string and it matches nothing; the working clients
 * of this socket terminate with a newline that gets stripped, not with a zero byte.
 */
export function encodeCommand(command: string): Buffer {
  const text = Buffer.from(command, "utf8");
  const totalLength = FRAME_HEADER_SIZE + 2 + text.length + 1;
  return Buffer.concat([
    frameHeader("CMND", totalLength),
    Buffer.alloc(2),
    text,
    Buffer.from([0x0a]),
  ]);
}

function cstring(buf: Buffer, start: number, size: number): string {
  const end = buf.indexOf(0, start);
  const stop = end === -1 || end > start + size ? start + size : end;
  return buf.toString("utf8", start, stop);
}

/** Decode one complete frame (length already validated). */
export function decodeFrame(buf: Buffer): DevconFrame {
  const magic = buf.toString("ascii", 0, 4);
  const length = buf.readUInt32BE(6);

  switch (magic) {
    case "AINF": {
      // offsets: 12 hash, 16 zero, 20 u32 BE, 24 game[32], 56 app[32],
      // 88 u8 0xFF, 89 u32 BE, 93 cmdLen u32 BE, 97 command line.
      if (length < 97) throw new DevconProtocolError(`AINF frame too short: ${length}`);
      const commandLength = length - 97 - 1; // minus trailing NUL
      const commandLine =
        commandLength > 0 ? buf.toString("utf8", 97, Math.min(length - 1, buf.length)) : "";
      return {
        type: "ainf",
        commandLine,
        gameName: cstring(buf, 24, 32),
        appName: cstring(buf, 56, 32),
      };
    }
    case "CHAN": {
      const count = buf.readUInt32BE(10);
      const channels: DevconChannelEntry[] = [];
      for (let i = 0; i < count; i++) {
        const base = 14 + i * 58;
        if (base + 58 > buf.length) throw new DevconProtocolError("CHAN frame truncated");
        channels.push({ id: buf.readUInt32LE(base), name: cstring(buf, base + 24, 30) });
      }
      return { type: "chan", channels };
    }
    case "CVAR": {
      // A CVAR frame announces one registered console *command* (the naming is
      // upstream's). Offsets: 12 name[64], 76 u32, 80 flags, 84 min, 88 max, 92 u8.
      if (buf.length < 93) throw new DevconProtocolError("CVAR frame too short");
      return { type: "cvar", command: cstring(buf, 12, 64) };
    }
    case "PRNT": {
      // 12 channel hash (LE), 16..40 dummy, 40 message bytes + NUL.
      if (length < 41) throw new DevconProtocolError(`PRNT frame too short: ${length}`);
      return {
        type: "prnt",
        channelId: buf.readUInt32LE(12),
        message: buf.toString("utf8", 40, length - 1),
      };
    }
    default:
      throw new DevconProtocolError(`unknown devcon frame magic: ${JSON.stringify(magic)}`);
  }
}

const KNOWN_MAGICS = new Set(["AINF", "CHAN", "CVAR", "PRNT"]);

/**
 * Incremental stream decoder: feed TCP chunks, get complete frames back.
 * Chunks are queued, not concatenated on arrival: a 1 MB frame arriving in
 * 64 KB segments used to cost a growing copy per segment (O(n²)); now the
 * queue is joined at most once per frame, when the frame is complete.
 */
export class DevconFrameDecoder {
  private chunks: Buffer[] = [];
  private total = 0;

  constructor(private readonly onFrame: (frame: DevconFrame) => void) {}

  /** Join the queue into one buffer (only when a header or frame straddles chunks). */
  private compact(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.total)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.total += chunk.length;

    for (;;) {
      if (this.total < FRAME_HEADER_SIZE) return;
      let head = this.chunks[0] as Buffer;
      if (head.length < FRAME_HEADER_SIZE) head = this.compact();
      const magic = head.toString("ascii", 0, 4);
      if (!KNOWN_MAGICS.has(magic)) {
        throw new DevconProtocolError(`unknown devcon frame magic: ${JSON.stringify(magic)}`);
      }
      const length = head.readUInt32BE(6);
      if (length < FRAME_HEADER_SIZE || length > MAX_FRAME_SIZE) {
        throw new DevconProtocolError(`bad devcon frame length: ${length}`);
      }
      if (this.total < length) return;
      if (head.length < length) head = this.compact();
      const frame = head.subarray(0, length);
      const rest = head.subarray(length);
      this.total -= length;
      if (rest.length === 0) this.chunks.shift();
      else this.chunks[0] = rest;
      this.onFrame(decodeFrame(frame));
    }
  }
}

export interface DevconPrintLine {
  /** Channel name resolved from the CHAN registry, or `#<hash>` when unknown. */
  channel: string;
  message: string;
}

export interface DevconConnectOptions {
  host: string;
  port: number;
  connectTimeoutMs?: number | undefined;
}

/**
 * A live devcon connection. Emits:
 *  - "print"  (line: DevconPrintLine)  for every console line the process writes
 *  - "ready"  on every AINF (handshake and heartbeat re-handshakes alike)
 *  - "close"  when the socket dies for any reason
 *
 * Liveness: the FiveM client can vanish without a TCP FIN (game exit, reload),
 * leaving a half-open socket that still *looks* writable. Without keepalive and
 * an application-level probe, commands would silently write into that black
 * hole. So: kernel keepalive every 10s, plus a hello-probe whenever inbound
 * traffic has been quiet for 15s — a live process answers PPCR with a fresh
 * AINF, no answer within 3s kills the socket so the next ensure() redials.
 */
export class DevconConnection extends EventEmitter {
  private socket: net.Socket;
  private decoder = new DevconFrameDecoder((frame) => this.handleFrame(frame));
  private ready = false;
  private lastRx = Date.now();
  private probePending = false;
  private probeAt = 0;
  private probeTimer: NodeJS.Timeout | null = null;

  /** Channel id -> name, populated by CHAN frames. */
  readonly channels = new Map<number, string>();
  /** Console command names, populated by CVAR frames. */
  readonly commands = new Set<string>();
  info: { commandLine: string; gameName: string; appName: string } | null = null;

  private constructor(options: DevconConnectOptions) {
    super();
    const { host, port, connectTimeoutMs = DEFAULTS.devconConnectTimeoutMs } = options;
    const socket = net.connect({ host, port });
    this.socket = socket;
    socket.setKeepAlive(true, DEFAULTS.devconKeepaliveMs);
    socket.setTimeout(connectTimeoutMs);
    socket.on("connect", () => {
      socket.setTimeout(0);
      socket.write(encodeHello());
    });
    socket.on("data", (chunk) => {
      this.lastRx = Date.now();
      try {
        this.decoder.push(chunk);
      } catch (error) {
        this.destroy();
        this.emit("error", error);
      }
    });
    socket.on("close", () => this.handleClosed());
    socket.on("timeout", () => this.destroy());
    socket.on("error", () => {
      /* surfaced through "close"; an unhandled 'error' would crash the process */
      this.destroy();
    });
    this.probeTimer = setInterval(() => this.probeTick(), DEFAULTS.devconProbeTickMs);
    this.probeTimer.unref();
  }

  private probeTick(): void {
    if (this.probePending && Date.now() - this.probeAt > DEFAULTS.devconProbeGraceMs) {
      // hello unanswered — the socket is a corpse
      this.destroy();
      return;
    }
    if (
      !this.probePending &&
      Date.now() - this.lastRx > DEFAULTS.devconQuietBeforeProbeMs &&
      this.socket.writable
    ) {
      this.probePending = true;
      this.probeAt = Date.now();
      this.socket.write(encodeHello());
    }
  }

  /**
   * Connect and resolve once the AINF handshake frame has arrived. The same
   * `connectTimeoutMs` bounds the whole handshake, not just the TCP connect:
   * a port that accepts and then stays silent must not hang the caller.
   */
  static connect(options: DevconConnectOptions): Promise<DevconConnection> {
    const connection = new DevconConnection(options);
    const { connectTimeoutMs = DEFAULTS.devconConnectTimeoutMs } = options;
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        cleanup();
        connection.destroy();
        reject(error);
      };
      const succeed = () => {
        cleanup();
        resolve(connection);
      };
      const onClose = () =>
        fail(new Error(`devcon closed before handshake (${options.host}:${options.port})`));
      const onError = (error: Error) => fail(error);
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              `devcon handshake on ${options.host}:${options.port} produced no AINF within ${connectTimeoutMs}ms`,
            ),
          ),
        connectTimeoutMs,
      );
      const cleanup = () => {
        clearTimeout(timer);
        connection.off("ready", succeed);
        connection.off("close", onClose);
        connection.off("error", onError);
      };
      connection.once("ready", succeed);
      connection.once("close", onClose);
      connection.once("error", onError);
    });
  }

  /**
   * Dial every port at once; resolves with the first connection that handshakes
   * and destroys the others. Sequential dialing made a dead first port cost its
   * full connect timeout before the live one was even tried.
   */
  static async connectFirstUsable(
    host: string,
    ports: number[],
    connectTimeoutMs?: number,
  ): Promise<DevconConnection> {
    const attempts = ports.map((port) =>
      DevconConnection.connect({ host, port, connectTimeoutMs }),
    );
    let winner: DevconConnection;
    try {
      winner = await Promise.any(attempts);
    } catch (error) {
      const errors = error instanceof AggregateError ? error.errors : [error];
      const detail = errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
      throw new Error(`no devcon listener found on ${host} (${ports.join(", ")}): ${detail}`);
    }
    for (const attempt of attempts) {
      attempt.then(
        (connection) => {
          if (connection !== winner) connection.destroy();
        },
        () => undefined,
      );
    }
    return winner;
  }

  private handleFrame(frame: DevconFrame): void {
    if (debugEnabled) debug("devcon", `<- ${frame.type} ${JSON.stringify(frame).slice(0, 200)}`);
    switch (frame.type) {
      case "ainf":
        this.probePending = false;
        this.info = {
          commandLine: frame.commandLine,
          gameName: frame.gameName,
          appName: frame.appName,
        };
        this.ready = true;
        this.emit("ready");
        break;
      case "chan":
        for (const channel of frame.channels) this.channels.set(channel.id, channel.name);
        break;
      case "cvar":
        this.commands.add(frame.command);
        break;
      case "prnt": {
        const channel = this.channels.get(frame.channelId) ?? `#${frame.channelId}`;
        this.emit("print", { channel, message: frame.message } satisfies DevconPrintLine);
        break;
      }
    }
  }

  /** Queue text into the process's console, exactly as if typed. */
  print(command: string): void {
    if (!this.socket.writable) throw new Error("devcon connection is not open");
    debug("devcon", `-> CMND ${command}`);
    this.socket.write(encodeCommand(command));
  }

  get isReady(): boolean {
    return this.ready && this.socket.writable;
  }

  destroy(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
    this.socket.destroy();
  }

  private closed = false;
  private handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}
