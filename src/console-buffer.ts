import { EventEmitter } from "node:events";
import { DEFAULTS } from "./defaults.js";
import type { DevconPrintLine } from "./protocol/devcon.js";

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

/**
 * Ring buffer of console lines with a monotonic seq, so callers can ask for
 * "everything after what I saw last" without missing or duplicating lines.
 * Emits "line" on every push.
 */
export class ConsoleBuffer extends EventEmitter {
  private readonly linesInternal: ConsoleLine[] = [];
  private nextSeq = 1;

  constructor(private readonly capacity: number) {
    super();
    this.setMaxListeners(50);
  }

  push(line: DevconPrintLine): ConsoleLine {
    const entry: ConsoleLine = { ...line, seq: this.nextSeq++, at: Date.now() };
    this.linesInternal.push(entry);
    if (this.linesInternal.length > this.capacity) {
      this.linesInternal.splice(0, this.linesInternal.length - this.capacity);
    }
    this.emit("line", entry);
    return entry;
  }

  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  get size(): number {
    return this.linesInternal.length;
  }

  tail(options: TailOptions = {}): ConsoleLine[] {
    const { afterSeq = 0, limit = DEFAULTS.readLimit, channel, contains, pattern } = options;
    const needle = contains?.toLowerCase();
    const regex = pattern ? new RegExp(pattern) : undefined;

    let matched = this.linesInternal.filter(
      (line) =>
        line.seq > afterSeq &&
        (channel === undefined || line.channel === channel) &&
        (needle === undefined || line.message.toLowerCase().includes(needle)) &&
        (regex === undefined || regex.test(`${line.channel}: ${line.message}`)),
    );
    if (matched.length > limit) matched = matched.slice(matched.length - limit);
    return matched;
  }

  /** Resolve with the first line after `afterSeq` matching `pattern`, else reject on timeout. */
  waitFor(
    pattern: string,
    options: { afterSeq?: number | undefined; timeoutMs: number },
  ): Promise<ConsoleLine> {
    const regex = new RegExp(pattern);
    const { afterSeq = 0, timeoutMs } = options;

    const found = this.linesInternal.find(
      (line) => line.seq > afterSeq && regex.test(`${line.channel}: ${line.message}`),
    );
    if (found) return Promise.resolve(found);

    return new Promise((resolve, reject) => {
      const onLine = (line: ConsoleLine) => {
        if (line.seq > afterSeq && regex.test(`${line.channel}: ${line.message}`)) {
          settle();
          resolve(line);
        }
      };
      const timer = setTimeout(() => {
        settle();
        reject(new Error(`no console line matched /${pattern}/ within ${timeoutMs}ms`));
      }, timeoutMs);
      const settle = () => {
        clearTimeout(timer);
        this.off("line", onLine);
      };
      this.on("line", onLine);
    });
  }

  /**
   * Resolve once at least one line after `afterSeq` has arrived and the stream
   * then stays quiet for `quietMs`; resolve with whatever arrived even if the
   * overall `timeoutMs` elapsed with no output at all.
   */
  waitForQuiet(afterSeq: number, quietMs: number, timeoutMs: number): Promise<ConsoleLine[]> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      let quietTimer: NodeJS.Timeout | undefined;

      const finish = () => {
        if (quietTimer) clearTimeout(quietTimer);
        this.off("line", onLine);
        resolve(this.linesInternal.filter((line) => line.seq > afterSeq));
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
      // No output yet: give the process until the deadline, then return empty.
      quietTimer = setTimeout(finish, timeoutMs);
    });
  }
}
