import { describe, expect, it } from "vitest";
import {
  buildCommandLine,
  encodeRequest,
  looksLikeMissingResource,
  newCallId,
  parseErrorLine,
  parseResultLine,
} from "../src/bridge-protocol.js";

describe("bridge-protocol", () => {
  it("round-trips a request through base64 in the command line", () => {
    const cmd = buildCommandLine("id7", "client", 3, { op: "teleport", x: 1, y: 2 });
    const tokens = cmd.split(" ");
    expect(tokens.slice(0, 4)).toEqual(["mcpb", "id7", "client", "3"]);
    const decoded = JSON.parse(Buffer.from(tokens[4] as string, "base64").toString("utf8"));
    expect(decoded).toEqual({ op: "teleport", x: 1, y: 2 });
  });

  it("uses '-' for a missing src", () => {
    const tokens = buildCommandLine("i", "server", null, { op: "ping" }).split(" ");
    expect(tokens.slice(0, 3)).toEqual(["mcpb", "i", "server"]);
    expect(tokens[3]).toBeDefined(); // '-' or the base64 for server dispatch
  });

  it("parses result lines only for the matching id", () => {
    const line = `MCP_RESULT id7 ${JSON.stringify({ ok: true, data: { pong: true } })}`;
    expect(parseResultLine(line, "id7")).toEqual({ ok: true, data: { pong: true } });
    expect(parseResultLine(line, "id8")).toBeNull();
    expect(parseResultLine("MCP_RESULT id7 not-json", "id7")).toMatchObject({
      ok: false,
      error: expect.stringContaining("unparseable"),
    });
  });

  it("parses MCPB_ERR and detects a missing resource", () => {
    expect(parseErrorLine("MCPB_ERR id7 bridge disabled — set mcpb_enabled true", "id7")).toBe(
      "bridge disabled — set mcpb_enabled true",
    );
    expect(parseErrorLine("MCPB_ERR other nope", "id7")).toBeNull();
    expect(looksLikeMissingResource("^2No such command mcpb.^7")).toBe(true);
    expect(looksLikeMissingResource("MCPB_ACK id1 dispatched")).toBe(false);
  });

  it("ids are regex-safe and unique-ish", () => {
    const a = newCallId();
    const b = newCallId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^mcp-[0-9a-z-]+$/);
    // usable inside a RegExp without escaping:
    expect(new RegExp(a).test(`x ${a} y`)).toBe(true);
  });

  it("encodeRequest is JSON base64", () => {
    expect(
      JSON.parse(Buffer.from(encodeRequest({ op: "ping" }), "base64").toString("utf8")),
    ).toEqual({ op: "ping" });
  });
});
