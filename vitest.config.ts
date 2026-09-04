import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Real sockets and a real (fake) devcon/rcon pair per file: forks keep the
    // koffi native module and dgram handles isolated per worker.
    pool: "forks",
    testTimeout: 15_000,
    hookTimeout: 20_000,
    sequence: { shuffle: { files: true, tests: false } },
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: { junit: "coverage/junit.xml" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Windows-only FFI and the process entry point cannot run under vitest.
      exclude: ["src/win/win32.ts", "src/index.ts"],
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "coverage",
      thresholds: { lines: 80, functions: 80 },
    },
  },
});
