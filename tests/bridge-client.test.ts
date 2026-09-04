import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (...args: unknown[]) => unknown;

const events = new Map<string, Handler>();
const serverTriggers: unknown[][] = [];
const fns = {
  PlayerPedId: vi.fn(() => 42),
  FreezeEntityPosition: vi.fn(),
  SetEntityCoords: vi.fn(),
  SetEntityHeading: vi.fn(),
  SendNUIMessage: vi.fn(),
  DoFakeThing: () => "fake ran",
};

beforeAll(async () => {
  vi.stubGlobal("RegisterNetEvent", () => undefined);
  vi.stubGlobal("AddEventHandler", (name: string, cb: Handler) => events.set(name, cb));
  vi.stubGlobal("TriggerServerEvent", (...args: unknown[]) => serverTriggers.push(args));
  vi.stubGlobal("PlayerPedId", fns.PlayerPedId);
  vi.stubGlobal("GetEntityCoords", () => ({ x: 1, y: 2, z: 3 }));
  vi.stubGlobal("GetEntityHeading", () => 90);
  vi.stubGlobal("GetInteriorFromEntity", () => 17);
  vi.stubGlobal("IsPedInAnyVehicle", () => false);
  vi.stubGlobal("GetVehiclePedIsIn", () => 0);
  vi.stubGlobal("GetFrameCount", () => 7);
  vi.stubGlobal("FreezeEntityPosition", fns.FreezeEntityPosition);
  vi.stubGlobal("SetEntityCoords", fns.SetEntityCoords);
  vi.stubGlobal("SetEntityHeading", fns.SetEntityHeading);
  vi.stubGlobal("SendNUIMessage", fns.SendNUIMessage);
  vi.stubGlobal("DoFakeThing", fns.DoFakeThing);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  // @ts-expect-error -- bridge/client.js is a plain FiveM script with no typings; importing it registers the handler on the faked globals
  await import("../bridge/client.js");
});

async function call(
  req: Record<string, unknown>,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const handler = events.get("mcpb:req");
  if (!handler) throw new Error("client handler not registered");
  serverTriggers.length = 0;
  await handler("call-1", req);
  expect(serverTriggers.length).toBe(1);
  const [, , json] = serverTriggers[0] as [string, string, string];
  return JSON.parse(json);
}

describe("bridge client half (faked natives)", () => {
  it("position reads the local ped", async () => {
    const result = await call({ op: "position" });
    expect(result).toEqual({
      ok: true,
      data: { x: 1, y: 2, z: 3, heading: 90, interior: 17, vehicle: 0 },
    });
  });

  it("position fails cleanly with no ped", async () => {
    fns.PlayerPedId.mockReturnValueOnce(0);
    const result = await call({ op: "position" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no local ped/);
  });

  it("teleport and freeze call the placement natives", async () => {
    expect((await call({ op: "teleport", x: 10, y: 20, z: 30, heading: 45 })).ok).toBe(true);
    expect(fns.SetEntityCoords).toHaveBeenCalled();
    expect(fns.SetEntityHeading).toHaveBeenCalledWith(42, 45);
    expect((await call({ op: "freeze", freeze: true })).data).toEqual({ frozen: true });
    expect(fns.FreezeEntityPosition).toHaveBeenCalledWith(42, true);
  });

  it("call_native invokes a global by name and JSON-safes the result", async () => {
    expect(await call({ op: "call_native", name: "DoFakeThing" })).toEqual({
      ok: true,
      data: "fake ran",
    });
    const missing = await call({ op: "call_native", name: "NoSuchNative" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/not a function/);
  });

  it("send_nui pushes a message", async () => {
    expect((await call({ op: "send_nui", message: { kind: "open" } })).ok).toBe(true);
    expect(fns.SendNUIMessage).toHaveBeenCalled();
  });

  it("nui_callback POSTs to the resource and parses JSON", async () => {
    const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
      expect(url).toBe("https://breeze-multichar/choose");
      return {
        status: 200,
        text: async () => JSON.stringify({ ok: true, echo: JSON.parse(init.body) }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await call({
      op: "nui_callback",
      resource: "breeze-multichar",
      endpoint: "choose",
      payload: { citizenId: "DW" },
    });
    expect(result).toMatchObject({ ok: true, data: { status: 200 } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://breeze-multichar/choose");
  });

  it("unknown ops answer with errors", async () => {
    const result = await call({ op: "break-game" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown client op/);
  });
});

describe("bridge client half — hardening", () => {
  it("call_native only reaches PascalCase own globals (no prototype walking)", async () => {
    for (const name of ["__proto__", "constructor", "eval", "doFakeThing", "Object.keys"]) {
      const result = await call({ op: "call_native", name });
      expect(result.ok, name).toBe(false);
    }
    vi.stubGlobal("GetConvar", (key: string, def: string) =>
      key === "mcpb_native_allowlist" ? "SomethingElse" : def,
    );
    const blocked = await call({ op: "call_native", name: "DoFakeThing" });
    expect(blocked.error).toMatch(/allowlist/);
    vi.stubGlobal("GetConvar", (_key: string, def: string) => def);
    expect((await call({ op: "call_native", name: "DoFakeThing" })).ok).toBe(true);
  });

  it("teleport rejects non-finite coordinates before touching the native", async () => {
    fns.SetEntityCoords.mockClear();
    const result = await call({ op: "teleport", x: "nope", y: 1, z: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/finite/);
    expect(fns.SetEntityCoords).not.toHaveBeenCalled();
  });

  it("BigInt nested in a native result serialises instead of losing the answer", async () => {
    vi.stubGlobal("BigNative", () => ({ deep: { hash: 123n } }));
    const result = await call({ op: "call_native", name: "BigNative" });
    expect(result).toEqual({ ok: true, data: { deep: { hash: "123" } } });
  });

  it("nui_callback times out instead of never answering", async () => {
    vi.stubGlobal("GetConvar", (key: string, def: string) =>
      key === "mcpb_nui_timeout_ms" ? "30" : def,
    );
    vi.stubGlobal(
      "fetch",
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const result = await call({ op: "nui_callback", resource: "r", endpoint: "hang" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not answer within 30ms/);
    vi.stubGlobal("GetConvar", (_key: string, def: string) => def);
  });
});
