import net from "node:net";
import { hashString } from "../../src/protocol/hash.js";

function frame(magic: string, body: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header.write(magic, 0, "ascii");
  header.writeUInt16BE(211, 4);
  header.writeUInt32BE(10 + body.length, 6);
  return Buffer.concat([header, body]);
}

/** Mirrors the AINF writer in DevConServer.cpp (fivem@03dcc562:376). */
export function ainfFrame(commandLine: string): Buffer {
  const cmd = Buffer.from(commandLine, "utf8");
  const body = Buffer.alloc(2 + 4 + 4 + 4 + 32 + 32 + 1 + 4 + 4 + cmd.length + 1);
  let off = 0;
  body.writeUInt16LE(0, off);
  off += 2;
  body.writeUInt32LE(0x0eff8a1a, off);
  off += 4;
  body.writeUInt32LE(0, off);
  off += 4;
  body.writeUInt32BE(0x321f0c00, off);
  off += 4;
  body.write("CitizenFX", off, "utf8");
  off += 32;
  body.write("CitizenFX", off, "utf8");
  off += 32;
  body.writeUInt8(0xff, off);
  off += 1;
  body.writeUInt32BE(8, off);
  off += 4;
  body.writeUInt32BE(cmd.length + 1, off);
  off += 4;
  cmd.copy(body, off);
  return frame("AINF", body);
}

/** Mirrors FlushKnownChannels: 58 bytes per channel (fivem@03dcc562:96). */
export function chanFrame(channels: string[]): Buffer {
  const entries = channels.map((name) => {
    const entry = Buffer.alloc(58);
    entry.writeUInt32LE(hashString(name), 0);
    entry.writeUInt32BE(2, 12);
    entry.writeUInt32BE(2, 16);
    entry.write(name.slice(0, 29), 24, "utf8");
    entry.writeUInt32LE(1, 54);
    return entry;
  });
  const count = Buffer.alloc(4);
  count.writeUInt32BE(channels.length, 0);
  return frame("CHAN", Buffer.concat([count, ...entries]));
}

/** Mirrors FlushKnownCommands: 83-byte body (fivem@03dcc562:141). */
export function cvarFrame(command: string): Buffer {
  const body = Buffer.alloc(2 + 64 + 4 + 4 + 4 + 4 + 1);
  body.write(command.slice(0, 63), 2, "utf8");
  body.writeUInt32BE(0, 2 + 64 + 4); // flags
  body.writeUInt8(0x11, body.length - 1);
  return frame("CVAR", body);
}

/** Mirrors the PRNT writer: message at offset 40, NUL-terminated (fivem@03dcc562:175). */
export function prntFrame(channel: string, message: string): Buffer {
  const msg = Buffer.from(message, "utf8");
  const body = Buffer.alloc(2 + 4 + 24 + msg.length + 1);
  body.writeUInt32LE(hashString(channel), 2);
  msg.copy(body, 30);
  return frame("PRNT", body);
}

/**
 * A minimal reproduction of the FXServer devcon side for tests: answers the
 * PPCR hello with AINF/CHAN/CVAR, collects CMND frames, and can broadcast
 * console lines at any time.
 */
export class FakeDevconServer {
  private sockets: net.Socket[] = [];
  private listener: net.Server;
  readonly receivedCommands: string[] = [];

  onCommand: ((command: string) => void) | null = null;

  constructor(
    private readonly options: {
      commandLine?: string;
      channels?: string[];
      commands?: string[];
    } = {},
  ) {
    this.listener = net.createServer((socket) => {
      this.sockets.push(socket);
      let helloSeen = false;
      let pending = Buffer.alloc(0);

      socket.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        if (!helloSeen) {
          if (pending.length < 4) return;
          if (pending.toString("ascii", 0, 4) !== "PPCR") {
            socket.destroy();
            return;
          }
          helloSeen = true;
          pending = pending.subarray(4);
          socket.write(
            Buffer.concat([
              ainfFrame(this.options.commandLine ?? "FXServer.exe +exec server.cfg"),
              chanFrame(this.options.channels ?? ["Any", "server", "citizen:resources:core"]),
              ...(this.options.commands ?? ["restart", "ensure", "stop"]).map(cvarFrame),
            ]),
          );
        }
        for (;;) {
          if (pending.length < 12) return;
          if (pending.toString("ascii", 0, 4) !== "CMND") {
            socket.destroy();
            return;
          }
          const length = pending.readUInt32BE(6);
          if (pending.length < length) return;
          // Server-side: re-reads all but the final byte (which keeps its wire
          // value — the newline), then appends "\n". The effective command is
          // everything from 12 up to length-1.
          const command = pending.toString("utf8", 12, length - 1);
          pending = pending.subarray(length);
          this.receivedCommands.push(command);
          this.onCommand?.(command);
        }
      });
      socket.on("error", () => undefined);
      socket.on("close", () => {
        this.sockets = this.sockets.filter((s) => s !== socket);
      });
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.listener.listen(0, "127.0.0.1", () => {
        const address = this.listener.address();
        if (typeof address === "object" && address) resolve(address.port);
      });
    });
  }

  print(channel: string, message: string): void {
    const data = prntFrame(channel, message);
    for (const socket of this.sockets) socket.write(data);
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.listener.close(() => resolve()));
  }
}
