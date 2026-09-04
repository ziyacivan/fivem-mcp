import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { Hub } from "../src/hub.js";
import { FakeRconServer } from "./helpers/fake-rcon.js";

interface Pending {
  id: string;
  result: unknown;
}

let working: FakeRconServer;
let legacy: FakeRconServer;
let uninstalled: FakeRconServer;
let logPath: string;
const queue: Pending[] = [];

function config(base: {
  rconPort: number;
  rconPassword?: string | undefined;
  withLog?: boolean | undefined;
}): Config {
  const configValue: Config = {
    host: "127.0.0.1",
    clientDevconPorts: [1],
    rconHost: "127.0.0.1",
    rconPort: base.rconPort,
    logCapacity: 50,
    quietMs: 10,
    commandTimeoutMs: 1000,
  };
  if (base.rconPassword) configValue.rconPassword = base.rconPassword;
  if (base.withLog !== false) configValue.serverLogFile = logPath;
  return configValue;
}

function mcpbTokens(command: string): string[] | null {
  const tokens = command.split(" ");
  return tokens[0] === "mcpb" ? tokens : null;
}

beforeAll(async () => {
  logPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "fivem-mcp-bridge-")), "server.log");
  await fs.writeFile(logPath, "", "utf8");

  // v0.5 bridge: results are drained in-band by the `poll` op.
  working = new FakeRconServer("pw", (command) => {
    const tokens = mcpbTokens(command);
    if (!tokens) return `ran: ${command}`;
    const id = tokens[1] as string;
    if (tokens[2] === "server") {
      let req: { op?: string } = {};
      try {
        req = JSON.parse(Buffer.from(tokens[4] as string, "base64").toString("utf8"));
      } catch {
        /* keep default */
      }
      if (req.op === "poll") {
        const drained = queue.splice(0);
        return `MCP_RESULT ${id} ${JSON.stringify({ ok: true, data: drained })}\n`;
      }
      return `MCP_RESULT ${id} ${JSON.stringify({ ok: true, data: { pong: true } })}\n`;
    }
    const ack = `MCPB_ACK ${id} dispatched to ${tokens[3]}\n`;
    if (tokens[3] !== "99") {
      // src 99 = never answers: stands in for a disconnected client
      const target = tokens[3] as string;
      setTimeout(() => {
        queue.push({ id, result: { ok: true, data: { x: 5, y: 6, src: Number(target) } } });
      }, 60);
    }
    return ack;
  });

  // pre-0.5 bridge: no poll op, results only reach the console/log.
  legacy = new FakeRconServer("pw", (command) => {
    const tokens = mcpbTokens(command);
    if (!tokens) return `ran: ${command}`;
    const id = tokens[1] as string;
    if (tokens[2] === "server") {
      return `MCP_RESULT ${id} ${JSON.stringify({ ok: false, error: "unknown server op 'poll'" })}\n`;
    }
    setTimeout(() => {
      void fs.appendFile(
        logPath,
        `[           mcpb] MCP_RESULT ${id} ${JSON.stringify({ ok: true, data: { via: "log" } })}\n`,
        "utf8",
      );
    }, 120);
    return `MCPB_ACK ${id} dispatched to ${tokens[3]}\n`;
  });

  uninstalled = new FakeRconServer("pw", () => "^2No such command mcpb.^7\n");

  await Promise.all([working.listen(), legacy.listen(), uninstalled.listen()]);
});

afterAll(async () => {
  await Promise.all([working.close(), legacy.close(), uninstalled.close()]);
  await fs.rm(path.dirname(logPath), { recursive: true, force: true });
});

describe("Hub.bridgeCall", () => {
  it("server op answers from the rcon reply", async () => {
    const hub = new Hub(config({ rconPort: working.port, rconPassword: "pw" }));
    const result = await hub.bridgeCall({ target: "server", op: "ping" });
    expect(result).toEqual({ ok: true, data: { pong: true } });
    hub.closeAll();
  });

  it("client op collects its result via the in-band poll — no log file needed", async () => {
    const hub = new Hub(config({ rconPort: working.port, rconPassword: "pw", withLog: false }));
    const result = await hub.bridgeCall({
      target: "client",
      op: "position",
      src: 1,
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({ ok: true, data: { x: 5, src: 1 } });
    hub.closeAll();
  });

  it("a client that never answers times out with guidance", async () => {
    const hub = new Hub(config({ rconPort: working.port, rconPassword: "pw" }));
    await expect(
      hub.bridgeCall({ target: "client", op: "position", src: 99, timeoutMs: 500 }),
    ).rejects.toThrow(/did not answer/);
    hub.closeAll();
  });

  it("overlapping calls route by id (inbox drains foreign poll entries)", async () => {
    const hub = new Hub(config({ rconPort: working.port, rconPassword: "pw" }));
    const [a, b] = await Promise.all([
      hub.bridgeCall({ target: "client", op: "position", src: 3, timeoutMs: 5000 }),
      hub.bridgeCall({ target: "client", op: "position", src: 4, timeoutMs: 5000 }),
    ]);
    expect(a).toMatchObject({ ok: true, data: { src: 3 } });
    expect(b).toMatchObject({ ok: true, data: { src: 4 } });
    hub.closeAll();
  });

  it("falls back to the log tail against a pre-0.5 bridge resource", async () => {
    const hub = new Hub(config({ rconPort: legacy.port, rconPassword: "pw" }));
    const result = await hub.bridgeCall({
      target: "client",
      op: "position",
      src: 1,
      timeoutMs: 5000,
    });
    expect(result).toEqual({ ok: true, data: { via: "log" } });
    hub.closeAll();
  });

  it("pre-0.5 bridge without a log file explains what to do", async () => {
    const hub = new Hub(config({ rconPort: legacy.port, rconPassword: "pw", withLog: false }));
    await expect(
      hub.bridgeCall({ target: "client", op: "position", src: 1, timeoutMs: 1000 }),
    ).rejects.toThrow(/predates the in-band 'poll' op/);
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
    const hub = new Hub(config({ rconPort: working.port }));
    await expect(hub.bridgeCall({ target: "server", op: "ping" })).rejects.toThrow(
      /FIVEM_RCON_PASSWORD/,
    );
    hub.closeAll();
  });
});
