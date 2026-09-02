import { afterEach, describe, expect, it } from "vitest";
import {
  encodeOobRequest,
  oobQuery,
  parseInfoResponse,
  queryServerInfo,
} from "../src/protocol/oob.js";
import { FakeRconServer } from "./helpers/fake-rcon.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("encodeOobRequest", () => {
  it("is 0xFFFFFFFF + '<key>\\n<payload>'", () => {
    const request = encodeOobRequest("getinfo", "fivem-mcp");
    expect(request.subarray(0, 4).equals(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toBe(true);
    expect(request.subarray(4).toString("utf8")).toBe("getinfo\nfivem-mcp");
  });
});

describe("parseInfoResponse", () => {
  it("parses a captured live FXServer reply", () => {
    // Real bytes from a live FXServer (localhost:30120) on 2026-09-02.
    const live =
      "infoResponse\n\\sv_maxclients\\48\\clients\\0\\challenge\\xyz0\\gamename\\CitizenFX" +
      "\\protocol\\4\\hostname\\breeze standalone [dev]\\gametype\\\\mapname\\\\iv\\179740983";
    const info = parseInfoResponse(live);
    expect(info.hostname).toBe("breeze standalone [dev]");
    expect(info.sv_maxclients).toBe("48");
    expect(info.clients).toBe("0");
    expect(info.protocol).toBe("4");
    expect(info.gametype).toBe("");
    expect(info.iv).toBe("179740983");
  });

  it("tolerates a missing leading backslash", () => {
    expect(parseInfoResponse("statusResponse\nhostname\\X")).toEqual({ hostname: "X" });
  });
});

describe("oobQuery / queryServerInfo", () => {
  it("round-trips with the fake server and echoes the challenge", async () => {
    const server = new FakeRconServer("irrelevant");
    const port = await server.listen();
    cleanups.push(() => server.close());

    const info = await queryServerInfo({ host: "127.0.0.1", port });
    expect(info.hostname).toBe("fake test server");
    expect(info.challenge).toBe("fivem0");
  });

  it("times out when nothing answers", async () => {
    await expect(
      oobQuery("getinfo", "x", { host: "127.0.0.1", port: 1, timeoutMs: 200 }),
    ).rejects.toThrow(/no OOB reply/);
  });
});
