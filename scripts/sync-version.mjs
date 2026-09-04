// Propagate package.json's version to the other files that carry it:
// server.json (MCP Registry manifest, two places) and bridge/fxmanifest.lua.
// Wired to the npm `version` lifecycle, so `pnpm version patch` keeps them in
// step; run directly to repair drift.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const write = (rel, text) => writeFileSync(join(root, rel), text, "utf8");

const { version } = JSON.parse(read("package.json"));
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  throw new Error(`package.json version looks wrong: ${version}`);
}

const serverJson = JSON.parse(read("server.json"));
serverJson.version = version;
for (const pkg of serverJson.packages ?? []) pkg.version = version;
write("server.json", `${JSON.stringify(serverJson, null, 2)}\n`);

const manifest = read("bridge/fxmanifest.lua");
const updated = manifest.replace(/^version '[^']*'$/m, `version '${version}'`);
if (updated === manifest && !manifest.includes(`version '${version}'`)) {
  throw new Error("bridge/fxmanifest.lua has no version line to update");
}
write("bridge/fxmanifest.lua", updated);

console.log(`synced version ${version} -> server.json, bridge/fxmanifest.lua`);
