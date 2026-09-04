import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { Hub } from "../src/hub.js";
import { buildMcpServer } from "../src/server.js";
import { FakeDevconServer } from "./helpers/fake-devcon.js";
import { FakeRconServer } from "./helpers/fake-rcon.js";

let client: Client;
let clientFake: FakeDevconServer;
let rconFake: FakeRconServer;
let hub: Hub;
let logPath: string;

function resultText(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
}

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

beforeAll(async () => {
  clientFake = new FakeDevconServer({
    commandLine: "FiveM.app\\FXServer.exe -b2802",
    channels: ["Any", "citizen:resources:core", "breeze-chat"],
    commands: ["connect", "rerun"],
  });
  clientFake.onCommand = (command) =>
    clientFake.print("citizen:resources:core", `client ran ${command}`);
  const clientPort = await clientFake.listen();

  rconFake = new FakeRconServer("panel-pw", (command) => `rcon ran ${command}\n`);
  const rconPort = await rconFake.listen();

  logPath = path.join(os.tmpdir(), `fivem-mcp-test-${process.pid}.log`);
  await fs.writeFile(
    logPath,
    "[           resources] Started resource breeze-chat\n[script:breeze-migrat] applying migrations\n",
    "utf8",
  );

  const config: Config = {
    host: "127.0.0.1",
    clientDevconPorts: [clientPort],
    rconHost: "127.0.0.1",
    rconPort,
    rconPassword: "panel-pw",
    serverLogFile: logPath,
    logCapacity: 200,
    quietMs: 50,
    commandTimeoutMs: 3000,
  };

  hub = new Hub(config);
  const mcpServer = buildMcpServer(config, hub);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
});

afterAll(async () => {
  hub?.closeAll();
  await Promise.all([clientFake?.close(), rconFake?.close()]);
  await fs.rm(logPath, { force: true });
});

