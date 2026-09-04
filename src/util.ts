import { setTimeout as delay } from "node:timers/promises";

/** The message of anything thrown — Error or not. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The error to surface when a caller's AbortSignal fires. */
export function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error("request cancelled");
}

/** Sleep that wakes up early (rejecting with abortError) when `signal` fires. */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  try {
    await delay(ms, undefined, signal ? { signal } : {});
  } catch {
    throw abortError(signal);
  }
}
