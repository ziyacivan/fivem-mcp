# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.0] - 2026-09-04

A correctness, performance and packaging pass over the whole server. No tool
names, argument schemas or bridge wire formats changed; two bridge behaviours
did (see **Security** and `players`).

### Security
- `mcpb` bridge command is restricted to the console/RCON (source 0); players who type it are refused.
- Console commands sent over RCON/devcon must be single-line (no CR/LF smuggling).
- UDP replies (RCON, getinfo) are accepted only from the host:port they were sent to.
- Bridge token compared in constant time; `call_native` limited to PascalCase own globals with an optional `mcpb_native_allowlist`; `call_export` gains `mcpb_export_allowlist`.

### Fixed
- Devcon: a malformed frame after the handshake no longer crashes the process; a port that accepts but never answers no longer hangs `connect`.
- Hub: concurrent tool calls share one devcon dial (no duplicated console lines or leaked sockets).
- Server log tailer: partial lines are no longer re-read, UTF-8 is decoded safely across chunks, reads honour `bytesRead`.
- Keys: `rshift` used the wrong virtual key; `esc`, `ctrl`, `alt` aliases documented in the tool now exist.
- Config: IPv6 addresses (`[::1]:30120`, `::1`) parse correctly.
- Screenshot: GDI objects are released when a capture fails part-way.
- Shutdown closes the MCP transport before exiting and handles stdin end / unhandled rejections.

### Added
- MCP: request cancellation honoured by every waiting tool; `outputSchema` + `structuredContent` for JSON-shaped tools; `ToolAnnotations` on all tools; logging capability (tool failures as warnings; `FIVEM_MCP_DEBUG=1` traces devcon/RCON).
- Bridge: pending client ops expire (`mcpb_client_timeout_ms`), results fit one datagram (truncation marker, `poll` `max`), `players` identifiers opt-in, `nui_callback` timeout, `mcpb_verbose`.
- Tests for config, server log tailer, hub dialing, cancellation, bridge hardening, docs drift (README tool table, `server.json` env list, bridge op lists, version sync).
- CI on Windows + Linux, Node 22 + 24, coverage; tag-triggered release workflow (npm provenance, GitHub Release, MCP Registry); Dependabot.

### Changed
- Toolchain: zod 4, Biome 2, Vitest 5, TypeScript 7; SDK `^1.30`.
- `server.ts` split into `src/tools/*` and `src/prompts.ts`; handler argument types derive from the zod shapes; all tunables in `src/defaults.ts`.
- Screenshot pipeline crops, box-downscales and converts in one pass; PNG compression runs off the event loop; `press_key` no longer spins the event loop during the hold.
- Console buffer is a fixed-slot ring (O(1) push, reverse tail); the server log tail parses newest-first; one RCON socket per client; devcon frame decoder joins chunks once per frame; devcon ports dialled in parallel.
- Version is read from `package.json`; `pnpm version` syncs `server.json` and `bridge/fxmanifest.lua`.
- Live scripts share `scripts/lib.mjs`, write to a temp folder, and run via `pnpm live:*`.
- `.gitattributes` pins the working tree to LF, so `pnpm check` behaves the same on Windows checkouts (where `core.autocrlf` would otherwise rewrite every file) as it does on Linux.

## [0.5.0] - 2026-09-02

### Added
- In-band bridge result queue (`poll` op) — no `FIVEM_SERVER_LOG` needed for client ops.
- Devcon keepalive + hello-probe heartbeat; dead sockets are redialled.
- Screenshot `crop`, default `maxSide` 900, cost guidance in the tool description.

## [0.4.0] - 2026-09-02

### Added
- MCP prompts `test_resource` and `smoke_check`; registry `server.json`; npm publish metadata.

## [0.3.0] - 2026-09-02

### Added
- `bridge` tool and the `mcpb` resource (server exports/events, client natives, NUI).
- Window automation: launch/quit, focus, screenshot, keyboard and mouse via SendInput.

## [0.1.0] - 2026-09-02

### Added
- DevCon client console, UDP RCON, `getinfo`, server log tailer, MCP stdio server with the first seven tools.
