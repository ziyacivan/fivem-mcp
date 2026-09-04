// The README tool table, server.json's env-var list and the bridge op lists are
// hand-written mirrors of the code. These tests fail the build when they drift.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { Hub } from "../src/hub.js";
import { buildMcpServer } from "../src/server.js";
import { CLIENT_OPS, SERVER_OPS } from "../src/tools/bridge.js";
import { makeConfig } from "./helpers/config.js";

const root = path.join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

async function listToolNames(): Promise<string[]> {
  const config = makeConfig();
  const hub = new Hub(config);
  const server = buildMcpServer(config, hub);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "docs", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  hub.closeAll();
  return tools.map((tool) => tool.name).sort();
}

/** Tool names in the README's "## Tools" table (first column, `a` / `b` cells allowed). */
function readmeToolNames(): string[] {
  const readme = read("README.md");
  const section = readme.split("## Tools")[1]?.split("\n## ")[0] ?? "";
  const names = new Set<string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const firstCell = line.slice(1).split("|")[0] ?? "";
    for (const match of firstCell.matchAll(/`([a-z_]+)`/g)) names.add(match[1] as string);
  }
  return [...names].sort();
}

/** Variable names in the README's "## Configuration (environment)" table. */
function readmeEnvNames(): string[] {
  const readme = read("README.md");
  const section = readme.split("## Configuration (environment)")[1]?.split("\n## ")[0] ?? "";
  return [...section.matchAll(/^\| `([A-Z_]+)`/gm)].map((m) => m[1] as string).sort();
}

describe("documentation stays in step with the code", () => {
  it("README tool table lists exactly the registered tools", async () => {
    expect(readmeToolNames()).toEqual(await listToolNames());
  });

  it("server.json documents every environment variable the README does", () => {
    const manifest = JSON.parse(read("server.json")) as {
      packages: Array<{ environmentVariables: Array<{ name: string }> }>;
    };
    const documented = (manifest.packages[0]?.environmentVariables ?? []).map((v) => v.name).sort();
    expect(documented).toEqual(readmeEnvNames());
  });

  it("every FIVEM_* variable read by the code is in the README table", () => {
    const sources = ["src/config.ts", "src/launcher.ts", "src/log.ts"].map(read).join("\n");
    const used = [
      ...new Set([...sources.matchAll(/env\.(FIVEM_[A-Z_]+)/g)].map((m) => m[1])),
    ].sort() as string[];
    for (const name of used) expect(readmeEnvNames(), name).toContain(name);
  });

  it("the bridge tool's op lists match what bridge/*.js implement", () => {
    const server = read("bridge/server.js");
    const client = read("bridge/client.js");
    const opsIn = (source: string, table: string) => {
      const body = source.split(`const ${table} = {`)[1]?.split("\n};")[0] ?? "";
      return [...body.matchAll(/^ {2}(?:async )?([a-z_]+)\(/gm)].map((m) => m[1] as string).sort();
    };
    expect([...SERVER_OPS].sort()).toEqual(opsIn(server, "SERVER_OPS"));
    expect([...CLIENT_OPS].sort()).toEqual(opsIn(client, "CLIENT_OPS"));
  });

  it("package.json, server.json and fxmanifest carry the same version", () => {
    const { version } = JSON.parse(read("package.json")) as { version: string };
    const manifest = JSON.parse(read("server.json")) as {
      version: string;
      packages: Array<{ version: string }>;
    };
    expect(manifest.version).toBe(version);
    expect(manifest.packages[0]?.version).toBe(version);
    expect(read("bridge/fxmanifest.lua")).toContain(`version '${version}'`);
  });
});
