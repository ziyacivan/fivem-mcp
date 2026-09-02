// FXServer writes its console to stdout; the standard local workflow redirects
// that to a file (e.g. `FXServer.exe +exec server.cfg > server.log 2>&1`). When
// FIVEM_SERVER_LOG points at that file, read_console/wait_for_console can serve
// the server side without devcon — which current FXServer builds do not expose
// (verified 2026-09-02: FXServer listens only on its game port; devcon 29100
// never binds despite the component source in citizenfx/fivem@03dcc562).

import { promises as fs } from "node:fs";
import type { ConsoleLine } from "../console-buffer.js";

// VT100/ANSI CSI (incl. private-mode params like ESC[?202h seen in FXServer's
// redirected stdout) and OSC strings.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escape sequences is the point
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

/** Turns `[ channel] text` (ANSI-decorated, possibly prompt-prefixed) into a line. */
export function parseServerLogLine(raw: string): { channel: string; message: string } {
  const clean = raw.replace(ANSI, "").replace(/^cfx> /, "");
  const match = /^\[\s*([^\]]*?)\s*\]\s?(.*)$/.exec(clean);
  if (match) return { channel: match[1] ?? "", message: match[2] ?? "" };
  return { channel: "", message: clean };
}

export interface ServerLogFilter {
  limit?: number | undefined;
  channel?: string | undefined;
  contains?: string | undefined;
  pattern?: string | undefined;
}

const TAIL_BYTES = 512 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tail-based reader over the server's redirected stdout file. */
export class ServerLogFile {
  constructor(readonly path: string) {}

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.path);
      return true;
    } catch {
      return false;
    }
  }

  async tail(options: ServerLogFilter = {}): Promise<ConsoleLine[]> {
    const { limit = 100, channel, contains, pattern } = options;
    let handle: fs.FileHandle | null = null;
    let text = "";
    try {
      handle = await fs.open(this.path, "r");
      const { size } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } finally {
      await handle?.close();
    }

    const needle = contains?.toLowerCase();
    const regex = pattern ? new RegExp(pattern) : undefined;
    let lines = text
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => ({ ...parseServerLogLine(line), seq: 0, at: 0 }));

    if (channel !== undefined) lines = lines.filter((line) => line.channel === channel);
    if (needle !== undefined) {
      lines = lines.filter((line) => line.message.toLowerCase().includes(needle));
    }
    if (regex !== undefined) {
      lines = lines.filter((line) => regex.test(`${line.channel}: ${line.message}`));
    }
    return lines.slice(-limit);
  }

  /** Polls the file for new content and resolves on the first line matching `pattern`. */
  async waitFor(
    pattern: string,
    options: { timeoutMs: number; pollMs?: number },
  ): Promise<ConsoleLine> {
    const regex = new RegExp(pattern);
    const pollMs = options.pollMs ?? 150;
    const deadline = Date.now() + options.timeoutMs;
    let cursor = (await fs.stat(this.path).catch(() => null))?.size ?? 0;
    let partial = "";

    for (;;) {
      let size = 0;
      try {
        size = (await fs.stat(this.path)).size;
      } catch {
        size = 0;
      }
      if (size < cursor) {
        cursor = 0; // truncated/restarted
        partial = "";
      }
      if (size > cursor) {
        const handle = await fs.open(this.path, "r");
        try {
          const buffer = Buffer.alloc(size - cursor);
          await handle.read(buffer, 0, buffer.length, cursor);
          const combined = partial + buffer.toString("utf8");
          const lastNewline = combined.lastIndexOf("\n");
          if (lastNewline === -1) {
            partial = combined; // no complete line yet
          } else {
            const complete = combined.slice(0, lastNewline + 1);
            partial = combined.slice(lastNewline + 1);
            // Only bytes from this chunk that belong to complete lines advance the cursor.
            cursor += buffer.length - Buffer.byteLength(partial, "utf8");
            for (const line of complete.split(/\r?\n/)) {
              if (line.length === 0) continue;
              const entry = { ...parseServerLogLine(line), seq: 0, at: Date.now() };
              if (regex.test(`${entry.channel}: ${entry.message}`)) return entry;
            }
          }
        } finally {
          await handle.close();
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`no server log line matched /${pattern}/ within ${options.timeoutMs}ms`);
      }
      await sleep(pollMs);
    }
  }
}
