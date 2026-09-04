// mcpb client half. Runs in the game process: THIS is where natives actually
// exist for the local player. Requests arrive from the server half (which only
// accepts them from the console/RCON), results go back to the server for
// logging — never directly to the requester.

function jsonSafe(value) {
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return undefined;
  return value;
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
    return { pong: true, frame: GetFrameCount ? GetFrameCount() : 0 };
  },

  position() {
    const ped = localPed();
    const coords = GetEntityCoords(ped);
    return {
      x: coords.x ?? coords[0],
      y: coords.y ?? coords[1],
      z: coords.z ?? coords[2],
      heading: GetEntityHeading(ped),
      interior: GetInteriorFromEntity ? GetInteriorFromEntity(ped) : undefined,
      vehicle: IsPedInAnyVehicle(ped, false) ? GetVehiclePedIsIn(ped, false) : 0,
    };
  },

  teleport(req) {
    const ped = localPed();
    SetEntityCoords(ped, req.x, req.y, req.z, false, false, false, false);
    if (req.heading !== undefined) SetEntityHeading(ped, req.heading);
    return { ok: true };
  },

  freeze(req) {
    const ped = localPed();
    FreezeEntityPosition(ped, !!req.freeze);
    return { frozen: !!req.freeze };
  },

  // The flagship: invoke any client native by name. The escape hatch the whole
  // point of the bridge — natives no chat command can reach.
  call_native(req) {
    const fn = globalThis[req.name];
    if (typeof fn !== "function") {
      throw new Error(`native '${req.name}' is not a function in the client runtime`);
    }
    const args = Array.isArray(req.args) ? req.args : [];
    return jsonSafe(fn.apply(null, args));
  },

  // Push a message into a resource's NUI frame — drive our own screens.
  send_nui(req) {
    SendNUIMessage(req.message === undefined ? {} : req.message, req.event || "");
    return { sent: true };
  },

  // Call a NUI callback endpoint as the browser would (POST https://<res>/<ep>),
  // proving the NUI->client half of a screen without a human clicking it.
  async nui_callback(req) {
    const response = await fetch(`https://${req.resource}/${req.endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.payload === undefined ? {} : req.payload),
    });
    const text = await response.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* endpoints may answer plain text or empty */
    }
    return { status: response.status, body: jsonSafe(parsed) };
  },
};

RegisterNetEvent("mcpb:req");
AddEventHandler("mcpb:req", async (id, req) => {
  let result;
  try {
    const fn = CLIENT_OPS[req.op];
    if (!fn) throw new Error(`unknown client op '${req.op}'`);
    const data = await fn(req);
    result = { ok: true, data: data === undefined ? null : data };
  } catch (error) {
    result = { ok: false, error: String(error?.message ?? error) };
  }
  // Also surface locally so an attached devcon client sees the activity live.
  console.log(`mcpb client ${req.op}: ${result.ok ? "ok" : result.error}`);
  TriggerServerEvent("mcpb:res", id, JSON.stringify(result));
});
