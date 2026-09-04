// mcpb server half. Plain CommonJS FiveM script — no build step, on purpose:
// what you read is what runs. Every request arrives as a console command line
// `mcpb <id> <target> <src> <base64 json>` (issued over RCON by the fivem-mcp
// MCP server, so it runs with console privileges — the command is restricted to
// source 0, the token is the second lock, and the convar gate the off switch).
//
// Protocol contract lives in docs/protocol.md §4 and the fivem-mcp repo tests.
//
// Convars (all `setr`, read live):
//   mcpb_enabled            "false"  master switch
//   mcpb_token              ""       must match the MCP server's FIVEM_MCPB_TOKEN when set
//   mcpb_event_allowlist    ""       comma list of event names trigger_event may fire
//   mcpb_export_allowlist   ""       comma list of `resource:method` / `resource:*` call_export may call (empty = any)
//   mcpb_client_timeout_ms  "8000"   a client op with no answer by then fails fast instead of silently
//   mcpb_verbose            "false"  echo every request/ack to the console

// Client ops in flight: id -> { src, at, timer }. Entries expire (see
// mcpb_client_timeout_ms) so a player who never answers cannot leak them.
const pendingClient = new Map();

// Client results wait here until the MCP server drains them with the `poll`
// op. This is the in-band return path: no log-file tailing needed, ~100 ms
// granularity instead of 400+ ms file polls. The MCP_RESULT console line is
// still printed — for humans, CI captures and older clients.
const bufferedResults = new Map(); // id -> { json, at }
const RESULT_TTL_MS = 60000;
const RESULT_BUFFER_MAX = 128;
// One RCON reply is one UDP datagram; past ~1400 bytes it is fragmented or
// dropped outright. Results and poll batches are capped so the reply always fits.
const RESULT_MAX_BYTES = 1200;
const POLL_DEFAULT_MAX = 16;

function convar(name, fallback) {
  return GetConvar(name, fallback);
}

function enabled() {
  return convar("mcpb_enabled", "false") === "true";
}

function verbose() {
  return convar("mcpb_verbose", "false") === "true";
}

function expectedToken() {
  return convar("mcpb_token", "");
}

function clientTimeoutMs() {
  const value = Number(convar("mcpb_client_timeout_ms", "8000"));
  return Number.isFinite(value) && value > 0 ? value : 8000;
}

function csvList(name) {
  return convar(name, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Constant-time string equality: the token check must not leak its length or prefix. */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** JSON.stringify that survives BigInt (natives return them) anywhere in the tree. */
function safeStringify(value) {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function") return undefined;
    return v;
  });
}

/** Keep the MCP_RESULT line inside one UDP datagram; say so when data had to go. */
function boundedResult(result) {
  const json = safeStringify(result);
  if (json.length <= RESULT_MAX_BYTES) return json;
  return safeStringify({
    ok: result.ok,
    error: result.error,
    data: { truncated: true, bytes: json.length, preview: json.slice(0, 400) },
  });
}

function emit(id, result) {
  const json = boundedResult(result);
  console.log(`MCP_RESULT ${id} ${json}`);
  return json;
}

function decode(b64) {
  const text = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(text);
}

function pruneBuffered(now) {
  for (const [id, entry] of bufferedResults) {
    if (now - entry.at > RESULT_TTL_MS) bufferedResults.delete(id);
  }
  while (bufferedResults.size >= RESULT_BUFFER_MAX) {
    const oldest = bufferedResults.keys().next();
    if (oldest.done) break;
    bufferedResults.delete(oldest.value);
  }
}

function bufferResult(id, json) {
  const now = Date.now();
  pruneBuffered(now);
  bufferedResults.set(id, { json, at: now });
}

// The FiveM runtime hands each script an `exports` proxy for calling into other
// resources. Prefer the global (tests stub it; some runtimes expose it there),
// fall back to the module-scoped binding the runtime injects.
function resourceExports() {
  return typeof globalThis.exports !== "undefined" ? globalThis.exports : exports;
}

