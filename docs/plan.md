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

## M3 — bridge resource (IMPLEMENTED as `bridge/`, protocol in docs/protocol.md §4)

Plain-JS resource, no build step, shipped in this repo (`ensure mcpb`):

* server ops answered synchronously inside the RCON capture: `ping`, `players`,
  `call_export` (any resource export), `trigger_event` (allowlist-gated)
* client ops round-trip to the game process and answer as `MCP_RESULT` lines on the
  server console: `position`, `teleport`, `freeze`, `call_native` (invoke any client
  native by name), `send_nui`, `nui_callback` (drive a screen's own callbacks)
* gates: `mcpb_enabled` (default false), `mcpb_token`, single-use dispatch ids so a
  hijacked client cannot forge results for another call; every failure answers
  `{ok:false, error}` instead of corrupting the line
* MCP tool: `bridge` — see README; 29 tests pin the contract on both halves

Live-verified 2026-09-02 against the running game (`scripts/live-m3.mjs`, all PASS):
`players` saw the real join (`1:inkedev`); `position` read the character-screen preview
ped at the coordinates multichar's own log printed; `teleport` moved it exactly +10 on x
and the read-back confirmed it through the full RCON→dispatch→client-native→MCP_RESULT
round trip; the client log carried the bridge activity; `quit` closed the game.
Two real-world bugs the fakes could not catch, now fixed and pinned: FXServer's JS
runtime has **no `GetPlayerIdentifiers` global** (guarded, returns null), and the
bootstrapper window is also titled `FiveM` (game-window detection now requires the
`by Cfx.re` title pattern; `/^FiveM/i` alone matched a browser tab open on this repo).

## M4 — polish & distribution

* [x] npm metadata: repository/keywords/homepage/bugs, `mcpName`
      (`io.github.ziyacivan/fivem-mcp`) and `prepublishOnly` gate
* [x] `server.json` for the MCP Registry (schema 2025-12-11, stdio, env-var docs)
* [x] MCP prompts: `test_resource` (the live-verified end-to-end playbook) and
      `smoke_check` (one-pass health sweep)
* [x] git tags v0.3.0 / v0.4.0, repository made public
* [ ] `npm publish` (needs `npm login` — the package name fivem-mcp-server is free)
* [ ] `mcp-publisher login github && mcp-publisher publish` (after the npm publish)
* [ ] txAdmin live-console fallback when `FIVEM_SERVER_LOG` is not available
* [ ] NUI inspection via CDP if/when the CEF debug port proves measurable

## Non-goals

* Vision-driven gameplay bots (screenshots for LLMs are supported; a "play the game" loop is not the product)
* Anything that reaches servers you do not administer — every credential check upstream still applies
* CI-runnable E2E: the client needs GTA V; the CI gate stays at unit/integration level
