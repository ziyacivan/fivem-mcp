# Roadmap

## M1 — server-side + client console (DONE, v0.1)

* DevCon TCP client (PPCR/AINF/CHAN/CVAR/PRNT/CMND) — `src/protocol/devcon.ts`
* UDP RCON client (request/response OOB format, serialized, rate-limit aware) — `src/protocol/rcon.ts`
* `getinfo` OOB (`server_info`, no credentials) — `src/protocol/oob.ts`
* Server log tailer for `read_console`/`wait_for_console` on the server — `src/protocol/server-log.ts`
* MCP stdio server, 7 tools, env config — `src/server.ts`, `src/index.ts`
* 52 tests incl. fake devcon + fake rcon/getinfo servers; hash vectors cross-checked
  against a C# reproduction of the C++ source
* Live-verified against a running FXServer (2026-09-02, build 179740983):
  the rcon reply format, the getinfo response incl. the `challenge > 8 bytes` drop rule,
  and the **absence** of the server-side devcon 29100 socket

## M2 — drive the game window (the actual "in-game" half)

Windows-only helpers, FFI via `koffi` (no native build step):

* `launch` / `quit` — start FiveM (`%LOCALAPPDATA%\FiveM\FiveM.exe`), `fivem://connect/host:port`
* window status / focus / restore (GTA reads DirectInput — the window must be foreground for input)
* `press_key` / `hold_key` / `release_key` — **scan codes**, not VK codes (DirectInput/raw input
  ignores VK-only injection)
* `type_text` — Unicode events (the F8 console and chat NUI read those fine)
* `mouse_move` (relative = camera, absolute = cursor for NUI) / `click` / `scroll`
* `screenshot` — PNG of the game window (PrintWindow; fall back to BitBlt of the screen while
  focused; a black capture means the swapchain ignored PrintWindow — documented failure mode)
* `read_client_log` — tail of `CitizenFX_log_*.log` from the FiveM install

Field-test checklist:

* [x] client devcon handshake on 29200 (Legacy) — AINF/CHAN arrive (23 channels incl.
      `glue`, `gta-core-five`, `legitimacy`…), the game process owns the socket,
      the F8 console streams via PRNT — verified live 2026-09-02
* [x] `CMND` execution: `connect <host>` ran in-game and answered
      `[glue] Ignoring ConnectTo because we're already connecting/connected.`
      — which also uncovered the trailing-byte rule (`"\n"`, not NUL; see protocol.md §3.3)
* [x] **new finding:** devcon reaches the *console* command context only. RegisterCommand
      chat commands are a separate system — driving them needs the M2 input tools (chat UI)
      or the M3 bridge; `server_command`/RCON already runs them with `system.console` privileges
* [ ] SendInput reaches GTA (movement, camera) while focused; `release_key all` on exit
* [ ] screenshot returns the game, not the desktop
* [ ] elevation trap: FiveM as admin + tool as normal user ⇒ SendInput silently dropped (UIPI)

## M3 — optional bridge resource (`fivem-mcp-bridge`, our own, MIT)

A small TypeScript resource that unlocks things neither devcon nor rcon can reach:

* invoke any native by name, `TriggerEvent` both directions, call any resource's exports
* `mcp_position` / head-text style readback, scripted `RESULT:<name>=pass|fail` lines that
  feed `wait_for_console` — the assertion primitive for real in-game tests
* gated: `setr mcp_bridge_enabled` + one-shot token, server-side allowlist of event names;
  refuses to do anything when the convar is off

## M4 — polish

* NUI inspection via CDP (`chrome-devtools` over the CEF debug port) if/when measurable
* txAdmin live-console fallback when `FIVEM_SERVER_LOG` is not available
* MCP prompts: "test a breeze slice end-to-end", "verify a resource starts clean"
* npm publish (`fivem-mcp-server`) + version tags

## Non-goals

* Vision-driven gameplay bots (screenshots for LLMs are supported; a "play the game" loop is not the product)
* Anything that reaches servers you do not administer — every credential check upstream still applies
* CI-runnable E2E: the client needs GTA V; the CI gate stays at unit/integration level