describe("MCP surface", () => {
  it("exposes the full tool surface", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "bridge",
      "click",
      "client_command",
      "focus_window",
      "hold_key",
      "launch",
      "list_commands",
      "mouse_move",
      "press_key",
      "quit_game",
      "read_client_log",
      "read_console",
      "release_key",
      "restore_focus",
      "screenshot",
      "scroll",
      "server_command",
      "server_info",
      "status",
      "type_text",
      "wait",
      "wait_for_console",
      "window_status",
    ]);
  });

  it("every tool carries annotations; JSON-shaped tools declare an outputSchema", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [
      "status",
      "server_info",
      "read_console",
      "wait_for_console",
      "list_commands",
      "window_status",
      "read_client_log",
      "bridge",
    ]) {
      expect(byName.get(name)?.outputSchema, name).toBeDefined();
    }
    expect(byName.get("status")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("server_command")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("quit_game")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("press_key")?.annotations?.destructiveHint).toBe(false);
  });

  it("structured results carry structuredContent that matches the text fallback", async () => {
    const result = await call("status", {});
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toEqual(JSON.parse(resultText(result)));
    expect(
      (result.structuredContent as { server: { rcon: { configured: boolean } } }).server.rcon
        .configured,
    ).toBe(true);
  });

  it("a cancelled wait_for_console stops waiting instead of running to its timeout", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = client.callTool(
      {
        name: "wait_for_console",
        arguments: { target: "server", pattern: "never-ever", timeoutMs: 60_000 },
      },
      undefined,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("bridge rejects an op that belongs to the other target", async () => {
    const result = await call("bridge", { target: "server", op: "teleport" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/not a server op/);
    const noSrc = await call("bridge", { target: "client", op: "position" });
    expect(noSrc.isError).toBe(true);
    expect(resultText(noSrc)).toMatch(/needs src/);
  });

  it("window tools are registered everywhere and report the platform honestly", async () => {
    const result = await call("window_status", {});
    if (process.platform === "win32") {
      expect(JSON.parse(resultText(result))).toHaveProperty("found");
    } else {
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(/win32/);
    }
  });

  it("offers the live-verification prompts", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(["smoke_check", "test_resource"]);

    const got = await client.getPrompt({
      name: "test_resource",
      arguments: { resource: "breeze-chat", expectations: "the chat window must open" },
    });
    const text = JSON.stringify(got.messages);
    expect(text).toContain("breeze-chat");
    expect(text).toContain("chat window must open");
    expect(text).toContain("wait_for_console");

    const sweep = await client.getPrompt({ name: "smoke_check", arguments: {} });
    expect(JSON.stringify(sweep.messages)).toContain("server_info");
  });

  it("status reports rcon, the log file and a not-yet-dialed client", async () => {
    const payload = JSON.parse(resultText(await call("status", {})));
    expect(payload.server.rcon).toMatchObject({ configured: true });
    expect(payload.server.logFile).toMatchObject({ path: logPath, exists: true });
    expect(payload.client.connected).toBe(false);
  });

  it("server_command runs over UDP RCON", async () => {
    const result = await call("server_command", { command: "who" });
    expect(resultText(result)).toContain("rcon ran who");
  });

  it("rejects multi-line commands (newline = second command smuggled into the payload)", async () => {
    const server = await call("server_command", { command: "status\nstop mapmanager" });
    expect(server.isError).toBe(true);
    expect(resultText(server)).toMatch(/single line/);
    const client = await call("client_command", { command: "connect x\rquit" });
    expect(client.isError).toBe(true);
    expect(rconFake.receivedRequests.some((b) => b.toString().includes("mapmanager"))).toBe(false);
  });

  it("server_info answers without any credentials", async () => {
    const payload = JSON.parse(resultText(await call("server_info", {})));
    expect(payload.hostname).toBe("fake test server");
    expect(payload.iv).toBe("179740983");
  });

  it("client_command reaches the client console and collects output", async () => {
    const result = await call("client_command", { command: "connect localhost:30120" });
    expect(resultText(result)).toContain("client ran connect localhost:30120");
  });

  it("status now shows the client connected with its process line", async () => {
    const payload = JSON.parse(resultText(await call("status", {})));
    expect(payload.client.connected).toBe(true);
    expect(payload.client.process).toContain("FiveM.app");
  });

  it("read_console tails the server log file with filters", async () => {
    const all = JSON.parse(resultText(await call("read_console", { target: "server" })));
    expect(all.matched).toBe(2);
    expect(all.lines[0]).toMatchObject({
      channel: "resources",
      message: "Started resource breeze-chat",
    });

    const filtered = JSON.parse(
      resultText(await call("read_console", { target: "server", channel: "script:breeze-migrat" })),
    );
    expect(filtered.matched).toBe(1);
  });

  it("read_console filters and pages the client buffer", async () => {
    const first = JSON.parse(
      resultText(
        await call("read_console", { target: "client", contains: "client ran", limit: 1 }),
      ),
    );
    expect(first.matched).toBe(1);
    expect(first.lines[0].message).toContain("client ran");

    const page = JSON.parse(
      resultText(await call("read_console", { target: "client", afterSeq: first.nextSeq })),
    );
    expect(page.lines).toEqual([]);
  });

  it("wait_for_console polls the server log for lines appended after the call", async () => {
    setTimeout(() => {
      void fs.appendFile(
        logPath,
        "[           resources] APPENDED character screen ready\n",
        "utf8",
      );
    }, 100);
    const hit = await call("wait_for_console", {
      target: "server",
      pattern: "APPENDED",
      timeoutMs: 5000,
    });
    expect(JSON.parse(resultText(hit)).message).toContain("character screen ready");

    const miss = await call("wait_for_console", {
      target: "server",
      pattern: "never-ever",
      timeoutMs: 300,
    });
    expect(miss.isError).toBe(true);
    expect(resultText(miss)).toContain("never-ever");
  });

  it("wait_for_console matches buffered client lines", async () => {
    const hit = await call("wait_for_console", {
      target: "client",
      pattern: "client ran connect",
      timeoutMs: 500,
    });
    expect(JSON.parse(resultText(hit)).message).toContain("client ran connect localhost:30120");
  });

  it("list_commands reads the client CVAR registry", async () => {
    const payload = JSON.parse(resultText(await call("list_commands", { contains: "CON" })));
    expect(payload.commands).toEqual(["connect"]);
  });

  it("a dead client target produces a helpful error", async () => {
    await clientFake.close();
    hub.closeAll();
    const result = await call("client_command", { command: "connect localhost:30120" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/no client devcon found/);
  });
});

describe("RCON-less server access", () => {
  it("server_command explains what to configure when no password is set", async () => {
    const config: Config = {
      host: "127.0.0.1",
      clientDevconPorts: [1],
      rconHost: "127.0.0.1",
      rconPort: 1,
      logCapacity: 10,
      quietMs: 10,
      commandTimeoutMs: 100,
    };
    const bareHub = new Hub(config);
    await expect(bareHub.runServerCommand("status")).rejects.toThrow(/RCON/);
  });
});
