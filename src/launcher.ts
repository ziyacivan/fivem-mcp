import { spawn } from "node:child_process";
import fs, { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

function localAppData(env: NodeJS.ProcessEnv): string {
  return env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
}

/** Override with FIVEM_EXECUTABLE for non-default installs. */
export function fivemExecutable(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FIVEM_EXECUTABLE) return env.FIVEM_EXECUTABLE;
  return path.join(localAppData(env), "FiveM", "FiveM.exe");
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

const CLIENT_LOG = /^CitizenFX_log_.*\.log$/;

/**
 * Newest CitizenFX log the game client writes under the FiveM install. The
 * file names embed their creation timestamp (`CitizenFX_log_2026-09-02T…`),
 * so the lexically greatest name is the newest — no stat() per file needed.
 */
export async function latestClientLog(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const dir = path.join(localAppData(env), "FiveM", "FiveM.app", "logs");
  let names: string[];
  try {
    names = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && CLIENT_LOG.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  names.sort();
  return path.join(dir, names[names.length - 1] ?? "");
}
