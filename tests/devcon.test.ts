import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DevconConnection,
  DevconFrameDecoder,
  encodeCommand,
  encodeHello,
} from "../src/protocol/devcon.js";
import {
  ainfFrame,
  chanFrame,
  cvarFrame,
  FakeDevconServer,
  prntFrame,
} from "./helpers/fake-devcon.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe("frame encoders", () => {
  it("hello is the four ASCII bytes PPCR", () => {
    expect(encodeHello().toString("ascii")).toBe("PPCR");
  });

  it("CMND layout matches the server parser", () => {
    const buf = encodeCommand("status");
    expect(buf.toString("ascii", 0, 4)).toBe("CMND");
    expect(buf.readUInt16BE(4)).toBe(211);
    expect(buf.readUInt32BE(6)).toBe(buf.length);
    expect(buf.readUInt16BE(10)).toBe(0);
    expect(buf.toString("utf8", 12, 12 + "status".length)).toBe("status");
    // The trailing byte survives into the command string (live-verified 2026-09-02:
    // a NUL there makes the command match nothing) — it must be the newline.
    expect(buf[buf.length - 1]).toBe(0x0a);
  });
});

describe("frame decoder", () => {
  it("reassembles frames split across arbitrary chunks", () => {
    const frames = [
      ainfFrame("FXServer.exe +exec server.cfg"),
      chanFrame(["Any", "server"]),
      cvarFrame("restart"),
      prntFrame("server", "hello world"),
    ];
    const wire = Buffer.concat(frames);

    const seen: string[] = [];
    const decoder = new DevconFrameDecoder((frame) => seen.push(frame.type));
    for (let i = 0; i < wire.length; i++) decoder.push(wire.subarray(i, i + 1));
    expect(seen).toEqual(["ainf", "chan", "cvar", "prnt"]);
  });

  it("rejects unknown magics", () => {
    const decoder = new DevconFrameDecoder(() => undefined);
    const bogus = Buffer.alloc(10);
    bogus.write("XXXX", 0, "ascii");
    bogus.writeUInt32BE(10, 6);
    expect(() => decoder.push(bogus)).toThrow(/unknown devcon frame magic/);
  });

  it("rejects absurd frame lengths", () => {
    const decoder = new DevconFrameDecoder(() => undefined);
    const bogus = Buffer.alloc(10);
    bogus.write("PRNT", 0, "ascii");
    bogus.writeUInt32BE(99_999_999, 6);
    expect(() => decoder.push(bogus)).toThrow(/bad devcon frame length/);
  });
});

describe("DevconConnection", () => {
  it("handshakes, learns channels and commands, and delivers prints", async () => {
    const server = new FakeDevconServer({
      commandLine: "FXServer.exe +exec server.cfg",
      channels: ["Any", "server", "breeze-chat"],
      commands: ["restart", "ensure"],
    });
    const port = await server.listen();
    cleanups.push(() => server.close());

    const connection = await DevconConnection.connect({ host: "127.0.0.1", port });
    cleanups.push(async () => connection.destroy());

    expect(connection.info?.commandLine).toBe("FXServer.exe +exec server.cfg");
    expect(connection.commands.has("restart")).toBe(true);
    expect(connection.commands.has("ensure")).toBe(true);

    const received = new Promise<{ channel: string; message: string }>((resolve) =>
      connection.once("print", resolve),
    );
    server.print("breeze-chat", "session opened for 1");
    const line = await received;
    expect(line.channel).toBe("breeze-chat");
    expect(line.message).toBe("session opened for 1");
  });

  it("labels prints from unregistered channels with their hash id", async () => {
    const server = new FakeDevconServer({ channels: ["Any"] });
    const port = await server.listen();
    cleanups.push(() => server.close());

    const connection = await DevconConnection.connect({ host: "127.0.0.1", port });
    cleanups.push(async () => connection.destroy());

    const received = new Promise<{ channel: string }>((resolve) =>
      connection.once("print", resolve),
    );
    server.print("mystery-channel", "x");
    const line = await received;
    expect(line.channel).toMatch(/^#\d+$/);
  });

  it("sends commands as CMND frames the server reads back verbatim", async () => {
    const server = new FakeDevconServer();
    const port = await server.listen();
    cleanups.push(() => server.close());

    const connection = await DevconConnection.connect({ host: "127.0.0.1", port });
    cleanups.push(async () => connection.destroy());

    connection.print("ensure breeze-chat");
    await vi_poll(() => server.receivedCommands.includes("ensure breeze-chat"));

    connection.print("restart breeze-chat\nstop mapmanager");
    await vi_poll(() => server.receivedCommands.includes("restart breeze-chat\nstop mapmanager"));
  });

  it("connectFirstUsable skips dead ports and finds the live one", async () => {
    const server = new FakeDevconServer();
    const livePort = await server.listen();
    cleanups.push(() => server.close());
    const deadPort = await closedPort();

    const connection = await DevconConnection.connectFirstUsable("127.0.0.1", [deadPort, livePort]);
    cleanups.push(async () => connection.destroy());
    expect(connection.isReady).toBe(true);
  });

  it("rejects connect when nothing answers the handshake", async () => {
    const deadPort = await closedPort();
    await expect(
      DevconConnection.connect({ host: "127.0.0.1", port: deadPort, connectTimeoutMs: 1000 }),
    ).rejects.toThrow();
  });

  it("rejects when the port accepts but never sends AINF (handshake deadline)", async () => {
    const accepted: net.Socket[] = [];
    const silent = net.createServer((socket) => {
      accepted.push(socket); // accept and say nothing
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          for (const socket of accepted) socket.destroy();
          silent.close(() => resolve());
        }),
    );
    const { port } = silent.address() as net.AddressInfo;

    const started = Date.now();
    await expect(
      DevconConnection.connect({ host: "127.0.0.1", port, connectTimeoutMs: 200 }),
    ).rejects.toThrow(/no AINF within 200ms/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

async function vi_poll(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
