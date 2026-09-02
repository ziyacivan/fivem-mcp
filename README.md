# fivem-mcp

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

v0.4 drives the whole loop: server console (RCON), client F8 console (devcon), the game
window (launch, focus, screenshot, keyboard/mouse) and an in-game bridge (`mcpb`) for
natives, exports and NUI callbacks — plus ready-made test prompts. All of it live-verified
against a real FXServer + FiveM Legacy client (see `docs/plan.md` and `scripts/live-*.mjs`).

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
| `FIVEM_CLIENT_DEVCON_PORT` | `29200` then `29300` | Override the client devcon port |
| `FIVEM_RCON_ADDRESS` | `FIVEM_HOST:30120` | FXServer game port (UDP RCON + getinfo) |
| `FIVEM_RCON_PASSWORD` | — | Matches `rcon_password` in `server.cfg`; needed by `server_command` |
| `FIVEM_SERVER_LOG` | — | Path to FXServer's redirected stdout; enables server-side `read_console` / `wait_for_console` and the bridge's client results |
| `FIVEM_MCPB_TOKEN` | — | Matches `mcpb_token` on the server; sent with every bridge request |
| `FIVEM_CONSOLE_CAPACITY` | `5000` | Client console lines kept in the ring buffer |
| `FIVEM_QUIET_MS` | `400` | Consider command output done after this quiet period |
| `FIVEM_COMMAND_TIMEOUT_MS` | `5000` | Default max wait for `client_command` output |

## Tools

| Tool | What it does |
| --- | --- |
| `status` | Connection state: RCON, log file, client devcon. Call first. |
| `server_info` | `getinfo` over UDP — hostname, players, max clients, protocol, game build. **No credentials needed.** |
| `server_command` | Any server console command over UDP RCON; returns the captured output. |
| `client_command` | Types into the F8 console of a running Legacy client over devcon (nothing steals focus). This is the **local console command** layer — `connect`, `quit`, tooling; `RegisterCommand` chat commands are a different system (use `server_command`, which runs with console privileges, or the planned input/bridge tools). Returns the console lines it printed. |
| `read_console` | Recent lines: client = live devcon stream (with `afterSeq` paging), server = tail of `FIVEM_SERVER_LOG`. Filter by `channel`/`contains`/`pattern`. |
| `wait_for_console` | Block until a line matching a regex appears — your assertion primitive. |
| `list_commands` | Every command the client console knows (devcon handshake). |
| `launch` | Start FiveM, optionally straight into `host:port` (default: the configured server). |
| `quit_game` | Graceful `quit` over devcon; `force` kills the FiveM process tree. |
| `window_status` | Game window existence, title, pid, rect, foreground state. |
| `focus_window` / `restore_focus` | Bring the game forward / give focus back to your window. Input tools focus automatically. |
| `screenshot` | PNG of the game window (PrintWindow with screen-BitBlt fallback), downscaled for vision models. |
| `press_key` / `hold_key` / `release_key` | Real scan-code input — GTA's DirectInput ignores VK-only injection. Held keys are released if the process dies. |
| `type_text` | Literal Unicode events — the channel the F8 console and chat NUI read. |
| `mouse_move` / `click` / `scroll` | Relative moves drive the camera; absolute coordinates position the cursor for NUI. |
| `wait` | Pause between actions (loading screens, walk cycles). |
| `read_client_log` | The newest `CitizenFX_log_*.log` from the FiveM install. |
| `bridge` | Invoke the `mcpb` bridge resource: player list, any resource export, event triggering (server half) and client natives, teleport, freeze, `SendNUIMessage`, NUI callback calls (client half). |

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
```

and point this server at it with `FIVEM_MCPB_TOKEN`. Then:

```
bridge { target: "client", src: 1, op: "position" }
bridge { target: "server", op: "call_export", args: "{\"resource\":\"myres\",\"method\":\"money\",\"args\":[1]}" }
```

**Dev servers only.** `mcpb_enabled` defaults to `false` and the token is checked when set,
but `call_native` is exactly as safe as the console it runs behind — keep RCON and this
bridge off anything you care about. The full wire contract: [docs/protocol.md §4](docs/protocol.md).

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
pnpm test        # vitest — 102 tests: fake devcon/rcon servers, byte-level SendInput/PNG checks, bridge contract
pnpm typecheck
pnpm check       # biome
pnpm build       # -> dist/
pnpm ci          # all of the above
```

Releasing: bump `package.json` (and `server.json`) version, tag `vX.Y.Z`, `npm publish`
(`prepublishOnly` runs the full gate), then `mcp-publisher publish` for the MCP Registry —
`server.json` + the `mcpName` field in `package.json` are the registry's ownership markers.

The wire protocol (DevCon frames, RCON/getinfo OOB datagrams, the Cfx string hash)
is documented byte-by-byte in [docs/protocol.md](docs/protocol.md), derived from the
open-source CitizenFX server, `citizenfx/fivem@03dcc562`. Live-verified: RCON reply
format, `getinfo` response and the `>8`-byte challenge drop were confirmed against a
real FXServer on 2026-09-02.

## License

MIT. The FiveM/CitizenFX name is a trademark of Cfx.re; this project is not affiliated
with or endorsed by Cfx.re.
