import { describe, expect, it } from "vitest";
import { loadConfig, splitAddress } from "../src/config.js";

describe("splitAddress", () => {
  it("host only keeps the fallback port", () => {
    expect(splitAddress("game.local", "127.0.0.1", 30120)).toEqual({
      host: "game.local",
      port: 30120,
    });
  });

  it("host:port", () => {
    expect(splitAddress("10.0.0.5:30121", "127.0.0.1", 30120)).toEqual({
      host: "10.0.0.5",
      port: 30121,
    });
  });

  it("bracketed IPv6 with and without a port", () => {
    expect(splitAddress("[::1]:30121", "127.0.0.1", 30120)).toEqual({ host: "::1", port: 30121 });
    expect(splitAddress("[fe80::1]", "127.0.0.1", 30120)).toEqual({
      host: "fe80::1",
      port: 30120,
    });
  });

  it("a bare IPv6 literal is a host, not host:port", () => {
    expect(splitAddress("::1", "127.0.0.1", 30120)).toEqual({ host: "::1", port: 30120 });
  });

  it("rejects a non-numeric port", () => {
    expect(() => splitAddress("host:abc", "127.0.0.1", 30120)).toThrow(/positive integer/);
  });
});

describe("loadConfig", () => {
  it("applies defaults from an empty environment", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      host: "127.0.0.1",
      clientDevconPorts: [29200, 29300],
      rconHost: "127.0.0.1",
      rconPort: 30120,
      logCapacity: 5000,
      quietMs: 400,
      commandTimeoutMs: 5000,
    });
    expect(config.rconPassword).toBeUndefined();
    expect(config.serverLogFile).toBeUndefined();
    expect(config.mcpbToken).toBeUndefined();
  });

  it("reads every variable and derives the rcon host from FIVEM_HOST", () => {
    const config = loadConfig({
      FIVEM_HOST: "192.168.1.9",
      FIVEM_CLIENT_DEVCON_PORT: "29300",
      FIVEM_RCON_PASSWORD: "pw",
      FIVEM_SERVER_LOG: "C:\\srv\\server.log",
      FIVEM_MCPB_TOKEN: "tok",
      FIVEM_CONSOLE_CAPACITY: "10",
      FIVEM_QUIET_MS: "20",
      FIVEM_COMMAND_TIMEOUT_MS: "30",
    });
    expect(config).toMatchObject({
      host: "192.168.1.9",
      clientDevconPorts: [29300],
      rconHost: "192.168.1.9",
      rconPort: 30120,
      rconPassword: "pw",
      serverLogFile: "C:\\srv\\server.log",
      mcpbToken: "tok",
      logCapacity: 10,
      quietMs: 20,
      commandTimeoutMs: 30,
    });
  });

  it("FIVEM_RCON_ADDRESS overrides host and port independently of FIVEM_HOST", () => {
    const config = loadConfig({ FIVEM_HOST: "10.1.1.1", FIVEM_RCON_ADDRESS: "srv:30130" });
    expect(config.host).toBe("10.1.1.1");
    expect(config.rconHost).toBe("srv");
    expect(config.rconPort).toBe(30130);
  });

  it("rejects non-positive integers with the variable name", () => {
    expect(() => loadConfig({ FIVEM_QUIET_MS: "0" })).toThrow(/FIVEM_QUIET_MS/);
    expect(() => loadConfig({ FIVEM_CONSOLE_CAPACITY: "1.5" })).toThrow(/FIVEM_CONSOLE_CAPACITY/);
  });
});