function exportAllowed(resource, method) {
  const allow = csvList("mcpb_export_allowlist");
  if (allow.length === 0) return true;
  return allow.includes(`${resource}:${method}`) || allow.includes(`${resource}:*`);
}

// ---- server-side operations -------------------------------------------------

const SERVER_OPS = {
  ping() {
    return { pong: true, time: Date.now() };
  },

  players(req) {
    const withIdentifiers = req.identifiers === true;
    const out = [];
    const n = GetNumPlayerIndices();
    for (let i = 0; i < n; i++) {
      const src = GetPlayerFromIndex(i);
      const entry = { src: Number(src), name: GetPlayerName(src), ping: GetPlayerPing(src) };
      // GetPlayerIdentifiers is not a global in every server JS runtime
      // (it exists as a Lua/JS helper only in some builds) — never assume it.
      // Identifiers are opt-in: they are long and would blow the datagram cap.
      if (withIdentifiers) {
        entry.identifiers =
          typeof GetPlayerIdentifiers === "function" ? GetPlayerIdentifiers(src) : null;
      }
      out.push(entry);
    }
    return out;
  },

  call_export(req) {
    if (typeof req.resource !== "string" || typeof req.method !== "string") {
      throw new Error("call_export needs string 'resource' and 'method'");
    }
    if (!exportAllowed(req.resource, req.method)) {
      throw new Error(`export ${req.resource}:${req.method} not in mcpb_export_allowlist`);
    }
    const proxy = resourceExports();
    const target = proxy[req.resource];
    if (!target || typeof target[req.method] !== "function") {
      throw new Error(`export ${req.resource}:${req.method} is not callable`);
    }
    const args = Array.isArray(req.args) ? req.args : [];
    const fn = target[req.method];
    const value = fn.apply(target, args);
    return value === undefined ? null : value;
  },

  trigger_event(req) {
    if (typeof req.event !== "string") throw new Error("trigger_event needs a string 'event'");
    const allow = csvList("mcpb_event_allowlist");
    if (!allow.includes(req.event)) {
      throw new Error(`event '${req.event}' not in mcpb_event_allowlist`);
    }
    const args = Array.isArray(req.args) ? req.args : [];
    if (req.toClient) {
      let target = -1;
      if (req.player !== undefined && req.player !== -1) {
        target = Number(req.player);
        if (!Number.isInteger(target) || target <= 0) {
          throw new Error("trigger_event 'player' must be a positive server id or -1 (all)");
        }
      }
      TriggerClientEvent(req.event, target, ...args);
      return { triggeredClientEvent: req.event, player: target };
    }
    TriggerEvent(req.event, ...args);
    return { triggeredEvent: req.event };
  },

  poll(req) {
    const now = Date.now();
    expirePendingClients(now);
    const max = Number.isInteger(req.max) && req.max > 0 ? req.max : POLL_DEFAULT_MAX;
    const out = [];
    let bytes = 2;
    for (const [id, entry] of bufferedResults) {
      if (out.length >= max) break;
      let result;
      try {
        result = JSON.parse(entry.json);
      } catch (error) {
        result = { ok: false, error: `buffered result unreadable: ${String(error)}` };
      }
      const size = entry.json.length + id.length + 24;
      // Always hand out at least one entry, otherwise a single oversized result
      // would be stuck forever; the reply-side cap already bounded each one.
      if (out.length > 0 && bytes + size > RESULT_MAX_BYTES) break;
      bytes += size;
      bufferedResults.delete(id);
      if (now - entry.at > RESULT_TTL_MS) continue;
      out.push({ id, result });
    }
    return out;
  },

  wait() {
    // sync placeholder op to measure round-trip overhead
    return { waited: true };
  },
};

// ---- client ops are dispatched, results relayed by the client half ----------

