# Protocol notes — reverse-engineered from the open-source CitizenFX server

Everything in this repository speaks documented, in-tree CitizenFX protocols — nothing here
is guesswork or a copy of a third-party tool. Every claim carries a source. Where we could
verify against a live FXServer, that is stated; where we could not (needs a running game
client), it is marked **UNVERIFIED** and listed in `docs/plan.md`'s field-test checklist.

Sources read on 2026-09-02:

| Ref | File | Used for |
| --- | --- | --- |
| [A] | `citizenfx/fivem@03dcc562` `code/components/devcon/src/DevConServer.cpp` | devcon TCP protocol |
| [B] | `citizenfx/fivem@03dcc562` `code/client/shared/Utils.h:243-283` | `HashString` / `HashRageString` |
| [C] | `citizenfx/fivem@03dcc562` `code/components/citizen-server-impl/include/decorators/WithOutOfBand.h:35-61` | OOB UDP envelope + key dispatch |
| [D] | `citizenfx/fivem@03dcc562` `code/components/citizen-server-impl/include/outofbandhandlers/RconOutOfBand.h` | rcon semantics |
| [E] | `citizenfx/fivem@03dcc562` `code/components/citizen-server-impl/include/outofbandhandlers/GetInfoOutOfBand.h` | getinfo semantics |
| [F] | `citizenfx/fivem@03dcc562` `code/tests/server/TestOOB.cpp` | exact OOB bytes |
| [G] | `citizenfx/fivem-docs` `content/docs/developers/legacy-vs-enhanced.md:21` | Enhanced removed client devcon ports |

All files fetched via raw.githubusercontent.com at commit `03dcc562ca175e24eb018569ecb919b4b7a56824`
(master, 2026-09-01). Line numbers refer to that commit.

## 1. Cfx string hashes [B]

`HashString` — classic lowercase djb2, over the string's *bytes*:

```
hash = 0
for byte b in utf8(s):            # C++ char is signed: b >= 0x80 adds sign-extended
    c = lower_ascii(b)
    hash += c; hash += hash << 10; hash ^= hash >> 6      # (uint32, logical >>)
hash += hash << 3; hash ^= hash >> 11; hash += hash << 15
```

`HashRageString` is identical minus the lowercasing [B]; the OOB dispatcher uses it on the
key [C:61,69].

Ground truth (computed with a C# reproduction of the exact C++ lines, checked against the
vectors in `tests/hash.test.ts`): `rcon` → `2313349815`, `getinfo` → `2403156743`.

## 2. Out-of-band UDP envelope [C][F]

An OOB datagram to the **game port** (default `30120`):

```
0xFFFFFFFF | <key> | <separator " " or "\n"> | <payload>
```

`<key>` is the bytes up to the first space/newline, matched via `HashRageString` against the
handler names `"getinfo"`, `"getstatus"`, `"rcon"`. Responses are sent back with the same
`0xFFFFFFFF` prefix (`SendOutOfBand(prefix=true)`).

### 2.1 `getinfo <challenge>` [E]

* `challenge` **must be ≤ 8 bytes** or the packet is dropped silently (`data.size() > 8`).
  This bit us live: a 9-byte challenge got no reply; `"fivem0"` works.
* Rate limiter: 2/s, burst 10.
* Reply (captured from a live FXServer, 2026-09-02, build 179740983):

```
infoResponse
\sv_maxclients\48\clients\0\challenge\fivem0\gamename\CitizenFX\protocol\4\hostname\breeze standalone [dev]\gametype\\mapname\\iv\179740983
```

`iv` is `sv_infoVersion` (the game build). Empty values are empty between separators
(`gametype\\mapname`).

### 2.2 `rcon\n<password> <command>` [C][D]

* Request: `0xFFFFFFFF` + `rcon\n` + `<password> <command>`. The server strips `rcon\n` as
  the key, then splits **on the first space** into password and command — passwords
  containing spaces are unsupported by the protocol itself [D:30-38].
* No password set on the server → reply `print The server must set rcon_password to be able to use this command.\n`
  (observed live, 2026-09-02 — this also proves the whole request/response format).
* Wrong password → reply `print Invalid password.\n` (note: a `print`, not an `error`).
* On success the command runs in the console context with `system.console` principal;
  *everything it prints* is captured and returned as one datagram:
  `0xFFFFFFFF` + `print <captured output>` [D:60-68]. Channel names get `rcon/` prefixed
  during capture (invisible to us).
