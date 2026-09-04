import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseServerLogLine, ServerLogFile } from "../src/protocol/server-log.js";

describe("parseServerLogLine", () => {
  it("splits the channel tag and strips ANSI + the cfx prompt", () => {
    expect(parseServerLogLine("[           resources] Started resource x")).toEqual({
      channel: "resources",
      message: "Started resource x",
    });
    expect(parseServerLogLine("cfx> [?202h[ script:breeze] [32mok[0m")).toEqual({
      channel: "script:breeze",
      message: "ok",
    });
    expect(parseServerLogLine("]0;titleplain text")).toEqual({
      channel: "",
      message: "plain text",
    });
  });
});

describe("ServerLogFile", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "fivem-serverlog-"));
    file = path.join(dir, "server.log");
    await fs.writeFile(file, "", "utf8");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("tail filters and keeps the last `limit` lines", async () => {
    await fs.writeFile(
      file,
      `${["[ a] one", "[ b] two", "[ a] three", "[ a] Error: four"].join("\n")}\n`,
      "utf8",
    );
    const log = new ServerLogFile(file);
    expect((await log.tail({ channel: "a" })).map((l) => l.message)).toEqual([
      "one",
      "three",
      "Error: four",
    ]);
    expect((await log.tail({ contains: "ERROR" })).map((l) => l.message)).toEqual(["Error: four"]);
    expect((await log.tail({ pattern: "^b: " })).map((l) => l.message)).toEqual(["two"]);
    expect((await log.tail({ limit: 2 })).map((l) => l.message)).toEqual(["three", "Error: four"]);
  });

  it("waitFor sees a line completed across two appends without re-reading the first part", async () => {
    const log = new ServerLogFile(file);
    const pending = log.waitFor("READY", { timeoutMs: 3000, pollMs: 20 });
    // First append has no newline: the tailer must hold it as a partial line...
    await fs.appendFile(file, "[ boot] almost RE", "utf8");
    await new Promise((r) => setTimeout(r, 80));
    // ...and glue only the *new* bytes onto it (the bug was re-reading the old ones).
    await fs.appendFile(file, "ADY now\n", "utf8");
    const hit = await pending;
    expect(hit.channel).toBe("boot");
    expect(hit.message).toBe("almost READY now");
  });

  it("waitFor does not duplicate an unfinished line while it stays unfinished", async () => {
    const log = new ServerLogFile(file);
    const pending = log.waitFor("xx.*xx", { timeoutMs: 600, pollMs: 20 });
    await fs.appendFile(file, "[ t] xx", "utf8"); // never completed with a newline
    // A duplicated partial ("xxxx") would falsely satisfy /xx.*xx/.
    await expect(pending).rejects.toThrow(/no server log line matched/);
  });

  it("waitFor keeps multi-byte UTF-8 intact across chunk boundaries", async () => {
    const log = new ServerLogFile(file);
    const bytes = Buffer.from("[ u] café ok\n", "utf8");
    const split = bytes.indexOf(0xc3) + 1; // cut inside the 2-byte "é"
    const pending = log.waitFor("caf. ok", { timeoutMs: 3000, pollMs: 20 });
    await fs.appendFile(file, bytes.subarray(0, split));
    await new Promise((r) => setTimeout(r, 80));
    await fs.appendFile(file, bytes.subarray(split));
    expect((await pending).message).toBe("café ok");
  });

  it("waitFor restarts from zero after truncation", async () => {
    await fs.writeFile(file, "[ a] old\n".repeat(20), "utf8");
    const log = new ServerLogFile(file);
    const pending = log.waitFor("fresh", { timeoutMs: 3000, pollMs: 20 });
    await new Promise((r) => setTimeout(r, 50));
    await fs.writeFile(file, "[ a] fresh\n", "utf8"); // smaller than the cursor
    expect((await pending).message).toBe("fresh");
  });

  it("waitFor times out with the pattern in the message", async () => {
    const log = new ServerLogFile(file);
    await expect(log.waitFor("never", { timeoutMs: 100, pollMs: 20 })).rejects.toThrow(
      /never.*100ms/,
    );
  });
});
