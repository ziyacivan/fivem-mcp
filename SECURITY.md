# Security

## What this tool is

fivem-mcp gives an AI agent the FXServer console (RCON), the FiveM client's F8 console
(devcon), the game window (keyboard, mouse, screenshots) and — through the `mcpb` bridge —
arbitrary client natives and resource exports. **That is administrative access by design.**
Run it only against development servers you own, on the machine that runs the game.

## Threat model and mitigations

| Surface | Risk | Mitigation in this project |
| --- | --- | --- |
| RCON password | Sent in clear text in every UDP request (FiveM protocol) | Keep the server on loopback/LAN; the tool accepts replies only from the configured host:port |
| Client devcon socket | No authentication; anyone who reaches it runs local console commands | FiveM binds it to 127.0.0.1 by default — never tunnel it; commands are single-line only |
| `mcpb` bridge | Console-privileged code execution in the server and the game | Off by default (`mcpb_enabled`); command accepted only from the console/RCON (source 0); optional `mcpb_token` (constant-time compare); `trigger_event`, `call_export`, `call_native` allowlists; ids single-use; results bounded to one datagram |
| Console output in transcripts | `server_command` echoes whatever the console prints, including convar values | Do not run `rcon_password`/secret-dumping commands through an agent session |
| Screenshots | Whatever covers the game window is captured too | Screenshots are taken only on explicit tool calls |

## Reporting a vulnerability

Please do not open a public issue for security problems. Email the maintainer via the
address on the GitHub profile of [@ziyacivan](https://github.com/ziyacivan) with a
description and reproduction steps. You will get an acknowledgement within a few days;
fixes ship as a patch release with a CHANGELOG entry under **Security**.
