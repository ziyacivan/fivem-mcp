import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { Hub } from "../src/hub.js";
import { FakeRconServer } from "./helpers/fake-rcon.js";

let working: FakeRconServer;
let uninstalled: FakeRconServer;
let logPath: string;

function config(base: {
  rconPort: number;
  rconPassword?: string | undefined;
  serverLogFile?: string | null;
}): Config {
  const configValue: Config = {
    host: "127.0.0.1",
    clientDevconPorts: [1],
    rconHost: "127.0.0.1",
    rconPort: base.rconPort,
    logCapacity: 50,
    quietMs: 10,
    commandTimeoutMs: 1000,
    // hub only checks the string's emptiness — "" stands in for "not configured"
    serverLogFile: base.serverLogFile === null ? "" : logPath,
  };
  if (base.rconPassword) configValue.rconPassword = base.rconPassword;
  return configValue;
}

beforeAll(async () => {
  logPath = path.join(os.tmpdir(), `fivem-mcp-bridge-${process.pid}.log`);
  await fs.writeFile(logPath, "", "utf8");

  working = new FakeRconServer("pw", (command) => {
    const tokens = command.split(" ");
    if (tokens[0] !== "mcpb") return `ran: ${command}`;
    const id = tokens[1] as string;
    if (tokens[2] === "server") {
      return `MCP_RESULT ${id} ${JSON.stringify({ ok: true, data: { pong: true } })}\n`;
    }
    const ack = `MCPB_ACK ${id} dispatched to ${tokens[3]}\n`;
    if (tokens[3] !== "99") {
      // src 99 = the fake never answers: stands in for a disconnected client
      setTimeout(() => {
        void fs.appendFile(
          logPath,
          `[           mcpb] MCP_RESULT ${id} ${JSON.stringify({ ok: true, data: { x: 5, y: 6, z: 7 } })}\n`,
          "utf8",
        );
      }, 40);
    }
    return ack;
  });

  uninstalled = new FakeRconServer("pw", () => "^2No such command mcpb.^7\n");

  await Promise.all([working.listen(), uninstalled.listen()]);
});

afterAll(async () => {
  await Promise.all([working.close(), uninstalled.close()]);
  await fs.rm(logPath, { force: true });
});

describe("Hub.bridgeCall", () => {
  it("server op answers from the rcon reply", async () => {
    const hub = new Hub(config({ rconPort: working.port, rconPassword: "pw" }));
    const result = await hub.bridgeCall({ target: "server", op: "ping" });
    expect(result).toEqual({ ok: true, data: { pong: true } });
    hub.closeAll();
  });

  it("client op answers via the server log tail", async () => {
    const hub = new Hub(config({ rconPort: working.port, rconPassword: "pw" }));
    const result = await hub.bridgeCall({
      target: "client",
      op: "position",
      src: 1,
      timeoutMs: 5000,
    });
    expect(result).toEqual({ ok: true, data: { x: 5, y: 6, z: 7 } });
    hub.closeAll();
  });

  it("a client that never answers times out with guidance", async () => {
    const hub = new Hub(config({ rconPort: working.port, rconPassword: "pw" }));
    await expect(
      hub.bridgeCall({ target: "client", op: "position", src: 99, timeoutMs: 300 }),
    ).rejects.toThrow(/did not answer/);
    hub.closeAll();
  });

  it("missing resource explains the install step", async () => {
    const hub = new Hub(config({ rconPort: uninstalled.port, rconPassword: "pw" }));
    await expect(hub.bridgeCall({ target: "server", op: "ping" })).rejects.toThrow(
      /mcpb is not installed/,
    );
    hub.closeAll();
  });

  it("without rcon credentials the bridge refuses", async () => {
    const hub = new Hub(config({ rconPort: working.port, rconPassword: undefined }));
    await expect(hub.bridgeCall({ target: "server", op: "ping" })).rejects.toThrow(
      /FIVEM_RCON_PASSWORD/,
    );
    hub.closeAll();
  });
});
