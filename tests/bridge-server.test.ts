import { beforeAll, describe, expect, it, vi } from "vitest";
import { encodeRequest } from "../src/bridge-protocol.js";

type Handler = (...args: unknown[]) => void;

const state = {
  commands: new Map<string, Handler>(),
  events: new Map<string, Handler>(),
  printed: [] as string[],
  convars: new Map<string, string>(),
  clientTriggered: [] as unknown[][],
  triggered: [] as unknown[][],
};

function run(id: string, target: string, src: string, req: Record<string, unknown>): string | null {
  const handler = state.commands.get("mcpb");
  if (!handler) throw new Error("mcpb command not registered");
  handler(-1, [id, target, src, encodeRequest(req)]);
  const line = state.printed.find(
    (l) =>
      l.startsWith(`MCP_RESULT ${id} `) ||
      l.startsWith(`MCPB_ERR ${id} `) ||
      l.startsWith(`MCPB_ACK ${id} `),
  );
  return line ?? null;
}

beforeAll(async () => {
  vi.stubGlobal("GetConvar", (name: string, def: string) => state.convars.get(name) ?? def);
  vi.stubGlobal("RegisterCommand", (name: string, cb: Handler) => state.commands.set(name, cb));
  vi.stubGlobal("RegisterNetEvent", () => undefined);
  vi.stubGlobal("AddEventHandler", (name: string, cb: Handler) => state.events.set(name, cb));
  vi.stubGlobal("TriggerClientEvent", (event: string, ...rest: unknown[]) =>
    state.clientTriggered.push([event, ...rest]),
  );
  vi.stubGlobal("TriggerEvent", (event: string, ...rest: unknown[]) =>
    state.triggered.push([event, ...rest]),
  );
  vi.stubGlobal("GetNumPlayerIndices", () => 2);
  vi.stubGlobal("GetPlayerFromIndex", (i: number) => (i === 0 ? "1" : "2"));
  vi.stubGlobal("GetPlayerName", (src: string) => `Player ${src}`);
  vi.stubGlobal("GetPlayerPing", () => 12);
  vi.stubGlobal("GetPlayerIdentifiers", () => ["license:abc"]);
  vi.stubGlobal("exports", {
    myresource: {
      add(a: number, b: number) {
        return a + b;
      },
      boom() {
        throw new Error("export exploded");
      },
    },
  });
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    state.printed.push(parts.join(" "));
  });

  state.convars.set("mcpb_enabled", "true");
  state.convars.set("mcpb_token", "");
  state.convars.set("mcpb_event_allowlist", "");

  // @ts-expect-error -- bridge/server.js is a plain FiveM script with no typings; importing it registers the command on the faked globals
  await import("../bridge/server.js");
});

