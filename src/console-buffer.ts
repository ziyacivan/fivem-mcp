import { EventEmitter } from "node:events";
import { DEFAULTS } from "./defaults.js";
import type { DevconPrintLine } from "./protocol/devcon.js";
import { abortError } from "./util.js";

export interface ConsoleLine extends DevconPrintLine {
  seq: number;
  at: number;
}

export interface TailOptions {
  /** Only lines with seq greater than this. */
  afterSeq?: number | undefined;
  limit?: number | undefined;
  channel?: string | undefined;
  /** Case-insensitive substring filter. */
  contains?: string | undefined;
  /** JS regex source, matched against `channel: message`. */
  pattern?: string | undefined;
}

type LineFilter = (line: ConsoleLine) => boolean;

function buildFilter(options: TailOptions): LineFilter {
  const { channel, contains, pattern } = options;
  const needle = contains?.toLowerCase();
  const regex = pattern ? new RegExp(pattern) : undefined;
  return (line) =>
    (channel === undefined || line.channel === channel) &&
    (needle === undefined || line.message.toLowerCase().includes(needle)) &&
    (regex === undefined || regex.test(`${line.channel}: ${line.message}`));
}

/**
 * Ring buffer of console lines with a monotonic seq, so callers can ask for
 * "everything after what I saw last" without missing or duplicating lines.
 * Emits "line" on every push. push() is O(1) (fixed slots, no shifting) and
 * tail() walks backwards from the newest line, stopping at `limit` matches or
 * at `afterSeq` — the common "last 100 of 5000" read touches ~100 entries.
 */
export class ConsoleBuffer extends EventEmitter {
  private readonly slots: Array<ConsoleLine | undefined>;
  /** Index of the oldest line. */
  private head = 0;
  private count = 0;
  private nextSeq = 1;

  constructor(private readonly capacity: number) {
    super();
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`console buffer capacity must be a positive integer, got ${capacity}`);
    }
    this.slots = new Array<ConsoleLine | undefined>(capacity);
    this.setMaxListeners(50);
  }

  push(line: DevconPrintLine): ConsoleLine {
    const entry: ConsoleLine = { ...line, seq: this.nextSeq++, at: Date.now() };
    if (this.count === this.capacity) {
      this.slots[this.head] = entry; // overwrite the oldest
      this.head = (this.head + 1) % this.capacity;
    } else {
      this.slots[(this.head + this.count) % this.capacity] = entry;
      this.count++;
    }
    this.emit("line", entry);
    return entry;
  }

  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  get size(): number {
    return this.count;
  }

  /** The i-th line from the oldest (0) to the newest (size - 1). */
  private at(i: number): ConsoleLine {
    return this.slots[(this.head + i) % this.capacity] as ConsoleLine;
  }

  /** Index (oldest = 0) of the first retained line with seq > afterSeq, or `count` if none. */
  private indexAfter(afterSeq: number): number {
    if (this.count === 0) return 0;
    const oldestSeq = this.at(0).seq;
    return Math.max(0, Math.min(this.count, afterSeq + 1 - oldestSeq));
  }

  tail(options: TailOptions = {}): ConsoleLine[] {
    const { afterSeq = 0, limit = DEFAULTS.readLimit } = options;
    const matches = buildFilter(options);
    const stop = this.indexAfter(afterSeq); // lines before this index are too old
    const out: ConsoleLine[] = [];
    for (let i = this.count - 1; i >= stop && out.length < limit; i--) {
      const line = this.at(i);
      if (matches(line)) out.push(line);
    }
    return out.reverse();
  }

  /**
   * Resolve with the first line after `afterSeq` matching `pattern`, else reject
   * on timeout — or as soon as `signal` fires (the MCP request was cancelled).
   */
  waitFor(
    pattern: string,
    options: { afterSeq?: number | undefined; timeoutMs: number; signal?: AbortSignal | undefined },
  ): Promise<ConsoleLine> {
    const regex = new RegExp(pattern);
    const { afterSeq = 0, timeoutMs, signal } = options;
    if (signal?.aborted) return Promise.reject(abortError(signal));

    const test = (line: ConsoleLine) => regex.test(`${line.channel}: ${line.message}`);
    for (let i = this.indexAfter(afterSeq); i < this.count; i++) {
      const line = this.at(i);
      if (test(line)) return Promise.resolve(line);
    }

    return new Promise((resolve, reject) => {
      const onLine = (line: ConsoleLine) => {
        if (line.seq > afterSeq && test(line)) {
          settle();
          resolve(line);
        }
      };
      const onAbort = () => {
        settle();
        reject(abortError(signal));
      };
      const timer = setTimeout(() => {
        settle();
        reject(new Error(`no console line matched /${pattern}/ within ${timeoutMs}ms`));
      }, timeoutMs);
      const settle = () => {
        clearTimeout(timer);
        this.off("line", onLine);
        signal?.removeEventListener("abort", onAbort);
      };
      this.on("line", onLine);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Resolve once at least one line after `afterSeq` has arrived and the stream
   * then stays quiet for `quietMs`; resolve with whatever arrived even if the
   * overall `timeoutMs` elapsed with no output at all (or `signal` fired).
   */
  waitForQuiet(
    afterSeq: number,
    quietMs: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ConsoleLine[]> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      let quietTimer: NodeJS.Timeout | undefined;

      const finish = () => {
        if (quietTimer) clearTimeout(quietTimer);
        this.off("line", onLine);
        signal?.removeEventListener("abort", finish);
        resolve(this.tail({ afterSeq, limit: this.capacity }));
      };

      const armQuiet = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      };

      const onLine = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          finish();
          return;
        }
        armQuiet();
      };

      this.on("line", onLine);
      signal?.addEventListener("abort", finish, { once: true });
      // No output yet: give the process until the deadline, then return empty.
      quietTimer = setTimeout(finish, timeoutMs);
    });
  }
}
