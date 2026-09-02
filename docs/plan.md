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

## M2 — drive the game window (IMPLEMENTED, live-verified 2026-09-02)

Windows-only helpers via `koffi` (prebuilt FFI, no compile step):

* `launch` / `quit_game` — FiveM.exe found at `%LOCALAPPDATA%\FiveM\FiveM.exe`
  (`FIVEM_EXECUTABLE` overrides); connect link built as `fivem://connect/host:port`;
  graceful quit through the devcon `quit` command, `force` via `taskkill /T`
* `window_status` / `focus_window` / `restore_focus` — real window found:
  `FiveM® by Cfx.re - <hostname>` (title regex `^FiveM`)
* `screenshot` — PrintWindow(`PW_RENDERFULLCONTENT`) + screen-BitBlt fallback + PNG encode
  (node zlib, no native image dep), downscaled to 1280 max side
* `press_key` / `hold_key` / `release_key` (scan codes; held keys released on exit),
  `type_text` (KEYEVENTF_UNICODE), `mouse_move` / `click` / `scroll`
* `wait`, `read_client_log` (newest `CitizenFX_log_*.log`)

Live evidence (the actual session, 2026-09-02): screenshot at 98% brightness showing
the breeze character-selection screen; `press_key f8` opened the real F8 console whose
buffer streamed `[breeze-multichar] screen open`, `[breeze-chat] client ready`; devcon
`quit` closed the game cleanly.

Field-test checklist:

* [x] client devcon handshake on 29200 (Legacy) — AINF/CHAN arrive, F8 lines stream via PRNT
* [x] `CMND` echo + execution (`connect` answered `[glue] Ignoring ConnectTo…`;
      uncovered the trailing-byte rule — `"\n"`, not NUL; see protocol.md §3.3)
* [x] window focus + screenshot not black (PrintWindow path, 1616x939)
* [x] SendInput reaches GTA — F8 tap opened and closed the real console
* [x] graceful `quit` over devcon closes the game
* [ ] elevation trap: FiveM as admin + tool as normal user ⇒ SendInput silently dropped
      (UIPI) — the error text covers it, not yet observed in the wild

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
