import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildConnectArgument, fivemExecutable, latestClientLog } from "../src/launcher.js";

describe("launcher", () => {
  it("builds the fivem://connect URL", () => {
    expect(buildConnectArgument("localhost:30120")).toBe("fivem://connect/localhost:30120");
  });

  it("honors FIVEM_EXECUTABLE and falls back to %LOCALAPPDATA%", () => {
    expect(fivemExecutable({ FIVEM_EXECUTABLE: "D:\\games\\FiveM.exe" })).toBe(
      "D:\\games\\FiveM.exe",
    );
    const fallback = fivemExecutable({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" });
    expect(fallback).toBe(path.join("C:\\Users\\x\\AppData\\Local", "FiveM", "FiveM.exe"));
    expect(fivemExecutable({})).toContain(path.join("FiveM", "FiveM.exe"));
  });
});

describe("latestClientLog", () => {
  it("picks the newest CitizenFX log and tolerates a missing dir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fivem-log-test-"));
    const logs = path.join(root, "FiveM", "FiveM.app", "logs");
    await fs.mkdir(logs, { recursive: true });
    await fs.writeFile(path.join(logs, "CitizenFX_log_2026-01-01T000000.log"), "old");
    await fs.writeFile(path.join(logs, "CitizenFX_log_2026-01-02T000000.log"), "new");
    await fs.writeFile(path.join(logs, "launcher.log"), "not a citizen log");
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() - 500);
    await fs.utimes(path.join(logs, "CitizenFX_log_2026-01-01T000000.log"), past, past);
    await fs.utimes(path.join(logs, "CitizenFX_log_2026-01-02T000000.log"), future, future);

    expect(latestClientLog({ LOCALAPPDATA: root })).toBe(
      path.join(logs, "CitizenFX_log_2026-01-02T000000.log"),
    );
    expect(latestClientLog({ LOCALAPPDATA: path.join(root, "missing") })).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });
});
