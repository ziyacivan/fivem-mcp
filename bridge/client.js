// mcpb client half. Runs in the game process: THIS is where natives actually
// exist for the local player. Requests arrive from the server half (which only
// accepts them from the console/RCON), results go back to the server for
// logging — never directly to the requester.
//
// Client-side convars (replicated with `setr` on the server):
//   mcpb_native_allowlist  ""       comma list of native names call_native may invoke (empty = any)
//   mcpb_verbose           "false"  echo every op to the F8 console
//   mcpb_nui_timeout_ms    "5000"   nui_callback gives up after this long

const NATIVE_NAME = /^[A-Z][A-Za-z0-9]*$/;

function convar(name, fallback) {
  return typeof GetConvar === "function" ? GetConvar(name, fallback) : fallback;
}

function csvList(name) {
  return convar(name, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** JSON.stringify that survives BigInt anywhere in the tree (natives return them). */
function safeStringify(value) {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function") return undefined;
    return v;
  });
}

function finite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number`);
  return n;
}

function localPed() {
  const ped = PlayerPedId();
  if (!ped || ped === 0) {
    throw new Error("no local ped yet — the player has not spawned (character screen or loading)");
  }
  return ped;
}

const CLIENT_OPS = {
  ping() {
    return { pong: true, frame: typeof GetFrameCount === "function" ? GetFrameCount() : 0 };
  },

  position() {
    const ped = localPed();
    const coords = GetEntityCoords(ped);
    return {
      x: coords.x ?? coords[0],
      y: coords.y ?? coords[1],
      z: coords.z ?? coords[2],
      heading: GetEntityHeading(ped),
      interior:
        typeof GetInteriorFromEntity === "function" ? GetInteriorFromEntity(ped) : undefined,
      vehicle: IsPedInAnyVehicle(ped, false) ? GetVehiclePedIsIn(ped, false) : 0,
    };
  },

  teleport(req) {
    const ped = localPed();
    const x = finite(req.x, "x");
    const y = finite(req.y, "y");
    const z = finite(req.z, "z");
    SetEntityCoords(ped, x, y, z, false, false, false, false);
    if (req.heading !== undefined) SetEntityHeading(ped, finite(req.heading, "heading"));
    return { ok: true };
  },

  freeze(req) {
    const ped = localPed();
    FreezeEntityPosition(ped, !!req.freeze);
    return { frozen: !!req.freeze };
  },

  // The flagship: invoke any client native by name. The escape hatch the whole
  // point of the bridge — natives no chat command can reach. The name must look
  // like a native (PascalCase identifier) and be an own property of the global
  // object, so `constructor`, `__proto__` and friends are not reachable.
  call_native(req) {
    const name = req.name;
    if (typeof name !== "string" || !NATIVE_NAME.test(name)) {
      throw new Error(`'${String(name)}' is not a native name (expected e.g. SetEntityHealth)`);
    }
    const allow = csvList("mcpb_native_allowlist");
    if (allow.length > 0 && !allow.includes(name)) {
      throw new Error(`native '${name}' not in mcpb_native_allowlist`);
    }
    if (!Object.hasOwn(globalThis, name) || typeof globalThis[name] !== "function") {
      throw new Error(`native '${name}' is not a function in the client runtime`);
    }
    const args = Array.isArray(req.args) ? req.args : [];
    const value = globalThis[name].apply(null, args);
    return value === undefined ? null : value;
  },

  // Push a message into a resource's NUI frame — drive our own screens.
  send_nui(req) {
    SendNUIMessage(req.message === undefined ? {} : req.message, req.event || "");
    return { sent: true };
  },

  // Call a NUI callback endpoint as the browser would (POST https://<res>/<ep>),
  // proving the NUI->client half of a screen without a human clicking it. A
  // hung endpoint fails after mcpb_nui_timeout_ms instead of never answering.
  async nui_callback(req) {
    if (typeof req.resource !== "string" || typeof req.endpoint !== "string") {
      throw new Error("nui_callback needs string 'resource' and 'endpoint'");
    }
    const timeoutMs = Number(convar("mcpb_nui_timeout_ms", "5000")) || 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(`https://${req.resource}/${req.endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.payload === undefined ? {} : req.payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `NUI callback ${req.resource}/${req.endpoint} did not answer within ${timeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* endpoints may answer plain text or empty */
    }
    return { status: response.status, body: parsed };
  },
};

RegisterNetEvent("mcpb:req");
AddEventHandler("mcpb:req", async (id, req) => {
  let json;
  try {
    const fn = CLIENT_OPS[req?.op];
    if (!fn) throw new Error(`unknown client op '${req?.op}'`);
    const data = await fn(req);
    json = safeStringify({ ok: true, data: data === undefined ? null : data });
  } catch (error) {
    json = safeStringify({ ok: false, error: String(error?.message ?? error) });
  }
  // Surface locally so an attached devcon client sees the activity live (opt-in:
  // this line lands in CitizenFX_log_* for every call).
  if (convar("mcpb_verbose", "false") === "true") {
    console.log(`mcpb client ${req?.op}: ${json.slice(0, 200)}`);
  }
  TriggerServerEvent("mcpb:res", id, json);
});
