# fivem-mcp

[![npm version](https://img.shields.io/npm/v/fivem-mcp-server)](https://www.npmjs.com/package/fivem-mcp-server)
[![license: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/ziyacivan/fivem-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ziyacivan/fivem-mcp/actions/workflows/ci.yml)

An MCP (Model Context Protocol) server that lets AI agents — Claude, Qwen, or anything
that speaks MCP — **build, run and live-test FiveM servers** from the same machine.

It is the missing test layer for the "did it actually work in-game?" question: the agent
can run real console commands, watch both the server log and the *live F8 console of a
running FiveM client*, wait for specific output, and react — without you touching the
keyboard.

```
agent (Claude / Qwen / …)
   │  MCP over stdio
   ▼
fivem-mcp-server ──► UDP RCON / getinfo ──► FXServer (game port, e.g. 30120)
                   ──► TCP devcon (29200/29300) ──► FiveM Legacy client F8 console
                   ──► tail ─────────────────────► FXServer's redirected stdout log
```

## Status

v0.5 drives the whole loop: server console (RCON), client F8 console (devcon), the game
window (launch, focus, screenshot, keyboard/mouse) and an in-game bridge (`mcpb`) for
natives, exports and NUI callbacks — plus ready-made test prompts. Tools answer with
structured content, carry MCP annotations, and stop as soon as the client cancels. All of it live-verified
against a real FXServer + FiveM Legacy client (see `docs/plan.md` and `scripts/live-*.mjs`).

## Where it is published

| Channel | Address |
| --- | --- |
| npm | [fivem-mcp-server](https://www.npmjs.com/package/fivem-mcp-server) — `npx -y fivem-mcp-server` |
| MCP Registry | `io.github.ziyacivan/fivem-mcp` ([registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io)) |
| Source releases | [GitHub Releases](https://github.com/ziyacivan/fivem-mcp/releases), tagged `vX.Y.Z` |

The repository's GitHub **Packages** sidebar is deliberately empty: the artifact lives on
npmjs.com, not GitHub Packages — the latter would force a scoped `@ziyacivan/` package name
and a second registry for no benefit.

## Requirements

- Node 22+ (Windows, macOS or Linux for the server side; the client devcon works
  wherever the FiveM client runs — this tool must run on that machine for the
  `client_*` tools since devcon binds to localhost by default).
- A running FXServer you administer (`rcon_password` set for `server_command`).
- The Legacy FiveM client for the client-console tools (Enhanced removed the
  client devcon ports; see [docs/protocol.md](docs/protocol.md)).
- The keyboard/mouse/screenshot tools are **Windows-only** and run on the machine
  with the game. On other platforms every tool except those is served normally.

## Install

Published on npm — no clone needed. Add it to **Claude Code** in one line:

```sh
claude mcp add fivem -s user \
  -e FIVEM_RCON_PASSWORD=your-rcon-password \
  -e FIVEM_SERVER_LOG=C:\FXServer\my-data\server.log \
  -- npx -y fivem-mcp-server
```

(`-s user` = available in every project; drop it for a per-project entry. Verify with `claude mcp get fivem` — status should read ✓ Connected. Remove with `claude mcp remove fivem -s user`.)

For a **shared project config**, put `.mcp.json` in the repo root and commit it —
Claude Code asks to approve it on first open, and env values can be interpolated
from your local `.env`-less shell via `${VAR}` expansion:

```json
{
  "mcpServers": {
    "fivem": {
      "command": "npx",
      "args": ["-y", "fivem-mcp-server"],
      "env": {
        "FIVEM_RCON_PASSWORD": "${FIVEM_RCON_PASSWORD}",
        "FIVEM_SERVER_LOG": "${FIVEM_SERVER_LOG}"
      }
    }
  }
}
```

For **Claude Desktop** (or any client with JSON config), add to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "fivem": {
      "command": "npx",
      "args": ["-y", "fivem-mcp-server"],
      "env": { "FIVEM_RCON_PASSWORD": "your-rcon-password" }
    }
  }
}
```

The server is also listed in the MCP Registry as
`io.github.ziyacivan/fivem-mcp`. Building from source (development):

```sh
git clone https://github.com/ziyacivan/fivem-mcp
cd fivem-mcp && pnpm install && pnpm build
claude mcp add fivem -- node ./dist/index.js        # points at your working copy
```

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `FIVEM_HOST` | `127.0.0.1` | Machine running the FiveM client (devcon host) |
| `FIVEM_EXECUTABLE` | `%LOCALAPPDATA%\FiveM\FiveM.exe` | FiveM.exe for the `launch` tool |
| `FIVEM_CLIENT_DEVCON_PORT` | `29200` then `29300` | Override the client devcon port |
| `FIVEM_RCON_ADDRESS` | `FIVEM_HOST:30120` | FXServer game port (UDP RCON + getinfo) |
| `FIVEM_RCON_PASSWORD` | — | Matches `rcon_password` in `server.cfg`; needed by `server_command` |
| `FIVEM_SERVER_LOG` | — | Path to FXServer's redirected stdout; enables server-side `read_console` / `wait_for_console`. Not needed by the bridge since v0.5 (results poll in-band) — it is the pre-0.5 fallback transport |
| `FIVEM_MCPB_TOKEN` | — | Matches `mcpb_token` on the server; sent with every bridge request |
| `FIVEM_CONSOLE_CAPACITY` | `5000` | Client console lines kept in the ring buffer |
| `FIVEM_QUIET_MS` | `400` | Consider command output done after this quiet period |
| `FIVEM_COMMAND_TIMEOUT_MS` | `5000` | Default max wait for `client_command` output |
| `FIVEM_MCP_DEBUG` | — | `1` traces devcon frames and RCON round-trips on stderr |

## Tools

| Tool | What it does |
| --- | --- |
| `status` | Connection state: RCON, log file, client devcon. Call first. |
| `server_info` | `getinfo` over UDP — hostname, players, max clients, protocol, game build. **No credentials needed.** |
| `server_command` | Any server console command over UDP RCON; returns the captured output. |
| `client_command` | Types into the F8 console of a running Legacy client over devcon (nothing steals focus). This is the **local console command** layer — `connect`, `quit`, tooling; `RegisterCommand` chat commands are a different system (use `server_command`, which runs with console privileges, or the input/bridge tools). Returns the console lines it printed. |
| `read_console` | Recent lines: client = live devcon stream (with `afterSeq` paging), server = tail of `FIVEM_SERVER_LOG`. Filter by `channel`/`contains`/`pattern`. |
| `wait_for_console` | Block until a line matching a regex appears — your assertion primitive. |
| `list_commands` | Every command the client console knows (devcon handshake). |
| `launch` | Start FiveM, optionally straight into `host:port` (default: the configured server). |
| `quit_game` | Graceful `quit` over devcon; `force` kills the FiveM process tree. |
| `window_status` | Game window existence, title, pid, rect, foreground state. |
| `focus_window` / `restore_focus` | Bring the game forward / give focus back to your window. Input tools focus automatically. |
| `screenshot` | PNG of the game window (PrintWindow, screen-BitBlt fallback). Downscaled — default 900, optional `crop` rect. Every shot costs transcript tokens all session: prefer text probes, shoot small. |
| `press_key` / `hold_key` / `release_key` | Real scan-code input — GTA's DirectInput ignores VK-only injection. Held keys are released if the process dies. |
| `type_text` | Literal Unicode events — the channel the F8 console and chat NUI read. |
| `mouse_move` / `click` / `scroll` | Relative moves drive the camera; absolute coordinates position the cursor for NUI. |
| `wait` | Pause between actions (loading screens, walk cycles). |
| `read_client_log` | The newest `CitizenFX_log_*.log` from the FiveM install. |
| `bridge` | Invoke the `mcpb` bridge resource: `ping`, `players`, `poll`, `call_export`, `trigger_event` (server half) and `ping`, `position`, `teleport`, `freeze`, `call_native`, `send_nui`, `nui_callback` (client half). `op` is validated against the chosen target. |

## Prompts

Two workflows are shipped as MCP prompts, distilled from the live-verified loops:

- **`test_resource(resource, expectations?)`** — clean restart → console error scan →
  client-half scan → in-game scenario (keys, screenshot, bridge state) → evidence-backed
  PASS/FAIL report where anything unverifiable is said so out loud.
- **`smoke_check`** — one fast sweep: connections, which server, error tails on both sides,
  window + screenshot, persisted client log. OK/WARN/DOWN per line.

## The bridge resource (`bridge/`)

Client-side testing (natives, NUI callbacks, position) is outside what devcon and RCON can
reach — the small companion resource closes that gap and ships in this repo.

```sh
# on the dev server
cp -r bridge/ <server-data>/resources/mcpb     # or a junction
# server.cfg:
#   ensure mcpb
#   setr mcpb_enabled true
#   setr mcpb_token <a-random-token>
#   setr mcpb_event_allowlist  my:event,other:event      # trigger_event may fire only these
#   setr mcpb_export_allowlist myres:*,other:method       # optional; empty = any export
#   setr mcpb_native_allowlist SetEntityHealth,GetGameTimer   # optional; empty = any native
#   setr mcpb_client_timeout_ms 8000                      # a silent client fails fast
#   setr mcpb_verbose true                                # echo requests to both consoles
```

and point this server at it with `FIVEM_MCPB_TOKEN`. Then:

```
bridge { target: "client", src: 1, op: "position" }
bridge { target: "server", op: "call_export", args: "{\"resource\":\"myres\",\"method\":\"money\",\"args\":[1]}" }
```

Client results come back through an in-band queue polled over RCON (~100 ms granularity
since v0.5 — no log file needed; pre-0.5 resources still fall back to the log tail).

**Dev servers only.** `mcpb_enabled` defaults to `false`, the command is accepted only from
the console/RCON (never from a player), and the token is checked when set — but
`call_native` is exactly as safe as the console it runs behind. Keep RCON and this bridge
off anything you care about; see [SECURITY.md](SECURITY.md). The full wire contract: [docs/protocol.md §4](docs/protocol.md).

## Typical loop (what an agent does)

1. `server_command: "ensure my-resource"`
2. `wait_for_console: target=server, pattern="Started resource my-resource|Error"`
3. `client_command: "connect localhost:30120"` drives the join itself, then
   `read_console: target=client` catches client-side console output that never
   reaches the server log.

## Security notes — read before exposing anything

- **The client devcon socket has no authentication.** Anyone who can reach it can run
  local console commands in that game client (connect, quit, ...). FiveM binds it to
  `127.0.0.1` unless the client is started with `-devcon` (then `0.0.0.0`); this tool
  assumes the loopback default and never needs more. Do not tunnel it.
- **RCON is the server's admin root.** Keep `rcon_password` strong; `FIVEM_RCON_PASSWORD`
  lives in your MCP config — protect that file the same way.
- FXServer itself has no server-side devcon socket on current builds (verified
  2026-09-02), which is why the server half is RCON + log tail.
- Treat `server_command` as giving the agent root on your box the moment it can
  `exec` anything; run it only against **development** servers.

## Development

```sh
pnpm test        # vitest: fake devcon/rcon servers, byte-level SendInput/PNG checks, bridge contract, docs drift
pnpm typecheck
pnpm check       # biome
pnpm build       # -> dist/
pnpm run ci      # all of the above (plain `pnpm ci` is a pnpm builtin and errors)
```

Releasing: move the `Unreleased` changelog notes under the new version heading, then
`pnpm version <patch|minor|major>` (bumps and syncs `server.json` + the bridge manifest,
and tags), `npm publish` from your machine (`prepublishOnly` runs the full gate), and
`git push --follow-tags`. The Release workflow then re-runs the gate, creates the GitHub
Release from `CHANGELOG.md`, and registers the version with the MCP Registry.
See [CONTRIBUTING.md](CONTRIBUTING.md).

Live verification against a real server/game: `pnpm live:probe`, `live:e2e`, `live:m2`, `live:m3`.

The wire protocol (DevCon frames, RCON/getinfo OOB datagrams, the Cfx string hash)
is documented byte-by-byte in [docs/protocol.md](docs/protocol.md), derived from the
open-source CitizenFX server, `citizenfx/fivem@03dcc562`. Live-verified: RCON reply
format, `getinfo` response and the `>8`-byte challenge drop were confirmed against a
real FXServer on 2026-09-02.

## License

MIT. The FiveM/CitizenFX name is a trademark of Cfx.re; this project is not affiliated
with or endorsed by Cfx.re.
