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

function run(
  id: string,
  target: string,
  src: string,
  req: Record<string, unknown>,
  caller = 0,
): string | null {
  const handler = state.commands.get("mcpb");
  if (!handler) throw new Error("mcpb command not registered");
  // FiveM passes source 0 for console/RCON invocations; players carry their server id.
  handler(caller, [id, target, src, encodeRequest(req)]);
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

  it("refuses invocations from players (only source 0 = console/RCON may run mcpb)", () => {
    const line = run("t1p", "server", "-", { op: "ping" }, 5);
    expect(line).toBeNull();
    expect(state.printed.some((l) => l.startsWith("MCPB_DENY player 5"))).toBe(true);
    expect(state.clientTriggered.filter((t) => t[0] === "mcpb:req").length).toBe(0);
    const client = run("t1q", "client", "3", { op: "position" }, 5);
    expect(client).toBeNull();
  });

  it("players", () => {
    const line = run("t2", "server", "-", { op: "players", identifiers: true });
    const result = JSON.parse((line as string).slice("MCP_RESULT t2 ".length));
    expect(result.data).toEqual([
      { src: 1, name: "Player 1", ping: 12, identifiers: ["license:abc"] },
      { src: 2, name: "Player 2", ping: 12, identifiers: ["license:abc"] },
    ]);
  });

  it("players tolerates a runtime without GetPlayerIdentifiers (live FXServer JS)", () => {
    vi.stubGlobal("GetPlayerIdentifiers", undefined);
    const line = run("t2b", "server", "-", { op: "players", identifiers: true });
    const result = JSON.parse((line as string).slice("MCP_RESULT t2b ".length));
    expect(result.ok).toBe(true);
    expect(result.data[0]).toEqual({ src: 1, name: "Player 1", ping: 12, identifiers: null });
    vi.stubGlobal("GetPlayerIdentifiers", () => ["license:abc"]);
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

describe("bridge server half — hardening", () => {
  const resultOf = (line: string | null, id: string) =>
    JSON.parse((line as string).slice(`MCP_RESULT ${id} `.length));

  it("players omits identifiers unless asked (datagram budget)", () => {
    const result = resultOf(run("h0", "server", "-", { op: "players" }), "h0");
    expect(result.data[0]).toEqual({ src: 1, name: "Player 1", ping: 12 });
  });

  it("call_export validates argument types and honours mcpb_export_allowlist", () => {
    const bad = resultOf(run("h1", "server", "-", { op: "call_export", resource: 5 }), "h1");
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("string") });
    state.convars.set("mcpb_export_allowlist", "other:*, myresource:boom");
    const blocked = resultOf(
      run("h2", "server", "-", {
        op: "call_export",
        resource: "myresource",
        method: "add",
        args: [1, 1],
      }),
      "h2",
    );
    expect(blocked).toMatchObject({ ok: false, error: expect.stringContaining("allowlist") });
    state.convars.set("mcpb_export_allowlist", "myresource:*");
    const allowed = resultOf(
      run("h3", "server", "-", {
        op: "call_export",
        resource: "myresource",
        method: "add",
        args: [1, 1],
      }),
      "h3",
    );
    expect(allowed).toEqual({ ok: true, data: 2 });
    state.convars.set("mcpb_export_allowlist", "");
  });

  it("trigger_event rejects a non-numeric player id", () => {
    state.convars.set("mcpb_event_allowlist", "ev");
    const bad = resultOf(
      run("h4", "server", "-", { op: "trigger_event", event: "ev", toClient: true, player: "abc" }),
      "h4",
    );
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("player") });
    state.convars.set("mcpb_event_allowlist", "");
  });

  it("malformed command lines (wrong token count, non-object payload) answer with errors", () => {
    const handler = state.commands.get("mcpb");
    if (!handler) throw new Error("no command");
    state.printed.length = 0;
    handler(0, ["h5", "server", "-", encodeRequest({ op: "ping" }), "extra"]);
    expect(state.printed.join("\n")).toMatch(/MCP_RESULT h5 .*bad request payload/);
    state.printed.length = 0;
    handler(0, ["h6", "server", "-", Buffer.from("[1,2]").toString("base64")]);
    expect(state.printed.join("\n")).toMatch(/MCP_RESULT h6 .*must be a JSON object/);
  });

  it("oversized results are truncated to fit one datagram, with a marker", () => {
    vi.stubGlobal("exports", {
      big: { blob: () => "x".repeat(5000) },
    });
    const result = resultOf(
      run("h7", "server", "-", { op: "call_export", resource: "big", method: "blob" }),
      "h7",
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ truncated: true, bytes: expect.any(Number) });
    expect(JSON.stringify(result).length).toBeLessThan(1400);
  });

  it("BigInt anywhere in a result serialises instead of throwing", () => {
    vi.stubGlobal("exports", { h: { hash: () => ({ nested: { value: 12345678901234567890n } }) } });
    const result = resultOf(
      run("h8", "server", "-", { op: "call_export", resource: "h", method: "hash" }),
      "h8",
    );
    expect(result).toEqual({ ok: true, data: { nested: { value: "12345678901234567890" } } });
  });

  it("a client op nobody answers fails fast after mcpb_client_timeout_ms", async () => {
    state.convars.set("mcpb_client_timeout_ms", "40");
    run("d0", "server", "-", { op: "poll" }); // drain
    const ack = run("h9", "client", "3", { op: "position" });
    expect(ack).toContain("MCPB_ACK h9");
    await new Promise((r) => setTimeout(r, 90));
    const polled = resultOf(run("h10", "server", "-", { op: "poll" }), "h10");
    expect(polled.data).toEqual([
      { id: "h9", result: { ok: false, error: expect.stringContaining("did not answer") } },
    ]);
    // the late answer is ignored: the id is no longer pending
    state.printed.length = 0;
    state.events.get("mcpb:res")?.("h9", JSON.stringify({ ok: true }));
    expect(state.printed.join("\n")).not.toContain("MCP_RESULT h9");
    state.convars.delete("mcpb_client_timeout_ms");
  });

  it("poll honours max and never returns more than one datagram of entries", () => {
    run("d1", "server", "-", { op: "poll" }); // drain
    for (let i = 0; i < 5; i++) {
      run(`m${i}`, "client", "3", { op: "ping" });
      state.events.get("mcpb:res")?.(`m${i}`, JSON.stringify({ ok: true, data: { i } }));
    }
    const first = resultOf(run("h11", "server", "-", { op: "poll", max: 2 }), "h11");
    expect(first.data.map((e: { id: string }) => e.id)).toEqual(["m0", "m1"]);
    const rest = resultOf(run("h12", "server", "-", { op: "poll" }), "h12");
    expect(rest.data.map((e: { id: string }) => e.id)).toEqual(["m2", "m3", "m4"]);
  });

  it("token comparison is exact (no prefix match)", () => {
    state.convars.set("mcpb_token", "s3cret");
    const prefix = resultOf(run("h13", "server", "-", { op: "ping", token: "s3c" }), "h13");
    expect(prefix).toMatchObject({ ok: false, error: "bad mcpb token" });
    const longer = resultOf(run("h14", "server", "-", { op: "ping", token: "s3cretXX" }), "h14");
    expect(longer).toMatchObject({ ok: false, error: "bad mcpb token" });
    state.convars.set("mcpb_token", "");
  });
});
