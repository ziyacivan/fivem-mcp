// Every tunable that used to be a bare number in a call site. Tool descriptions
// interpolate these so the documented default can never drift from the code.

export const DEFAULTS = {
  /** `read_console` / `read_client_log` line cap. */
  readLimit: 100,
  /** `wait_for_console` when no timeoutMs is given. */
  waitForConsoleTimeoutMs: 10_000,
  /** How long `quit_game` waits for the devcon socket to close after `quit`. */
  quitGameCloseWaitMs: 15_000,
  /** `screenshot` longest side after downscale. */
  screenshotMaxSide: 900,

  /** Bridge client-op result wait, poll backoff and legacy log-tail slack. */
  bridgeTimeoutMs: 8_000,
  bridgePollInitialMs: 100,
  bridgePollMaxMs: 1_000,
  bridgePollBackoff: 1.5,
  bridgeLegacySlackMs: 1_500,
  /** Foreign poll results are kept this long / this many for another caller to pick up. */
  bridgeInboxTtlMs: 60_000,
  bridgeInboxMax: 128,

  /** Server log tailer. */
  logPollMs: 150,
  logTailBytes: 512 * 1024,

  /** UDP round-trip budgets. */
  rconTimeoutMs: 5_000,
  oobTimeoutMs: 3_000,

  /** Devcon liveness (see DevconConnection docs). */
  devconConnectTimeoutMs: 5_000,
  devconKeepaliveMs: 10_000,
  devconQuietBeforeProbeMs: 15_000,
  devconProbeGraceMs: 3_000,
  devconProbeTickMs: 5_000,

  /** Window capture: a frame is "black" below this lit fraction; a pixel is lit above this sum. */
  blackFrameThreshold: 0.02,
  litPixelMinSum: 24,
  minGameWindowWidth: 64,
} as const;
