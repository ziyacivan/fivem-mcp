import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { Hub } from "./hub.js";
import { attachMcpLogging } from "./log.js";
import { registerPrompts } from "./prompts.js";
import { registerBridgeTools } from "./tools/bridge.js";
import { registerConsoleTools } from "./tools/console.js";
import { registerMiscTools } from "./tools/misc.js";
import { registerWindowTools } from "./tools/window.js";

/** Single source of truth for the version is package.json (dist/ sits one level below it). */
export const PACKAGE_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

/** Compose the MCP server: tool groups live in ./tools, prompts in ./prompts. */
export function buildMcpServer(config: Config, hub: Hub): McpServer {
  const server = new McpServer(
    { name: "fivem-mcp-server", version: PACKAGE_VERSION },
    { capabilities: { logging: {} } },
  );
  attachMcpLogging(server);
  const context = { config, hub };
  registerConsoleTools(server, context);
  registerWindowTools(server, context);
  registerMiscTools(server);
  registerBridgeTools(server, context);
  registerPrompts(server);
  return server;
}
