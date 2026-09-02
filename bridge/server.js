// mcpb server half. Plain CommonJS FiveM script — no build step, on purpose:
// what you read is what runs. Every request arrives as a console command line
// `mcpb <id> <target> <src> <base64 json>` (issued over RCON by the fivem-mcp
// MCP server, so it runs with console privileges — the token below is the
// second lock, and the convar gate the off switch).
//
// Protocol contract lives in docs/protocol.md §4 and the fivem-mcp repo tests.

const pendingClientIds = new Set();

function enabled() {
  return GetConvar("mcpb_enabled", "false") === "true";
}

function expectedToken() {
  return GetConvar("mcpb_token", "");
}

function allowedEvents() {
  return GetConvar("mcpb_event_allowlist", "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function emit(id, result) {
  console.log(`MCP_RESULT ${id} ${JSON.stringify(result)}`);
}

function decode(b64) {
  const text = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(text);
}

function jsonSafe(value) {
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  return value;
}

// The FiveM runtime hands each script an `exports` proxy for calling into other
// resources. Prefer the global (tests stub it; some runtimes expose it there),
// fall back to the module-scoped binding the runtime injects.
function resourceExports() {
  return typeof globalThis.exports !== "undefined" ? globalThis.exports : exports;
}

// ---- server-side operations -------------------------------------------------

const SERVER_OPS = {
  ping() {
    return { pong: true, time: Date.now() };
  },

  players() {
    const out = [];
    const n = GetNumPlayerIndices();
    for (let i = 0; i < n; i++) {
      const src = GetPlayerFromIndex(i);
      out.push({
        src: Number(src),
        name: GetPlayerName(src),
        ping: GetPlayerPing(src),
        // GetPlayerIdentifiers is not a global in every server JS runtime
        // (it exists as a Lua/JS helper only in some builds) — never assume it.
        identifiers: typeof GetPlayerIdentifiers === "function" ? GetPlayerIdentifiers(src) : null,
      });
    }
    return out;
  },

  call_export(req) {
    const proxy = resourceExports();
    const target = proxy[req.resource];
    if (!target || typeof target[req.method] !== "function") {
      throw new Error(`export ${req.resource}:${req.method} is not callable`);
    }
    const args = Array.isArray(req.args) ? req.args : [];
    const fn = target[req.method];
    return jsonSafe(fn.apply(target, args));
  },

  trigger_event(req) {
    const allow = allowedEvents();
    if (!allow.includes(req.event)) {
      throw new Error(`event '${req.event}' not in mcpb_event_allowlist`);
    }
    const args = Array.isArray(req.args) ? req.args : [];
    if (req.toClient) {
      const target = req.player === undefined || req.player === -1 ? -1 : Number(req.player);
      TriggerClientEvent(req.event, target, ...args);
      return { triggeredClientEvent: req.event, player: target };
    }
    TriggerEvent(req.event, ...args);
    return { triggeredEvent: req.event };
  },

  wait() {
    // sync placeholder op to measure round-trip overhead
    return { waited: true };
  },
};

// ---- client ops are dispatched, results relayed by the client half ----------

function dispatchClient(id, playerId, req) {
  if (!Number.isInteger(playerId) || playerId <= 0) {
    throw new Error("target=client needs a valid src");
  }
  pendingClientIds.add(id);
  TriggerClientEvent("mcpb:req", playerId, id, req);
  console.log(`MCPB_ACK ${id} dispatched to ${playerId}`);
}

RegisterNetEvent("mcpb:res");
AddEventHandler("mcpb:res", (id, resultJson) => {
  // Only answer for ids we actually dispatched, and never trust the sender to
  // forge results for someone else's call: ids are single-use.
  if (!pendingClientIds.has(id)) return;
  pendingClientIds.delete(id);
  let result;
  try {
    result = JSON.parse(resultJson);
  } catch (error) {
    result = { ok: false, error: `client sent non-JSON result: ${String(error)}` };
  }
  emit(id, result);
});

RegisterCommand(
  "mcpb",
  (src, args) => {
    if (args[0] === undefined) {
      console.log("MCPB_USAGE mcpb <id> <server|client> [src] <base64 json>");
      return;
    }
    if (!enabled()) {
      console.log(`MCPB_ERR ${args[0]} bridge disabled — set mcpb_enabled true`);
      return;
    }
    const wantToken = expectedToken();
    const [id, target, srcArg, b64] = args;
    const trailing = args.slice(4).join(" "); // base64 never contains spaces; be lenient anyway
    const payload = b64 || trailing;
    let req;
    try {
      req = decode(payload);
    } catch (error) {
      emit(id, { ok: false, error: `bad request payload: ${String(error)}` });
      return;
    }
    if (wantToken && req.token !== wantToken) {
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
  false,
);
