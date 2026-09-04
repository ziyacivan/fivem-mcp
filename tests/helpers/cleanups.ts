import { afterEach } from "vitest";

/**
 * Per-test teardown stack: push closers as you open sockets/servers; they run
 * in reverse order after each test. Import once per test file.
 */
export function useCleanups(): Array<() => Promise<void> | void> {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });
  return cleanups;
}
