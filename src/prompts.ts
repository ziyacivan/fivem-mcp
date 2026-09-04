// Prompts — playbooks distilled from the live-verified loops.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "test_resource",
    {
      title: "End-to-end test a FiveM resource",
      description:
        "Drive a resource from a clean restart through in-game behavior and produce an " +
        "evidence-backed PASS/FAIL report. Needs a running server and (for the game-side " +
        "steps) a connected client with the mcpb bridge installed.",
      argsSchema: {
        resource: z.string().describe("Resource name, e.g. 'breeze-chat'"),
        expectations: z
          .string()
          .optional()
          .describe("What must hold in-game — the scenario to run and observe"),
      },
    },
    ({ resource, expectations }) => ({
      description: `Verify ${resource} end to end`,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Verify the FiveM resource "${resource}" end to end with the fivem-mcp tools. Work the steps in order and read every result — never assume a step passed.`,
              "",
              "1. GROUND STATE — status; server_info (confirm this is the intended dev server by hostname and build); bridge target=server op=players if available (note tester srcs), else read_console to find who joined.",
              `2. CLEAN START — server_command: restart ${resource}; then wait_for_console target=server for 'Started resource ${resource}' and immediately read_console the window after it with pattern '[Ee]rror|failed|exception' to catch load-time failures. A restart that printed nothing but 'Started' is not enough — the error scan must be empty.`,
              "3. CLIENT HALF — read_console target=client with a pattern matching the resource name. Client-side errors never reach the server log; this is where a broken screen or NUI 404 shows up.",
              expectations
                ? `4. SCENARIO — ${expectations}`
                : "4. SCENARIO — drive a representative player flow: position baseline via bridge op=position, then the UI path (type_text / press_key / mouse on screenshot findings) or bridge op=nui_callback / call_export to assert server-side state directly.",
              "5. CAPTURE EVIDENCE — screenshot before and after the key moment; bridge op=position or call_export to read the state the scenario promised; for DB-backed claims use what the resource's own exports/console report, and say what the tool cannot see.",
              "6. REPORT — a PASS/FAIL table per expectation, each row citing the exact console line (channel + message) or coordinates that decided it. Anything unverifiable is listed as UNVERIFIED, not passed. Restore focus when done.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "smoke_check",
    {
      title: "Quick health sweep",
      description:
        "Fast 'is anything on fire?' pass over the server and the running client — connections, errors, window state.",
      argsSchema: {},
    },
    () => ({
      description: "Health sweep",
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Run a health sweep of the FiveM setup and report a short table.",
              "",
              "- status (devcon/rcon/log-file state) and server_info (which server, how many players).",
              "- read_console target=server pattern='[Ee]rror|fail|exception|crash' over the recent window; same scan on target=client when the F8 stream is connected.",
              "- window_status (is the game open? focused?) and one screenshot if a game window exists.",
              "- read_client_log with contains='error' as the persisted cross-check of the client.",
              "",
              "Output: one line per area — OK / WARN (with the exact log lines as evidence) / DOWN (with the tool's error text). No fixes, this is diagnosis only.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
