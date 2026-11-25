#!/usr/bin/env bun
/**
 * Faithful Mock `kiro-cli` executable for end-to-end ACP, auth, model discovery,
 * and credits testing without requiring a real Kiro installation or network.
 *
 * Behavior controlled via environment variables:
 * - MOCK_KIRO_AUTH: "1" (default) | "0" (unauthenticated)
 * - MOCK_KIRO_STATE_FILE: optional file path to persist login state across invocations
 * - MOCK_KIRO_CREDITS_USED: number (default 125.5)
 * - MOCK_KIRO_CREDITS_LIMIT: number (default 500)
 * - MOCK_KIRO_CRASH_ON_PROMPT: "1" to crash mid-prompt
 * - MOCK_KIRO_SLOW_MS: delay in ms for prompt streaming
 * - MOCK_KIRO_V3_CONFIG_ONLY: "1" to reject session/set_model and require session/set_config_option
 * - MOCK_KIRO_REQUEST_PERMISSION: "1" to send session/request_permission before completing prompt
 * - MOCK_KIRO_MODELS_FORMAT: "json" (default) | "text" | "invalid"
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as readline from "node:readline";

const args = process.argv.slice(2);
const stateFile = process.env.MOCK_KIRO_STATE_FILE;

function isAuthenticated(): boolean {
  if (stateFile && existsSync(stateFile)) {
    const content = readFileSync(stateFile, "utf8").trim();
    return content === "authenticated";
  }
  return process.env.MOCK_KIRO_AUTH !== "0";
}

function setAuthenticated(val: boolean): void {
  if (stateFile) {
    writeFileSync(stateFile, val ? "authenticated" : "unauthenticated", "utf8");
  }
}

const MODELS = [
  {
    id: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5 (Kiro)",
    description: "Balanced coding model routed through Kiro",
    contextWindow: 200000,
    maxOutputTokens: 16384,
    creditMultiplier: 1.3,
    reasoning: true,
    supportsTools: true,
    supportsVision: true,
    isDefault: true,
  },
  {
    id: "claude-opus-4.5",
    name: "Claude Opus 4.5 (Kiro)",
    description: "High-capability reasoning model routed through Kiro",
    contextWindow: 200000,
    maxOutputTokens: 32768,
    creditMultiplier: 2.5,
    reasoning: true,
    supportsTools: true,
    supportsVision: true,
    isDefault: false,
  },
  {
    id: "auto",
    name: "Kiro Auto",
    description: "Automatic model routing by Kiro",
    contextWindow: 200000,
    maxOutputTokens: 16384,
    creditMultiplier: 1.0,
    reasoning: true,
    supportsTools: true,
    supportsVision: false,
    isDefault: false,
  },
];

// Subcommand: `kiro-cli --version`
if (args.includes("--version") || args.includes("-v")) {
  console.log("kiro-cli 2.1.0-mock");
  process.exit(0);
}

// Subcommand: `kiro-cli login`
if (args[0] === "login") {
  if (process.env.MOCK_KIRO_LOGIN_FAIL === "1") {
    console.error("Login cancelled by user");
    process.exit(1);
  }
  setAuthenticated(true);
  console.log("Successfully logged in to Kiro (AWS Builder ID: dev@example.com)");
  process.exit(0);
}

// Subcommand: `kiro-cli whoami`
if (args[0] === "whoami") {
  if (!isAuthenticated()) {
    console.error("Not logged in. Run `kiro-cli login` to authenticate.");
    process.exit(1);
  }
  console.log("Logged in as dev@example.com (AWS Builder ID)");
  process.exit(0);
}

// Subcommand: `kiro-cli chat --list-models [--format json]`
if (args[0] === "chat" && args.includes("--list-models")) {
  const fmt = process.env.MOCK_KIRO_MODELS_FORMAT ?? (args.includes("json") ? "json" : "text");
  if (fmt === "invalid") {
    console.log("{not-valid-json");
    process.exit(0);
  }
  if (fmt === "text") {
    console.log("Available models:");
    console.log("  claude-sonnet-4.5  Claude Sonnet 4.5 (default)  1.3x credits");
    console.log("  claude-opus-4.5    Claude Opus 4.5              2.5x credits");
    console.log("  auto               Kiro Auto                    1.0x credits");
    process.exit(0);
  }
  console.log(JSON.stringify({ models: MODELS }));
  process.exit(0);
}

// Subcommand: `kiro-cli acp`
if (args[0] === "acp") {
  let creditsUsed = Number(process.env.MOCK_KIRO_CREDITS_USED ?? "125.5");
  const creditsLimit = Number(process.env.MOCK_KIRO_CREDITS_LIMIT ?? "500");
  const slowMs = Number(process.env.MOCK_KIRO_SLOW_MS ?? "5");
  const v3Only = process.env.MOCK_KIRO_V3_CONFIG_ONLY === "1";
  const askPermission = process.env.MOCK_KIRO_REQUEST_PERMISSION === "1";
  const crashOnPrompt = process.env.MOCK_KIRO_CRASH_ON_PROMPT === "1";

  const sessions = new Map<string, { modelId: string; cancelled: boolean }>();
  const pendingClientResponses = new Map<number, (msg: Record<string, unknown>) => void>();
  let serverReqId = 9000;

  function send(msg: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  function requestClient(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++serverReqId;
    return new Promise((resolve) => {
      pendingClientResponses.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    // Response to a server-initiated request (e.g. session/request_permission)
    if (!("method" in msg) && typeof msg.id === "number" && pendingClientResponses.has(msg.id)) {
      const resolve = pendingClientResponses.get(msg.id)!;
      pendingClientResponses.delete(msg.id);
      resolve(msg);
      return;
    }

    const id = msg.id as number | string | undefined;
    const method = msg.method as string;
    const params = (msg.params ?? {}) as Record<string, unknown>;

    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "kiro-cli-mock", version: "2.1.0" },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, embeddedContext: true },
          },
          authMethods: isAuthenticated()
            ? []
            : [
                {
                  id: "kiro-cli-login",
                  name: "Kiro CLI Login",
                  description: "Authenticate via `kiro-cli login`",
                  type: "cli",
                },
              ],
          models: MODELS,
        },
      });
      return;
    }

    if (method === "authenticate") {
      if (!isAuthenticated()) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32001, message: "Authentication required. Run `kiro-cli login`." },
        });
        return;
      }
      send({ jsonrpc: "2.0", id, result: { authenticated: true } });
      return;
    }

    if (method === "session/new") {
      if (!isAuthenticated()) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32001, message: "Unauthenticated: please run `kiro-cli login`" },
        });
        return;
      }
      const sessionId = `kiro-sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sessions.set(sessionId, { modelId: "claude-sonnet-4.5", cancelled: false });
      send({
        jsonrpc: "2.0",
        id,
        result: {
          sessionId,
          models: {
            currentModelId: "claude-sonnet-4.5",
            availableModels: MODELS,
          },
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "claude-sonnet-4.5",
              options: MODELS.map((m) => ({
                value: m.id,
                name: m.name,
                description: m.description,
              })),
            },
          ],
        },
      });
      return;
    }

    if (method === "session/set_model") {
      if (v3Only) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found: use session/set_config_option" },
        });
        return;
      }
      const sess = sessions.get(String(params.sessionId));
      if (!sess) {
        send({ jsonrpc: "2.0", id, error: { code: -32002, message: "Unknown session" } });
        return;
      }
      sess.modelId = String(params.modelId ?? sess.modelId);
      send({ jsonrpc: "2.0", id, result: { modelId: sess.modelId } });
      return;
    }

    if (method === "session/set_config_option") {
      const sess = sessions.get(String(params.sessionId));
      if (!sess) {
        send({ jsonrpc: "2.0", id, error: { code: -32002, message: "Unknown session" } });
        return;
      }
      if (params.configId === "model" && typeof params.value === "string") {
        sess.modelId = params.value;
      }
      send({ jsonrpc: "2.0", id, result: { ok: true, modelId: sess.modelId } });
      return;
    }

    if (method === "session/cancel") {
      const sess = sessions.get(String(params.sessionId));
      if (sess) sess.cancelled = true;
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, result: { cancelled: true } });
      }
      return;
    }

    if (method === "_kiro/account/getUsage") {
      if (!isAuthenticated()) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32001, message: "Unauthenticated" },
        });
        return;
      }
      send({
        jsonrpc: "2.0",
        id,
        result: {
          creditsUsed,
          creditsLimit,
          creditsRemaining: Math.max(0, creditsLimit - creditsUsed),
          addonCreditsRemaining: 50,
          planName: "Pro",
          resetAt: "2026-12-01T00:00:00.000Z",
        },
      });
      return;
    }

    if (method === "session/prompt") {
      const sessionId = String(params.sessionId);
      const sess = sessions.get(sessionId);
      if (!sess) {
        send({ jsonrpc: "2.0", id, error: { code: -32002, message: "Unknown session" } });
        return;
      }
      sess.cancelled = false;

      if (crashOnPrompt) {
        process.stderr.write("fatal: simulated kiro-cli crash\n");
        process.exit(137);
      }

      const promptBlocks = (params.prompt as Array<{ type: string; text?: string }>) ?? [];
      const userText = promptBlocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");

      // Emit thought chunk
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: `Thinking with ${sess.modelId}...` },
          },
        },
      });

      if (askPermission) {
        const permResp = await requestClient("session/request_permission", {
          sessionId,
          toolCall: {
            toolCallId: "tc-perm-1",
            title: "Run shell command",
            kind: "execute",
            rawInput: { command: "echo hi" },
          },
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject_once", name: "Reject", kind: "reject_once" },
          ],
        });
        const outcome = (permResp.result as { outcome?: { outcome?: string; optionId?: string } })?.outcome;
        if (outcome?.optionId === "reject_once" || outcome?.outcome === "cancelled") {
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Permission denied by client." },
              },
            },
          });
        }
      }

      const chunks = [`[kiro:${sess.modelId}] `, `Echo: ${userText}`];
      for (const chunk of chunks) {
        if (slowMs > 0) {
          await new Promise((r) => setTimeout(r, slowMs));
        }
        if (sess.cancelled) {
          send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
          return;
        }
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: chunk },
            },
          },
        });
      }

      const turnCredits = 1.5;
      creditsUsed += turnCredits;

      // Emit _kiro.dev/metadata extension notification
      send({
        jsonrpc: "2.0",
        method: "_kiro.dev/metadata",
        params: {
          sessionId,
          contextUsagePercentage: 18.4,
          creditsUsed,
          creditsLimit,
          lastTurnCredits: turnCredits,
          planName: "Pro",
          resetAt: "2026-12-01T00:00:00.000Z",
          activeModel: sess.modelId,
        },
      });

      send({
        jsonrpc: "2.0",
        id,
        result: {
          stopReason: "end_turn",
          usage: {
            inputTokens: Math.max(1, userText.length),
            outputTokens: 12,
            creditsUsed: turnCredits,
          },
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
  console.error(`Unknown mock kiro-cli command: ${args.join(" ")}`);
  process.exit(2);
}
