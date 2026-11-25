#!/usr/bin/env bun
/**
 * Mock kiro-cli 3.6.1 fixture for end-to-end AI SDK v3 + canonical tool-call
 * state machine testing via `setupOpenCodeV2`.
 */

import * as readline from "node:readline";

const args = process.argv.slice(2);

if (args[0] === "whoami") {
  console.log("Logged in as dev@example.com (AWS Builder ID)");
  process.exit(0);
}

if (args[0] === "chat" && args.includes("--list-models")) {
  console.log(
    JSON.stringify({
      models: [
        {
          id: "claude-sonnet-4.5",
          name: "Claude Sonnet 4.5 (Kiro)",
          contextWindow: 200000,
          maxOutputTokens: 16384,
          reasoning: true,
          supportsTools: true,
          supportsVision: true,
          isDefault: true,
        },
      ],
    })
  );
  process.exit(0);
}

if (args[0] === "acp") {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (msg: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed) as Record<string, unknown>;
    const id = msg.id as number | string | undefined;
    const method = msg.method as string;
    const params = (msg.params ?? {}) as Record<string, unknown>;

    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "kiro-cli-3.6.1-mock", version: "3.6.1" },
          authMethods: [],
        },
      });
      return;
    }

    if (method === "session/new") {
      send({
        jsonrpc: "2.0",
        id,
        result: { sessionId: "v3-tool-sess-1" },
      });
      return;
    }

    if (method === "session/set_model" || method === "session/set_config_option") {
      send({ jsonrpc: "2.0", id, result: { ok: true } });
      return;
    }

    if (method === "session/prompt") {
      const sessionId = String(params.sessionId);
      const failTool = process.env.MOCK_KIRO_TOOL_FAIL === "1";

      // 1. Thought chunk
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "I should search the web first." },
          },
        },
      });

      // 2. kiro-cli 3.6.1 web_search tool_call
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_ws_361",
            title: "Searching the web",
            kind: "search",
            status: "pending",
            rawInput: { query: "OpenCode 2.x AI SDK v3" },
            _meta: { kiro: { toolName: "web_search" } },
          },
        },
      });

      // 3. Intermediate in_progress update (no output)
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_ws_361",
            title: "web_search",
            status: "in_progress",
          },
        },
      });

      // 4. Terminal update with nested content
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_ws_361",
            title: "web_search",
            status: failTool ? "failed" : "completed",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: failTool
                    ? "Search failed: network timeout"
                    : "Found OpenCode 2.x AI SDK v3 docs.",
                },
              },
            ],
          },
        },
      });

      // 5. Final assistant message
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Here are the search findings." },
          },
        },
      });

      send({
        jsonrpc: "2.0",
        id,
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 20, outputTokens: 15, creditsUsed: 1.0 },
        },
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown method: ${method}` },
    });
  });
} else {
  process.exit(2);
}
