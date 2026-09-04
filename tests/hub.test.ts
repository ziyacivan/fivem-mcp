import { describe, expect, it } from "vitest";
import { Hub } from "../src/hub.js";
import { useCleanups } from "./helpers/cleanups.js";
import { makeConfig } from "./helpers/config.js";
import { FakeDevconServer } from "./helpers/fake-devcon.js";

const cleanups = useCleanups();

const config = (ports: number[]) => makeConfig({ clientDevconPorts: ports });

describe("Hub.ensureClient", () => {
  it("concurrent callers share one dial: one socket, every line buffered once", async () => {
    const fake = new FakeDevconServer({ channels: ["Any", "chan"] });
    const port = await fake.listen();
    cleanups.push(() => fake.close());
    const hub = new Hub(config([port]));
    cleanups.push(async () => hub.closeAll());

    const [a, b, c] = await Promise.all([
      hub.ensureClient(),
      hub.ensureClient(),
      hub.ensureClient(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);

    fake.print("chan", "hello once");
    await new Promise((r) => setTimeout(r, 100));
    expect(hub.clientBuffer.tail({ contains: "hello once" })).toHaveLength(1);
  });

  it("a malformed frame after the handshake is reported, not thrown out of the process", async () => {
    const fake = new FakeDevconServer();
    const port = await fake.listen();
    cleanups.push(() => fake.close());
    const hub = new Hub(config([port]));
    cleanups.push(async () => hub.closeAll());

    const connection = await hub.ensureClient();
    const closed = new Promise<void>((resolve) => connection.once("close", () => resolve()));
    fake.sendRaw(Buffer.from("JUNKjunkjunkjunk"));
    await closed;

    const status = await hub.status();
    expect(status.client).toMatchObject({ connected: false });
    expect((status.client as { lastError: string }).lastError).toMatch(/devcon protocol error/);
  });
});