* Rate limiter: 0.2/s, burst 5 per address *until authenticated*; authorized commands
  reset it. There is no request id — responses are matched by order; our client
  serializes.

## 3. DevCon — the console TCP socket [A]

### 3.1 Ports and reality check [A:254-258]

| Process | Port | Status |
| --- | --- | --- |
| FXServer | `29100` | **Defined in source but never bound** on a current build (verified 2026-09-02: listening sockets were 30120 only; no devcon line in the boot log). Do not depend on it — this is why the server half of this tool uses RCON + log tailing. |
| FiveM client (CL1/Legacy) | `29200` | **Verified live 2026-09-02** against a running Legacy client (gamebuild 3258): handshake, 23-channel registry, `connect` executed via CMND and its `[glue]` reply streamed back via PRNT. |
| FiveM client (CL2) | `29300` | as above |
| Enhanced clients | — | client devcon removed [G] |

Bind address is `127.0.0.1` **unless the process command line contains `-devcon`**, then
`0.0.0.0` [A:263-266]. The socket has **no authentication** — keep it loopback-only, never
port-forward it.

The port is multiplexed with plain HTTP (a profiler endpoint) [A:277-345]; we always speak
the binary protocol, whose frames are matched by their first four ASCII bytes [A:352-361].

### 3.2 Frame header

All frames: `magic` (4 ASCII) + `protocol` u16 **BE** (`211`) + `length` u32 **BE** (total
frame size including the 10-byte header). After that, per-type layouts. Mixed endianness
inside frames is upstream's, faithfully: fields written through `sSwapLongRead`/
`sSwapShortRead` are big-endian, raw `Write<uint32_t>`/`<uint16_t>` of non-zero-constants
are little-endian.

### 3.3 Client → process

* `PPCR` (just the 4 magic bytes) — handshake. Process replies `AINF`, `CHAN*`, `CVAR*`.
* `CMND` — a console command, executed with full local console privileges (typed into the
  server window / F8). Layout: header (12 incl. trailing u16 zero) + command text + **one
  trailing byte which must be `"\n"`** [A:411-421]. The server re-reads all but the last
  byte into the string and appends its own `"\n"` — so a trailing NUL survives *inside* the
  command text and the command silently matches nothing (observed live 2026-09-02:
  `help` with a NUL tail produced zero output; with the newline tail `connect` executed and
  answered `[glue] Ignoring ConnectTo because we're already connecting/connected.`).

**Scope of the client-side console (live-verified 2026-09-02):** CMND reaches the game
process's `console::Context` — the layer that holds *console* commands (glue's `connect`,
tooling commands). `RegisterCommand` chat commands are **not** in this context (in-game the
CVAR flush reported zero resource commands while `connect` worked); they belong to the
chat/command buffer system and must be driven via the chat UI (M2 input tools) or the
planned bridge resource (M3), or run server-side through RCON where they execute with
`system.console` privileges.

### 3.4 Process → client frames

* `AINF` — process info. 12-byte header + u32LE `0x0EFF8A1A` + u32LE 0 + u32BE `0x321F0C00`
  + game name `char[32]` + app name `char[32]` + u8 `0xFF` + u32BE `8` + u32BE
  `commandLine.length+1` + NUL-terminated full process command line. We keep it as the
  process fingerprint (`status`).
* `CHAN` — channel registry. count u32BE at offset 10, then 58 B/entry:
  u32LE `HashString(name)`, u32 0, u32 0, u32BE 2, u32BE 2, u32 0, name `char[30]`, u32 1.
* `CVAR` — one registered **console command** (upstream's misleading name). 93 B total:
  offset 12 `char[64]` name (NUL-padded), then u32 0, flags/min/max u32BE 0, u8 `0x11`.
  Sent as a diff — each new print event re-announces commands that appeared since the last
  flush [A:127-163]; treat as additive.
* `PRNT` — one console line. Total length `41 + len(message)`; offsets: u16 0, u32LE
  `HashString(channel)` at 12, 24 B padding at 16, NUL-terminated utf-8 message at 40.
  Channels we never saw a `CHAN` for are reported as `#<id>`.

Every print event also triggers the CHAN/CVAR diff flush for all subscribers [A:188-198],
so the registries fill up as the server runs.
