import { describe, expect, it } from "vitest";
import { ConsoleBuffer } from "../src/console-buffer.js";

function feed(buffer: ConsoleBuffer, lines: Array<[string, string]>): void {
  for (const [channel, message] of lines) buffer.push({ channel, message });
}

describe("ConsoleBuffer", () => {
  it("assigns monotonic seq numbers and trims to capacity", () => {
    const buffer = new ConsoleBuffer(3);
    feed(buffer, [
      ["a", "1"],
      ["a", "2"],
      ["a", "3"],
      ["a", "4"],
    ]);
    expect(buffer.latestSeq).toBe(4);
    expect(buffer.size).toBe(3);
    expect(buffer.tail().map((line) => line.message)).toEqual(["2", "3", "4"]);
  });

  it("filters by channel, substring and regex, and pages with afterSeq", () => {
    const buffer = new ConsoleBuffer(100);
    feed(buffer, [
      ["server", "Started resource breeze-chat"],
      ["breeze-chat", "Player 1 joined"],
      ["server", "Error: no such resource nope"],
    ]);

    expect(buffer.tail({ channel: "server" })).toHaveLength(2);
    // `contains` searches the message text; channel names live in `channel`/`pattern`.
    expect(buffer.tail({ contains: "breeze" })).toHaveLength(1);
    expect(buffer.tail({ contains: "player" })).toHaveLength(1);
    expect(buffer.tail({ pattern: "^server: Error" })).toHaveLength(1);
    expect(buffer.tail({ afterSeq: 2 }).map((line) => line.seq)).toEqual([3]);

    const page = buffer.tail({ limit: 1 });
    expect(page[0]?.seq).toBe(3);
  });

  it("waitFor resolves from history, from live pushes, and times out", async () => {
    const buffer = new ConsoleBuffer(100);
    feed(buffer, [["server", "Started resource breeze-chat"]]);

    await expect(buffer.waitFor("Started resource", { timeoutMs: 500 })).resolves.toMatchObject({
      message: "Started resource breeze-chat",
    });

    setTimeout(() => buffer.push({ channel: "we", message: "character screen ready" }), 30);
    await expect(buffer.waitFor("ready", { timeoutMs: 2000 })).resolves.toMatchObject({
      channel: "we",
    });

    await expect(buffer.waitFor("never-appears", { timeoutMs: 100 })).rejects.toThrow(/matched/);
  });

  it("waitForQuiet returns the burst, and empty at the deadline if nothing arrives", async () => {
    const buffer = new ConsoleBuffer(100);
    feed(buffer, [["server", "old"]]);
    const after = buffer.latestSeq;

    setTimeout(() => {
      feed(buffer, [
        ["rcon", "status"],
        ["rcon", "players: 1"],
      ]);
    }, 20);

    const lines = await buffer.waitForQuiet(after, 50, 2000);
    expect(lines.map((line) => line.message)).toEqual(["status", "players: 1"]);

    const empty = await buffer.waitForQuiet(buffer.latestSeq, 20, 60);
    expect(empty).toEqual([]);
  });
});

describe("ConsoleBuffer cancellation", () => {
  it("waitFor rejects promptly when the signal aborts and leaves no listener behind", async () => {
    const buffer = new ConsoleBuffer(10);
    const controller = new AbortController();
    const pending = buffer.waitFor("never", { timeoutMs: 60_000, signal: controller.signal });
    expect(buffer.listenerCount("line")).toBe(1);
    controller.abort(new Error("client cancelled"));
    await expect(pending).rejects.toThrow(/client cancelled/);
    expect(buffer.listenerCount("line")).toBe(0);
  });

  it("waitFor on an already-aborted signal rejects without subscribing", async () => {
    const buffer = new ConsoleBuffer(10);
    await expect(
      buffer.waitFor("x", { timeoutMs: 1000, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(buffer.listenerCount("line")).toBe(0);
  });

  it("waitForQuiet resolves with what it has when the signal aborts", async () => {
    const buffer = new ConsoleBuffer(10);
    const controller = new AbortController();
    const pending = buffer.waitForQuiet(0, 5_000, 60_000, controller.signal);
    buffer.push({ channel: "c", message: "partial" });
    controller.abort();
    expect((await pending).map((l) => l.message)).toEqual(["partial"]);
    expect(buffer.listenerCount("line")).toBe(0);
  });
});

describe("ConsoleBuffer ring semantics", () => {
  it("wraps without shifting: order, size and afterSeq stay right past capacity", () => {
    const buffer = new ConsoleBuffer(4);
    for (let i = 1; i <= 10; i++) buffer.push({ channel: "c", message: `m${i}` });
    expect(buffer.size).toBe(4);
    expect(buffer.latestSeq).toBe(10);
    expect(buffer.tail().map((l) => l.message)).toEqual(["m7", "m8", "m9", "m10"]);
    expect(buffer.tail({ afterSeq: 8 }).map((l) => l.seq)).toEqual([9, 10]);
    expect(buffer.tail({ afterSeq: 2 }).map((l) => l.seq)).toEqual([7, 8, 9, 10]); // evicted lines are gone
    expect(buffer.tail({ afterSeq: 10 })).toEqual([]);
    expect(buffer.tail({ limit: 2, contains: "m" }).map((l) => l.message)).toEqual(["m9", "m10"]);
  });

  it("waitFor searches only lines newer than afterSeq in history", async () => {
    const buffer = new ConsoleBuffer(3);
    for (let i = 1; i <= 5; i++) buffer.push({ channel: "c", message: `hit ${i}` });
    await expect(buffer.waitFor("hit", { afterSeq: 4, timeoutMs: 50 })).resolves.toMatchObject({
      seq: 5,
    });
    await expect(buffer.waitFor("hit", { afterSeq: 5, timeoutMs: 30 })).rejects.toThrow(/matched/);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new ConsoleBuffer(0)).toThrow(/capacity/);
  });
});
