export { setTimeout as sleep } from "node:timers/promises";

/** The message of anything thrown — Error or not. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
