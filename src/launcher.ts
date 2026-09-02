import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Override with FIVEM_EXECUTABLE for non-default installs. */
export function fivemExecutable(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FIVEM_EXECUTABLE) return env.FIVEM_EXECUTABLE;
  const local = env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "FiveM", "FiveM.exe");
}

export function buildConnectArgument(host: string): string {
  return `fivem://connect/${host}`;
}

export interface LaunchResult {
  exe: string;
  pid: number;
}

export async function launchFiveM(connectTo?: string): Promise<LaunchResult> {
  const exe = fivemExecutable();
  if (!fs.existsSync(exe)) {
    throw new Error(`FiveM executable not found at ${exe} — set FIVEM_EXECUTABLE to point at it`);
  }
  const args = connectTo ? [buildConnectArgument(connectTo)] : [];
  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  child.unref();
  if (!child.pid) throw new Error(`failed to spawn ${exe}`);
  return { exe, pid: child.pid };
}

/** taskkill /T walks the tree: FiveM.exe is the root of the launcher,
 *  bootstrapper and game processes, so one kill closes the game. */
export function forceQuitFiveM(): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("taskkill", ["/F", "/T", "/IM", "FiveM.exe"], { stdio: "ignore" });
    proc.on("error", reject);
    proc.on("exit", (code) => resolve(code ?? 1));
  });
}

/** Newest CitizenFX log the game client writes under the FiveM install. */
export function latestClientLog(env: NodeJS.ProcessEnv = process.env): string | null {
  const local = env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const dir = path.join(local, "FiveM", "FiveM.app", "logs");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: { name: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || !/^CitizenFX_log_.*\.log$/.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const mtimeMs = fs.statSync(full).mtimeMs;
    if (!newest || mtimeMs > newest.mtimeMs) newest = { name: entry.name, mtimeMs };
  }
  return newest ? path.join(dir, newest.name) : null;
}