describe("bridge server half (faked FiveM runtime)", () => {
  it("registers the mcpb command and the result relay event", () => {
    expect(state.commands.has("mcpb")).toBe(true);
    expect(state.events.has("mcpb:res")).toBe(true);
  });

  it("ping", () => {
    const line = run("t1", "server", "-", { op: "ping" });
    expect(line).toMatch(/"ok":true.*"pong":true/);
  });

  it("players", () => {
    const line = run("t2", "server", "-", { op: "players" });
    const result = JSON.parse((line as string).slice("MCP_RESULT t2 ".length));
    expect(result.data).toEqual([
      { src: 1, name: "Player 1", ping: 12, identifiers: ["license:abc"] },
      { src: 2, name: "Player 2", ping: 12, identifiers: ["license:abc"] },
    ]);
  });

  it("players tolerates a runtime without GetPlayerIdentifiers (live FXServer JS)", () => {
    vi.stubGlobal("GetPlayerIdentifiers", undefined);
    const line = run("t2b", "server", "-", { op: "players" });
    const result = JSON.parse((line as string).slice("MCP_RESULT t2b ".length));
    expect(result.ok).toBe(true);
    expect(result.data[0]).toEqual({ src: 1, name: "Player 1", ping: 12, identifiers: null });
    vi.stubGlobal("GetPlayerIdentifiers", (src: string) => ["license:abc"]);
  });

  it("call_export invokes a resource export synchronously", () => {
    const line = run("t3", "server", "-", {
      op: "call_export",
      resource: "myresource",
      method: "add",
      args: [2, 3],
    });
    expect(JSON.parse((line as string).slice("MCP_RESULT t3 ".length))).toEqual({
      ok: true,
      data: 5,
    });
  });

  it("call_export surfaces export failures as errors, not crashes", () => {
    const line = run("t4", "server", "-", {
      op: "call_export",
      resource: "myresource",
      method: "boom",
    });
    expect(JSON.parse((line as string).slice("MCP_RESULT t4 ".length))).toMatchObject({
      ok: false,
      error: expect.stringContaining("export exploded"),
    });
    const missing = run("t5", "server", "-", { op: "call_export", resource: "nope", method: "x" });
    expect(JSON.parse((missing as string).slice("MCP_RESULT t5 ".length)).ok).toBe(false);
  });

  it("trigger_event is allowlist-gated", () => {
    const blocked = run("t6", "server", "-", { op: "trigger_event", event: "some:event" });
    expect(JSON.parse((blocked as string).slice("MCP_RESULT t6 ".length))).toMatchObject({
      ok: false,
      error: expect.stringContaining("allowlist"),
    });
    state.convars.set("mcpb_event_allowlist", "some:event, other:event");
    const allowed = run("t7", "server", "-", {
      op: "trigger_event",
      event: "some:event",
      args: [1, "x"],
    });
    expect(JSON.parse((allowed as string).slice("MCP_RESULT t7 ".length)).ok).toBe(true);
    expect(state.triggered).toEqual([["some:event", 1, "x"]]);
    state.convars.set("mcpb_event_allowlist", "");
  });

  it("unknown op and unknown target answer with errors", () => {
    expect(
      JSON.parse(
        (run("t8", "server", "-", { op: "dance" }) as string).slice("MCP_RESULT t8 ".length),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("dance") });
    expect(
      JSON.parse((run("t9", "mars", "-", { op: "ping" }) as string).slice("MCP_RESULT t9 ".length)),
    ).toMatchObject({ ok: false });
  });

  it("client target dispatches and acks", () => {
    state.clientTriggered.length = 0;
    const line = run("c1", "client", "5", { op: "position" });
    expect(line).toContain("MCPB_ACK c1 dispatched to 5");
    expect(state.clientTriggered[0]?.[0]).toBe("mcpb:req");
    expect(state.clientTriggered[0]?.[1]).toBe(5);
  });

  it("poll drains buffered client results exactly once", () => {
    // clear any entries left by earlier tests, then produce exactly one
    run("d0", "server", "-", { op: "poll" });
    const ack = run("p1", "client", "7", { op: "position" });
    expect(ack).toContain("MCPB_ACK p1");
    state.events.get("mcpb:res")?.("p1", JSON.stringify({ ok: true, data: { z: 9 } }));
    const line = run("p2", "server", "-", { op: "poll" }) as string;
    expect(JSON.parse(line.slice("MCP_RESULT p2 ".length)).data).toEqual([
      { id: "p1", result: { ok: true, data: { z: 9 } } },
    ]);
    const again = run("p3", "server", "-", { op: "poll" }) as string;
    expect(JSON.parse(again.slice("MCP_RESULT p3 ".length)).data).toEqual([]);
  });

  it("client result relay emits only for dispatched ids", () => {
    const handler = state.events.get("mcpb:res");
    if (!handler) throw new Error("no relay");
    state.printed.length = 0;
    handler("c1", JSON.stringify({ ok: true, data: { x: 1 } }));
    expect(state.printed.join("\n")).toContain('MCP_RESULT c1 {"ok":true,"data":{"x":1}}');
    state.printed.length = 0;
    handler("forged-id", '{"ok":true,"data":"pwned"}');
    expect(state.printed.join("\n")).not.toContain("forged-id");
  });

  it("bad token rejects", () => {
    state.convars.set("mcpb_token", "s3cret");
    const line = run("k1", "server", "-", { op: "ping" });
    expect(JSON.parse((line as string).slice("MCP_RESULT k1 ".length))).toMatchObject({
      ok: false,
      error: "bad mcpb token",
    });
    const good = run("k2", "server", "-", { op: "ping", token: "s3cret" });
    expect(JSON.parse((good as string).slice("MCP_RESULT k2 ".length)).ok).toBe(true);
    state.convars.set("mcpb_token", "");
  });

  it("disabled bridge refuses without echoing payloads", () => {
    state.convars.set("mcpb_enabled", "false");
    const line = run("d1", "server", "-", { op: "ping" });
    expect(line).toContain("MCPB_ERR d1 bridge disabled");
    state.convars.set("mcpb_enabled", "true");
  });
});