function settleClient(id, result) {
  const pending = pendingClient.get(id);
  if (!pending) return false;
  pendingClient.delete(id);
  clearTimeout(pending.timer);
  bufferResult(id, safeStringify(result));
  emit(id, result);
  return true;
}

function expirePendingClients(now) {
  for (const [id, pending] of pendingClient) {
    if (now - pending.at > pending.timeoutMs) {
      settleClient(id, {
        ok: false,
        error: `client ${pending.src} did not answer within ${pending.timeoutMs}ms`,
      });
    }
  }
}

function dispatchClient(id, playerId, req) {
  if (!Number.isInteger(playerId) || playerId <= 0) {
    throw new Error("target=client needs a valid src");
  }
  const timeoutMs = clientTimeoutMs();
  const timer = setTimeout(() => {
    settleClient(id, {
      ok: false,
      error: `client ${playerId} did not answer within ${timeoutMs}ms`,
    });
  }, timeoutMs);
  pendingClient.set(id, { src: playerId, at: Date.now(), timeoutMs, timer });
  TriggerClientEvent("mcpb:req", playerId, id, req);
  console.log(`MCPB_ACK ${id} dispatched to ${playerId}`);
}

RegisterNetEvent("mcpb:res");
AddEventHandler("mcpb:res", (id, resultJson) => {
  // Only answer for ids we actually dispatched, and only from the player we
  // dispatched to: ids are single-use and cannot be answered on someone's behalf.
  const pending = pendingClient.get(id);
  if (!pending) return;
  const sender = Number(globalThis.source);
  if (Number.isFinite(sender) && sender > 0 && sender !== pending.src) {
    console.log(`MCPB_DENY player ${sender} tried to answer ${id} (belongs to ${pending.src})`);
    return;
  }
  let result;
  try {
    result = JSON.parse(resultJson);
  } catch (error) {
    result = { ok: false, error: `client sent non-JSON result: ${String(error)}` };
  }
  settleClient(id, result);
});

RegisterCommand(
  "mcpb",
  (src, args) => {
    // Console/RCON invocations arrive with source 0. Anything else is a player
    // typing the command — refuse before touching the payload, and say nothing
    // (no MCP_RESULT for an id we never accepted).
    if (Number(src) !== 0) {
      console.log(`MCPB_DENY player ${src} tried to run mcpb`);
      return;
    }
    if (args[0] === undefined) {
      console.log("MCPB_USAGE mcpb <id> <server|client> [src] <base64 json>");
      return;
    }
    if (!enabled()) {
      console.log(`MCPB_ERR ${args[0]} bridge disabled — set mcpb_enabled true`);
      return;
    }
    const [id, target, srcArg, b64] = args;
    if (verbose()) console.log(`MCPB_REQ ${id} ${target} ${srcArg}`);
    let req;
    try {
      // base64 never contains spaces: exactly four tokens, or the line is malformed.
      if (args.length !== 4) throw new Error(`expected 4 tokens, got ${args.length}`);
      req = decode(b64);
      if (typeof req !== "object" || req === null || Array.isArray(req)) {
        throw new Error("payload must be a JSON object");
      }
    } catch (error) {
      emit(id, { ok: false, error: `bad request payload: ${String(error)}` });
      return;
    }
    const wantToken = expectedToken();
    if (wantToken && !safeEqual(req.token, wantToken)) {
      emit(id, { ok: false, error: "bad mcpb token" });
      return;
    }
    if (target === "server") {
      try {
        const fn = SERVER_OPS[req.op];
        if (!fn) throw new Error(`unknown server op '${req.op}'`);
        emit(id, { ok: true, data: fn(req) });
      } catch (error) {
        emit(id, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    if (target === "client") {
      try {
        dispatchClient(id, Number(srcArg), req);
      } catch (error) {
        emit(id, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    emit(id, { ok: false, error: `unknown target '${target}'` });
  },
  true, // restricted: console/RCON only (plus any explicit ace grant)
);
