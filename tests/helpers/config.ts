import type { Config } from "../../src/config.js";

/** A Config for tests: loopback everything, short timers; override what the test cares about. */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  const config: Config = {
    host: "127.0.0.1",
    clientDevconPorts: [1],
    rconHost: "127.0.0.1",
    rconPort: 1,
    logCapacity: 100,
    quietMs: 30,
    commandTimeoutMs: 1000,
  };
  // exactOptionalPropertyTypes: only set optional keys that were actually given.
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (config as unknown as Record<string, unknown>)[key] = value;
  }
  return config;
}
