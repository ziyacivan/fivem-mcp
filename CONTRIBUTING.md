# Contributing

Thanks for helping make FiveM development testable by agents.

## Setup

```sh
pnpm install
pnpm run ci        # biome + tsc + vitest + build — the same gate CI runs
```

Node 22+, pnpm 9. The suite runs on Windows, macOS and Linux; the Windows-only
window/input code is exercised for real only on Windows (CI has a `windows-latest` leg).

## Layout

| Path | What lives there |
| --- | --- |
| `src/protocol/` | Wire protocols: devcon frames, RCON/getinfo UDP, Cfx hashes, server log tailer |
| `src/hub.ts` | Live state: one devcon connection, one RCON socket, the bridge poll loop |
| `src/tools/` | MCP tools grouped by concern; `_shared.ts` has `defineTool`, result helpers, annotation presets |
| `src/prompts.ts` | MCP prompts |
| `src/win/` | Windows automation (koffi FFI) and the PNG/downscale pipeline |
| `src/defaults.ts` | Every tunable number, named |
| `bridge/` | The `mcpb` FiveM resource (plain JS, no build step) |
| `tests/` | Vitest; `helpers/` has fake devcon/RCON servers and `makeConfig` |
| `scripts/` | Live verification against a real server/game (`pnpm live:*`) |

## Rules of the road

- **Tool names, argument schemas and the bridge wire format are public API.** Extend, do not rename.
- Every tool goes through `defineTool` (typed args, `guarded` errors, annotations). JSON-shaped
  results use `structured()` with an `outputSchema`.
- New tunables go in `src/defaults.ts`; tool descriptions interpolate them.
- Add a test with every fix. `tests/docs-drift.test.ts` fails when the README tool table,
  `server.json` env list, bridge op lists or versions drift — update the docs in the same PR.
- Bridge changes: keep `bridge/*.js` runnable as-is on FXServer (no imports, no build), and
  pin behaviour in `tests/bridge-*.test.ts`.
- Diagnostics go to stderr (`src/log.ts`); stdout belongs to the MCP transport.

## Releasing

```sh
pnpm version minor        # bumps package.json and syncs server.json + bridge/fxmanifest.lua
git push --follow-tags
```

The `Release` workflow runs the gate, publishes to npm with provenance, creates the GitHub
Release from the matching `CHANGELOG.md` section, and publishes to the MCP Registry.
Move the `Unreleased` notes under the new version heading before tagging.

## Live verification

The unit suite uses fakes. Before a release that touches devcon, RCON, the window tools or
the bridge, run the relevant live script against a dev server with the game installed:

```sh
pnpm live:probe   # connectivity snapshot
pnpm live:e2e     # devcon + rcon + log tail
pnpm live:m2      # launch, screenshot, key injection, quit
pnpm live:m3      # bridge round trip: players, position, teleport
```

Screenshots land in `%TEMP%/fivem-mcp-live` (override with `FIVEM_LIVE_OUT`).
