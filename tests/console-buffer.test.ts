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
