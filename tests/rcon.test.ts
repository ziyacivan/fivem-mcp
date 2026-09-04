import { describe, expect, it } from "vitest";
import { sameHost } from "../src/protocol/oob.js";
import {
  encodeRconRequest,
  parseRconResponse,
  RconClient,
  RconError,
} from "../src/protocol/rcon.js";
import { useCleanups } from "./helpers/cleanups.js";
import { FakeRconServer } from "./helpers/fake-rcon.js";

const cleanups = useCleanups();

describe("wire format", () => {
  it("request is 0xFFFFFFFF + 'rcon\\n<password> <command>'", () => {
    const request = encodeRconRequest("s3cret", "status");
    expect(request.subarray(0, 4).equals(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toBe(true);
    expect(request.subarray(4).toString("utf8")).toBe("rcon\ns3cret status");
  });

  it("parses print and error responses, with and without the OOB prefix", () => {
    const prefix = Buffer.from([0xff, 0xff, 0xff, 0xff]);
    expect(parseRconResponse(Buffer.concat([prefix, Buffer.from("print ok\n")]))).toEqual({
      kind: "print",
      text: "ok\n",
    });
    expect(parseRconResponse(Buffer.from("error Invalid connection."))).toEqual({
      kind: "error",
      text: "Invalid connection.",
    });
    expect(() => parseRconResponse(Buffer.from("garbage"))).toThrow(/unrecognized/);
  });
});

describe("sameHost (reply source check)", () => {
  it("accepts the literal we sent to, localhost aliases, and resolved hostnames", () => {
    expect(sameHost("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(sameHost("127.0.0.1", "localhost")).toBe(true);
    expect(sameHost("::1", "localhost")).toBe(true);
    expect(sameHost("10.0.0.7", "game.example.net")).toBe(true);
  });

  it("rejects a different IP literal", () => {
    expect(sameHost("10.0.0.99", "10.0.0.7")).toBe(false);
    expect(sameHost("192.168.0.2", "127.0.0.1")).toBe(false);
  });
});

describe("RconClient", () => {
  it("sends the exact request bytes and resolves the printed output", async () => {
    const server = new FakeRconServer("s3cret");
    const port = await server.listen();
    cleanups.push(() => server.close());

    const client = new RconClient({ host: "127.0.0.1", port, password: "s3cret" });
    await expect(client.exec("status")).resolves.toBe("ran: status");
    expect(server.receivedRequests[0]?.equals(encodeRconRequest("s3cret", "status"))).toBe(true);
  });

  it("serializes concurrent commands", async () => {
    const server = new FakeRconServer("pw", (command) => `out:${command}`);
    const port = await server.listen();
    cleanups.push(() => server.close());

    const client = new RconClient({ host: "127.0.0.1", port, password: "pw" });
    const results = await Promise.all([client.exec("one"), client.exec("two")]);
    expect(results).toEqual(["out:one", "out:two"]);
    expect(server.receivedRequests).toHaveLength(2);
  });

  it("reports wrong passwords as plain text (the server replies 'print Invalid password.')", async () => {
    const server = new FakeRconServer("right");
    const port = await server.listen();
    cleanups.push(() => server.close());

    const client = new RconClient({ host: "127.0.0.1", port, password: "wrong" });
    await expect(client.exec("status")).resolves.toMatch(/Invalid password/);
  });

  it("refuses to send without a configured password", async () => {
    const client = new RconClient({ host: "127.0.0.1", port: 1, password: "" });
    expect(client.isConfigured).toBe(false);
    await expect(client.exec("status")).rejects.toThrow(/password/);
  });

  it("times out against a silent server", async () => {
    const server = new FakeRconServer("pw");
    server.mode = "silent";
    const port = await server.listen();
    cleanups.push(() => server.close());

    const client = new RconClient({ host: "127.0.0.1", port, password: "pw", timeoutMs: 200 });
    await expect(client.exec("status")).rejects.toThrow(RconError);
  });
});

describe("RconClient socket reuse", () => {
  it("runs many commands over one UDP socket and releases it on close()", async () => {
    const server = new FakeRconServer("pw");
    const port = await server.listen();
    cleanups.push(() => server.close());
    const client = new RconClient({ host: "127.0.0.1", port, password: "pw" });
    for (let i = 0; i < 30; i++) {
      expect(await client.exec(`cmd ${i}`)).toBe(`ran: cmd ${i}`);
    }
    expect(server.receivedRequests).toHaveLength(30);
    expect(server.sourcePorts.size).toBe(1); // one client socket, however many commands
    client.close();
    await expect(client.exec("after")).rejects.toThrow(/closed/);
  });
});
