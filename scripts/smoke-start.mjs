// CI smoke test for the built package: start dist/index.js over stdio, complete
// the MCP initialize handshake, list tools, and exit cleanly. Catches packaging
// mistakes (missing files, broken imports, a startup crash) that unit tests on
// src/ cannot see.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env, FIVEM_RCON_PASSWORD: "smoke" },
  stderr: "pipe",
});
const client = new Client({ name: "smoke", version: "0" });
const deadline = setTimeout(() => {
  console.error("smoke-start: no answer within 15 s");
  process.exit(1);
}, 15000);

await client.connect(transport);
const { tools } = await client.listTools();
const version = client.getServerVersion();
console.log(
  `smoke-start: ${version?.name}@${version?.version} answered with ${tools.length} tools`,
);
if (tools.length < 20) {
  console.error("smoke-start: too few tools registered");
  process.exit(1);
}
await client.close();
clearTimeout(deadline);
process.exit(0);
