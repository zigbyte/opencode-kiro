/**
 * Adversarial test suite for `src/acp/` (JSON-RPC framing, process supervisor,
 * ACP client lifecycle, protocol compliance, and security invariants).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AcpAuthRequiredError,
  AcpClient,
  AcpTransportError,
  JSON_RPC_METHOD_NOT_FOUND,
  JsonRpcAbortedError,
  JsonRpcDispatcher,
  JsonRpcLineBuffer,
  JsonRpcResponseError,
  JsonRpcTimeoutError,
  KiroProcessSupervisor,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  serializeJsonRpc,
} from "../src/acp";
import type {
  AcpSessionUpdateParams,
  JsonRpcMessage,
  JsonRpcRequest,
} from "../src/types";

const MOCK_CLI_PATH = resolve(import.meta.dir, "fixtures/mock-kiro-cli.ts");
const SRC_ACP_DIR = resolve(import.meta.dir, "../src/acp");

const tempDirs: string[] = [];
const activeClients: AcpClient[] = [];
const activeSupervisors: KiroProcessSupervisor[] = [];

function makeTempDir(prefix = "opencode-kiro-adv-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTempScript(filename: string, code: string): string {
  const dir = makeTempDir();
  const filePath = join(dir, filename);
  writeFileSync(filePath, code, "utf8");
  return filePath;
}

function trackClient(client: AcpClient): AcpClient {
  activeClients.push(client);
  return client;
}

function trackSupervisor(sup: KiroProcessSupervisor): KiroProcessSupervisor {
  activeSupervisors.push(sup);
  return sup;
}

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(overrides)) {
    prev.set(k, process.env[k]);
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of prev.entries()) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

afterEach(async () => {
  while (activeClients.length > 0) {
    const client = activeClients.pop()!;
    await client.dispose().catch(() => {});
  }
  while (activeSupervisors.length > 0) {
    const sup = activeSupervisors.pop()!;
    await sup.stop(200).catch(() => {});
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 1. Framing Attacks (JsonRpcLineBuffer)
// ===========================================================================

describe("Framing Attacks: JsonRpcLineBuffer", () => {
  test("reassembles 4-byte UTF-8 emojis and 3-byte CJK split byte-by-byte across chunks", () => {
    const messages: JsonRpcMessage[] = [];
    const errors: Array<{ error: Error; raw: string }> = [];
    const buf = new JsonRpcLineBuffer({
      onMessage: (m) => messages.push(m),
      onParseError: (error, raw) => errors.push({ error, raw }),
    });

    const payload = {
      jsonrpc: "2.0" as const,
      method: "session/update",
      params: {
        sessionId: "s-utf8",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Hello 🚀🔥👨‍👩‍👧‍👦 日本語テスト 中文测试 한국어 🎉",
          },
        },
      },
    };
    const encoded = new TextEncoder().encode(serializeJsonRpc(payload));

    // Push 1 single byte at a time to split every multi-byte sequence
    for (let i = 0; i < encoded.length; i++) {
      buf.push(encoded.subarray(i, i + 1));
    }

    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(payload);
  });

  test("handles multiple JSON-RPC messages coalesced in one chunk with mixed LF/CRLF and empty lines", () => {
    const messages: JsonRpcMessage[] = [];
    const errors: Error[] = [];
    const buf = new JsonRpcLineBuffer({
      onMessage: (m) => messages.push(m),
      onParseError: (err) => errors.push(err),
    });

    const m1: JsonRpcMessage = { jsonrpc: "2.0", id: 1, result: { ok: true } };
    const m2: JsonRpcMessage = { jsonrpc: "2.0", method: "session/update", params: { a: 1 } };
    const m3: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "session/request_permission", params: {} };

    const chunk =
      "\n\r\n   \t  \n" +
      JSON.stringify(m1) + "\r\n" +
      "\n\n" +
      JSON.stringify(m2) + "\n" +
      "   \r\n" +
      JSON.stringify(m3) + "\r\n\n";

    buf.push(Buffer.from(chunk, "utf8"));

    expect(errors).toHaveLength(0);
    expect(messages).toEqual([m1, m2, m3]);
  });

  test("isolates malformed JSON and non-JSON-RPC lines without poisoning surrounding valid frames", () => {
    const messages: JsonRpcMessage[] = [];
    const parseErrors: string[] = [];
    const buf = new JsonRpcLineBuffer({
      onMessage: (m) => messages.push(m),
      onParseError: (_err, raw) => parseErrors.push(raw),
    });

    const valid1: JsonRpcMessage = { jsonrpc: "2.0", id: 1, result: "before" };
    const valid2: JsonRpcMessage = { jsonrpc: "2.0", id: 2, result: "after" };

    const stream = [
      JSON.stringify(valid1),
      "{not valid json",
      "plain debug log from child stdout",
      "42",
      "[]",
      JSON.stringify({ jsonrpc: "1.0", id: 9, result: "wrong-version" }),
      JSON.stringify({ jsonrpc: "2.0", id: 10 }), // missing result/error/method
      JSON.stringify(valid2),
    ].join("\n") + "\n";

    buf.push(stream);

    expect(messages).toEqual([valid1, valid2]);
    expect(parseErrors).toHaveLength(6);
  });

  test("flushes trailing partial frame without trailing newline on EOF", () => {
    const messages: JsonRpcMessage[] = [];
    const buf = new JsonRpcLineBuffer({
      onMessage: (m) => messages.push(m),
    });

    const msg: JsonRpcMessage = { jsonrpc: "2.0", id: 99, result: { eof: true } };
    buf.push(JSON.stringify(msg)); // no trailing \n
    expect(messages).toHaveLength(0);

    buf.flush();
    expect(messages).toEqual([msg]);
  });

  test("handles oversized 2MB single JSON-RPC payload split across 16KB chunks", () => {
    const messages: JsonRpcMessage[] = [];
    const errors: Error[] = [];
    const buf = new JsonRpcLineBuffer({
      onMessage: (m) => messages.push(m),
      onParseError: (err) => errors.push(err),
    });

    const hugeText = "A".repeat(2 * 1024 * 1024);
    const frame = Buffer.from(
      serializeJsonRpc({
        jsonrpc: "2.0",
        id: 1,
        result: { text: hugeText },
      }),
      "utf8"
    );

    const chunkSize = 16 * 1024;
    for (let offset = 0; offset < frame.length; offset += chunkSize) {
      buf.push(frame.subarray(offset, offset + chunkSize));
    }

    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(1);
    const res = messages[0] as { result: { text: string } };
    expect(res.result.text.length).toBe(2 * 1024 * 1024);
  });

  test("type guards reject malformed id/method/response shapes", () => {
    const reqWithNullId = { jsonrpc: "2.0", id: null, method: "foo" } as unknown as JsonRpcMessage;
    expect(isJsonRpcRequest(reqWithNullId)).toBe(false);
    expect(isJsonRpcNotification(reqWithNullId)).toBe(false);

    const validReq: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect(isJsonRpcRequest(validReq)).toBe(true);
    expect(isJsonRpcNotification(validReq)).toBe(false);
    expect(isJsonRpcResponse(validReq)).toBe(false);

    const validNotif: JsonRpcMessage = { jsonrpc: "2.0", method: "notify" };
    expect(isJsonRpcNotification(validNotif)).toBe(true);
    expect(isJsonRpcRequest(validNotif)).toBe(false);

    const validResp: JsonRpcMessage = { jsonrpc: "2.0", id: 1, result: null };
    expect(isJsonRpcResponse(validResp)).toBe(true);
  });

  test("throwing onMessage listener must not strand subsequent lines in the same chunk", () => {
    const delivered: JsonRpcMessage[] = [];
    let callCount = 0;
    const buf = new JsonRpcLineBuffer({
      onMessage: (m) => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("listener boom");
        }
        delivered.push(m);
      },
    });

    const m1: JsonRpcMessage = { jsonrpc: "2.0", id: 1, result: "first" };
    const m2: JsonRpcMessage = { jsonrpc: "2.0", id: 2, result: "second" };
    const chunk = `${JSON.stringify(m1)}\n${JSON.stringify(m2)}\n`;

    // Even if line 1 throws, line 2 in the same chunk should not be stranded
    try {
      buf.push(chunk);
    } catch {
      // Expected if push propagates listener error
    }
    expect(delivered).toEqual([m2]);
  });
});

// ===========================================================================
// 2. Dispatcher & Concurrency Attacks (JsonRpcDispatcher)
// ===========================================================================

describe("Concurrency & Timeout Attacks: JsonRpcDispatcher", () => {
  test("correlates out-of-order responses for concurrent requests", async () => {
    const dispatcher = new JsonRpcDispatcher({ defaultTimeoutMs: 5_000 });
    const sent: JsonRpcRequest[] = [];

    const p1 = dispatcher.sendRequest<string>((r) => sent.push(r), "m1");
    const p2 = dispatcher.sendRequest<string>((r) => sent.push(r), "m2");
    const p3 = dispatcher.sendRequest<string>((r) => sent.push(r), "m3");

    expect(dispatcher.pendingCount).toBe(3);

    // Respond in reverse order (3, 1, 2) with an error on 2
    dispatcher.handleResponse({ jsonrpc: "2.0", id: sent[2].id, result: "r3" });
    dispatcher.handleResponse({ jsonrpc: "2.0", id: sent[0].id, result: "r1" });
    dispatcher.handleResponse({
      jsonrpc: "2.0",
      id: sent[1].id,
      error: { code: -32603, message: "boom" },
    });

    expect(await p1).toBe("r1");
    expect(await p3).toBe("r3");
    await expect(p2).rejects.toThrow(JsonRpcResponseError);
    expect(dispatcher.pendingCount).toBe(0);
  });

  test("rejects with JsonRpcTimeoutError and cleans up pending map", async () => {
    const dispatcher = new JsonRpcDispatcher({ defaultTimeoutMs: 5_000 });

    const p = dispatcher.sendRequest(() => {}, "slow/method", undefined, {
      timeoutMs: 40,
    });
    expect(dispatcher.pendingCount).toBe(1);

    await expect(p).rejects.toThrow(JsonRpcTimeoutError);
    expect(dispatcher.pendingCount).toBe(0);
  });

  test("handles pre-aborted and mid-flight AbortSignal without leaking pending requests", async () => {
    const dispatcher = new JsonRpcDispatcher({ defaultTimeoutMs: 5_000 });

    // Pre-aborted
    const preCtrl = new AbortController();
    preCtrl.abort("already-dead");
    let sendCalled = false;
    await expect(
      dispatcher.sendRequest(
        () => {
          sendCalled = true;
        },
        "pre/abort",
        undefined,
        { signal: preCtrl.signal }
      )
    ).rejects.toThrow(JsonRpcAbortedError);
    expect(sendCalled).toBe(false);
    expect(dispatcher.pendingCount).toBe(0);

    // Mid-flight abort
    const midCtrl = new AbortController();
    let capturedId: number | string = 0;
    const p = dispatcher.sendRequest(
      (req) => {
        capturedId = req.id;
      },
      "mid/abort",
      undefined,
      { signal: midCtrl.signal }
    );
    expect(dispatcher.pendingCount).toBe(1);
    midCtrl.abort("user-cancelled");

    await expect(p).rejects.toThrow(JsonRpcAbortedError);
    expect(dispatcher.pendingCount).toBe(0);

    // Late response after abort must be ignored cleanly
    expect(
      dispatcher.handleResponse({ jsonrpc: "2.0", id: capturedId, result: "late" })
    ).toBe(false);
  });

  test("rejects and cleans up if synchronous send() throws", async () => {
    const dispatcher = new JsonRpcDispatcher();
    const p = dispatcher.sendRequest(() => {
      throw new Error("EPIPE broken pipe");
    }, "broken/write");

    await expect(p).rejects.toThrow("EPIPE broken pipe");
    expect(dispatcher.pendingCount).toBe(0);
  });

  test("rejectAll rejects every pending request immediately", async () => {
    const dispatcher = new JsonRpcDispatcher({ defaultTimeoutMs: 60_000 });
    const p1 = dispatcher.sendRequest(() => {}, "a");
    const p2 = dispatcher.sendRequest(() => {}, "b");
    expect(dispatcher.pendingCount).toBe(2);

    dispatcher.rejectAll(new Error("subprocess died"));
    expect(dispatcher.pendingCount).toBe(0);

    await expect(p1).rejects.toThrow("subprocess died");
    await expect(p2).rejects.toThrow("subprocess died");
  });
});

// ===========================================================================
// 3. Lifecycle, Crash, Timeout, Cancellation & Zombie Prevention
// ===========================================================================

describe("Lifecycle & Concurrency Attacks: AcpClient + KiroProcessSupervisor", () => {
  test("subprocess crash mid-session/prompt rejects pending promise promptly (never hangs)", async () => {
    await withEnv({ MOCK_KIRO_AUTH: "1", MOCK_KIRO_CRASH_ON_PROMPT: "1" }, async () => {
      const client = trackClient(
        new AcpClient({
          cliPath: MOCK_CLI_PATH,
          requestTimeoutMs: 10_000,
        })
      );

      await client.connect();
      const session = await client.newSession();

      const startedAt = Date.now();
      let caught: unknown;
      try {
        await client.prompt(session.sessionId, [{ type: "text", text: "trigger crash" }]);
      } catch (err) {
        caught = err;
      }
      const elapsedMs = Date.now() - startedAt;

      expect(caught).toBeInstanceOf(AcpTransportError);
      expect(elapsedMs).toBeLessThan(2_000);
      expect(client.isConnected()).toBe(false);
    });
  });

  test("request timeout during slow session/prompt rejects cleanly", async () => {
    await withEnv(
      { MOCK_KIRO_AUTH: "1", MOCK_KIRO_CRASH_ON_PROMPT: "0", MOCK_KIRO_SLOW_MS: "2000" },
      async () => {
        const client = trackClient(
          new AcpClient({
            cliPath: MOCK_CLI_PATH,
            requestTimeoutMs: 10_000,
          })
        );

        await client.connect();
        const session = await client.newSession();

        const startedAt = Date.now();
        let caught: unknown;
        try {
          await client.prompt(
            session.sessionId,
            [{ type: "text", text: "slow prompt" }],
            { timeoutMs: 80 }
          );
        } catch (err) {
          caught = err;
        }
        const elapsedMs = Date.now() - startedAt;

        expect(caught).toBeInstanceOf(AcpTransportError);
        expect((caught as Error).message).toMatch(/timed out/i);
        expect(elapsedMs).toBeLessThan(1_500);
      }
    );
  });

  test("AbortSignal during slow session/prompt sends session/cancel and rejects cleanly", async () => {
    const cancelLogFile = join(makeTempDir(), "cancel-log.json");
    const spyServer = writeTempScript(
      "cancel-spy-acp.ts",
      `
import { writeFileSync } from "node:fs";
import * as readline from "node:readline";

const logFile = ${JSON.stringify(cancelLogFile)};
const received: string[] = [];
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(msg: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

let cancelled = false;
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  received.push(msg.method ?? "response");
  writeFileSync(logFile, JSON.stringify(received), "utf8");

  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-cancel-1" } });
  } else if (msg.method === "session/cancel") {
    cancelled = true;
  } else if (msg.method === "session/prompt") {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (cancelled) {
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "cancelled" } });
        return;
      }
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`
    );

    const client = trackClient(
      new AcpClient({
        cliPath: spyServer,
        requestTimeoutMs: 10_000,
      })
    );

    await client.connect();
    const session = await client.newSession();

    const controller = new AbortController();
    setTimeout(() => controller.abort("user-hit-ctrl-c"), 50);

    const startedAt = Date.now();
    await expect(
      client.prompt(
        session.sessionId,
        [{ type: "text", text: "long running prompt" }],
        { signal: controller.signal }
      )
    ).rejects.toThrow(AcpTransportError);

    expect(Date.now() - startedAt).toBeLessThan(1_000);

    // Give child process a brief moment to read session/cancel from stdin and flush log
    await new Promise((r) => setTimeout(r, 80));
    expect(existsSync(cancelLogFile)).toBe(true);
    const methods = JSON.parse(readFileSync(cancelLogFile, "utf8")) as string[];
    expect(methods).toContain("session/cancel");
  });

  test("dispose() kills child subprocess cleanly without leaving zombie processes", async () => {
    const sup = trackSupervisor(
      new KiroProcessSupervisor({
        cliPath: MOCK_CLI_PATH,
        gracefulShutdownMs: 300,
      })
    );

    sup.start();
    const pid = sup.pid;
    expect(typeof pid).toBe("number");
    expect(sup.isRunning()).toBe(true);

    // Verify process exists
    expect(() => process.kill(pid!, 0)).not.toThrow();

    await sup.stop();
    expect(sup.isRunning()).toBe(false);
    expect(sup.pid).toBeUndefined();

    // Verify OS process is gone (ESRCH)
    let stillAlive = true;
    try {
      process.kill(pid!, 0);
    } catch {
      stillAlive = false;
    }
    expect(stillAlive).toBe(false);

    // Idempotent second stop
    await sup.stop();
  });

  test("escalates to SIGKILL when child ignores SIGTERM", async () => {
    const stubbornScript = writeTempScript(
      "ignore-sigterm.ts",
      `
process.on("SIGTERM", () => {
  // Intentionally ignore SIGTERM
});
setInterval(() => {}, 1000);
`
    );

    const sup = trackSupervisor(
      new KiroProcessSupervisor({
        cliPath: stubbornScript,
        gracefulShutdownMs: 100,
      })
    );

    sup.start();
    const pid = sup.pid!;
    expect(typeof pid).toBe("number");

    // Wait briefly so the child registers its SIGTERM handler
    await new Promise((r) => setTimeout(r, 80));

    const startedAt = Date.now();
    await sup.stop(100);
    const elapsedMs = Date.now() - startedAt;

    expect(sup.isRunning()).toBe(false);
    expect(elapsedMs).toBeLessThan(1_500);

    let stillAlive = true;
    try {
      process.kill(pid, 0);
    } catch {
      stillAlive = false;
    }
    expect(stillAlive).toBe(false);
  });

  test("deduplicates concurrent connect() calls", async () => {
    await withEnv({ MOCK_KIRO_AUTH: "1" }, async () => {
      const client = trackClient(
        new AcpClient({ cliPath: MOCK_CLI_PATH, requestTimeoutMs: 5_000 })
      );

      const results = await Promise.all([
        client.connect(),
        client.connect(),
        client.connect(),
        client.connect(),
      ]);

      expect(results[0].protocolVersion).toBe(1);
      for (const res of results) {
        expect(res).toBe(results[0]);
      }
      expect(client.isConnected()).toBe(true);
    });
  });

  test("nonexistent cliPath (ENOENT) fails fast without hanging in supervisor.stop()", async () => {
    const client = trackClient(
      new AcpClient({
        cliPath: "/nonexistent/path/kiro-cli-does-not-exist-99999",
        requestTimeoutMs: 5_000,
      })
    );

    const startedAt = Date.now();
    await expect(client.connect()).rejects.toThrow(AcpTransportError);
    const elapsedMs = Date.now() - startedAt;

    // BUG PROBE: supervisor.ts:171-176 doesn't clear this.child on ENOENT error,
    // and stop() doesn't check the boolean return value of proc.kill("SIGTERM"),
    // which can cause a 4-second hang (3000ms graceful + 1000ms hardTimer)!
    expect(elapsedMs).toBeLessThan(1_500);
  });
});

// ===========================================================================
// 4. Protocol Compliance
// ===========================================================================

describe("Protocol Compliance: ACP Handshake, Auth, Model Fallback, Permissions & Extensions", () => {
  test("initialize, session/new, session/prompt streaming, _kiro.dev/metadata, and _kiro/account/getUsage", async () => {
    await withEnv(
      {
        MOCK_KIRO_AUTH: "1",
        MOCK_KIRO_CREDITS_USED: "125.5",
        MOCK_KIRO_CREDITS_LIMIT: "500",
        MOCK_KIRO_SLOW_MS: "5",
        MOCK_KIRO_CRASH_ON_PROMPT: "0",
        MOCK_KIRO_REQUEST_PERMISSION: "0",
      },
      async () => {
        const client = trackClient(
          new AcpClient({ cliPath: MOCK_CLI_PATH, requestTimeoutMs: 5_000 })
        );

        const init = await client.connect();
        expect(init.protocolVersion).toBe(1);
        expect(init.agentInfo?.name).toBe("kiro-cli-mock");
        expect(init.models?.length).toBeGreaterThanOrEqual(3);

        const metadataEvents: Array<Record<string, unknown>> = [];
        const unsubMeta = client.onMetadata((m) => metadataEvents.push(m));

        const session = await client.newSession("/tmp");
        expect(session.sessionId).toMatch(/^kiro-sess-/);

        const updates: AcpSessionUpdateParams[] = [];
        const result = await client.prompt(
          session.sessionId,
          [{ type: "text", text: "Hello Kiro 🚀" }],
          { onUpdate: (u) => updates.push(u) }
        );
        unsubMeta();

        expect(result.stopReason).toBe("end_turn");
        expect(updates.some((u) => u.update.sessionUpdate === "agent_thought_chunk")).toBe(true);
        const messageText = updates
          .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
          .map((u) => u.update.content?.text ?? "")
          .join("");
        expect(messageText).toContain("Echo: Hello Kiro 🚀");

        // _kiro.dev/metadata received
        expect(metadataEvents.length).toBeGreaterThanOrEqual(1);
        expect(metadataEvents[0].creditsUsed).toBe(127);
        expect(metadataEvents[0].creditsLimit).toBe(500);
        expect(metadataEvents[0].contextUsagePercentage).toBe(18.4);

        // _kiro/account/getUsage
        const usage = await client.getUsage();
        expect(usage).not.toBeNull();
        expect(usage?.creditsUsed).toBe(127);
        expect(usage?.creditsLimit).toBe(500);
        expect(usage?.planName).toBe("Pro");
      }
    );
  });

  test("session/new throws AcpAuthRequiredError with authMethods when unauthenticated", async () => {
    await withEnv({ MOCK_KIRO_AUTH: "0" }, async () => {
      const client = trackClient(
        new AcpClient({ cliPath: MOCK_CLI_PATH, requestTimeoutMs: 5_000 })
      );

      const init = await client.connect();
      expect(init.authMethods?.length).toBeGreaterThan(0);

      let caught: unknown;
      try {
        await client.newSession();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AcpAuthRequiredError);
      const authErr = caught as AcpAuthRequiredError;
      expect(authErr.code).toBe(-32001);
      expect(authErr.authMethods.length).toBeGreaterThan(0);
      expect(authErr.authMethods[0].id).toBe("kiro-cli-login");
    });
  });

  test("session/set_model transparently falls back to session/set_config_option on -32601 (Kiro CLI v3)", async () => {
    await withEnv(
      {
        MOCK_KIRO_AUTH: "1",
        MOCK_KIRO_V3_CONFIG_ONLY: "1",
        MOCK_KIRO_SLOW_MS: "0",
        MOCK_KIRO_CRASH_ON_PROMPT: "0",
        MOCK_KIRO_REQUEST_PERMISSION: "0",
      },
      async () => {
        const client = trackClient(
          new AcpClient({ cliPath: MOCK_CLI_PATH, requestTimeoutMs: 5_000 })
        );

        await client.connect();
        const session = await client.newSession();
        await client.setModel(session.sessionId, "claude-opus-4.5");

        const chunks: string[] = [];
        await client.prompt(
          session.sessionId,
          [{ type: "text", text: "check model" }],
          {
            onUpdate: (u) => {
              if (u.update.sessionUpdate === "agent_message_chunk" && u.update.content?.text) {
                chunks.push(u.update.content.text);
              }
            },
          }
        );

        expect(chunks.join("")).toContain("[kiro:claude-opus-4.5]");
      }
    );
  });

  test("session/request_permission enforces deny_by_default, allow_read_only, and allow_once policies", async () => {
    // 1. deny_by_default denies execute tool
    await withEnv(
      {
        MOCK_KIRO_AUTH: "1",
        MOCK_KIRO_REQUEST_PERMISSION: "1",
        MOCK_KIRO_SLOW_MS: "0",
        MOCK_KIRO_CRASH_ON_PROMPT: "0",
      },
      async () => {
        const client = trackClient(
          new AcpClient({
            cliPath: MOCK_CLI_PATH,
            permissionPolicy: "deny_by_default",
          })
        );
        await client.connect();
        const sess = await client.newSession();
        const text: string[] = [];
        await client.prompt(sess.sessionId, [{ type: "text", text: "run" }], {
          onUpdate: (u) => {
            if (u.update.content?.text) text.push(u.update.content.text);
          },
        });
        expect(text.join("")).toContain("Permission denied by client.");
      }
    );

    // 2. allow_read_only DENIES execute tool
    await withEnv(
      {
        MOCK_KIRO_AUTH: "1",
        MOCK_KIRO_REQUEST_PERMISSION: "1",
        MOCK_KIRO_SLOW_MS: "0",
        MOCK_KIRO_CRASH_ON_PROMPT: "0",
      },
      async () => {
        const client = trackClient(
          new AcpClient({
            cliPath: MOCK_CLI_PATH,
            permissionPolicy: "allow_read_only",
          })
        );
        await client.connect();
        const sess = await client.newSession();
        const text: string[] = [];
        await client.prompt(sess.sessionId, [{ type: "text", text: "run" }], {
          onUpdate: (u) => {
            if (u.update.content?.text) text.push(u.update.content.text);
          },
        });
        expect(text.join("")).toContain("Permission denied by client.");
      }
    );

    // 3. allow_once ALLOWS execute tool
    await withEnv(
      {
        MOCK_KIRO_AUTH: "1",
        MOCK_KIRO_REQUEST_PERMISSION: "1",
        MOCK_KIRO_SLOW_MS: "0",
        MOCK_KIRO_CRASH_ON_PROMPT: "0",
      },
      async () => {
        const client = trackClient(
          new AcpClient({
            cliPath: MOCK_CLI_PATH,
            permissionPolicy: "allow_once",
          })
        );
        await client.connect();
        const sess = await client.newSession();
        const text: string[] = [];
        await client.prompt(sess.sessionId, [{ type: "text", text: "run" }], {
          onUpdate: (u) => {
            if (u.update.content?.text) text.push(u.update.content.text);
          },
        });
        expect(text.join("")).not.toContain("Permission denied by client.");
        expect(text.join("")).toContain("Echo: run");
      }
    );
  });

  test("allow_read_only allows kind='read', denies kind='write', and allow_once refuses to escalate to allow_always", async () => {
    const outcomesFile = join(makeTempDir(), "perm-outcomes.json");
    const permServer = writeTempScript(
      "perm-policy-acp.ts",
      `
import { writeFileSync } from "node:fs";
import * as readline from "node:readline";

const outcomesFile = ${JSON.stringify(outcomesFile)};
const pending = new Map<number, (msg: Record<string, unknown>) => void>();
let nextId = 500;

function send(msg: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}
function ask(method: string, params: Record<string, unknown>) {
  const id = ++nextId;
  return new Promise<Record<string, unknown>>((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (!("method" in msg) && typeof msg.id === "number" && pending.has(msg.id)) {
    const res = pending.get(msg.id)!;
    pending.delete(msg.id);
    res(msg);
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-perm" } });
  } else if (msg.method === "session/prompt") {
    const mode = (msg.params?.prompt?.[0]?.text ?? "") as string;
    let permResp: Record<string, unknown>;
    if (mode === "read") {
      permResp = await ask("session/request_permission", {
        sessionId: "s-perm",
        toolCall: { toolCallId: "t1", kind: "read", title: "Read file" },
        options: [
          { optionId: "opt_allow", name: "Allow", kind: "allow_once" },
          { optionId: "opt_reject", name: "Reject", kind: "reject_once" },
        ],
      });
    } else if (mode === "only_allow_always") {
      permResp = await ask("session/request_permission", {
        sessionId: "s-perm",
        toolCall: { toolCallId: "t2", kind: "execute", title: "Exec" },
        options: [
          { optionId: "opt_always", name: "Allow Always", kind: "allow_always" },
          { optionId: "opt_reject", name: "Reject", kind: "reject_once" },
        ],
      });
    } else {
      permResp = await ask("session/request_permission", {
        sessionId: "s-perm",
        toolCall: { toolCallId: "t3", kind: "write", title: "Write file" },
        options: [
          { optionId: "opt_allow", name: "Allow", kind: "allow_once" },
          { optionId: "opt_reject", name: "Reject", kind: "reject_once" },
        ],
      });
    }
    writeFileSync(outcomesFile, JSON.stringify(permResp), "utf8");
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`
    );

    // Test allow_read_only with kind="read" -> allowed
    const roClient = trackClient(
      new AcpClient({ cliPath: permServer, permissionPolicy: "allow_read_only" })
    );
    await roClient.connect();
    const s1 = await roClient.newSession();
    await roClient.prompt(s1.sessionId, [{ type: "text", text: "read" }]);
    let resp = JSON.parse(readFileSync(outcomesFile, "utf8"));
    expect(resp.result.outcome).toEqual({ outcome: "selected", optionId: "opt_allow" });

    // Test allow_read_only with kind="write" -> rejected
    await roClient.prompt(s1.sessionId, [{ type: "text", text: "write" }]);
    resp = JSON.parse(readFileSync(outcomesFile, "utf8"));
    expect(resp.result.outcome).toEqual({ outcome: "selected", optionId: "opt_reject" });
    await roClient.dispose();

    // Test allow_once when only allow_always is offered -> must NOT pick allow_always
    const aoClient = trackClient(
      new AcpClient({ cliPath: permServer, permissionPolicy: "allow_once" })
    );
    await aoClient.connect();
    const s2 = await aoClient.newSession();
    await aoClient.prompt(s2.sessionId, [{ type: "text", text: "only_allow_always" }]);
    resp = JSON.parse(readFileSync(outcomesFile, "utf8"));
    expect(resp.result.outcome).toEqual({ outcome: "selected", optionId: "opt_reject" });
  });

  test("malformed null entry in session/request_permission options degrades to deny/cancel instead of -32603 crash", async () => {
    const outcomesFile = join(makeTempDir(), "perm-malformed.json");
    const malformedPermServer = writeTempScript(
      "malformed-perm-acp.ts",
      `
import { writeFileSync } from "node:fs";
import * as readline from "node:readline";

const outcomesFile = ${JSON.stringify(outcomesFile)};
const pending = new Map<number, (msg: Record<string, unknown>) => void>();
let nextId = 700;

function send(msg: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (!("method" in msg) && typeof msg.id === "number" && pending.has(msg.id)) {
    const res = pending.get(msg.id)!;
    pending.delete(msg.id);
    res(msg);
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-mal" } });
  } else if (msg.method === "session/prompt") {
    const reqId = ++nextId;
    const permResp = await new Promise<Record<string, unknown>>((resolve) => {
      pending.set(reqId, resolve);
      send({
        jsonrpc: "2.0",
        id: reqId,
        method: "session/request_permission",
        params: {
          sessionId: "s-mal",
          toolCall: { toolCallId: "t1", kind: "execute" },
          options: [null, { optionId: "opt_reject", name: "Reject", kind: "reject_once" }],
        },
      });
    });
    writeFileSync(outcomesFile, JSON.stringify(permResp), "utf8");
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`
    );

    const client = trackClient(
      new AcpClient({ cliPath: malformedPermServer, permissionPolicy: "deny_by_default" })
    );
    await client.connect();
    const s = await client.newSession();
    await client.prompt(s.sessionId, [{ type: "text", text: "go" }]);

    const resp = JSON.parse(readFileSync(outcomesFile, "utf8"));
    expect(resp.error).toBeUndefined();
    expect(resp.result?.outcome).toEqual({ outcome: "selected", optionId: "opt_reject" });
  });

  test("allow_read_only boundary: allows read-only kinds (incl. uppercase/whitespace) and denies mutating/exec/compound/empty/missing kinds", async () => {
    const resultsFile = join(makeTempDir(), "allow-ro-boundary.json");
    const allowedKinds: Array<string> = [
      "search",
      "web_search",
      "fetch",
      "read",
      "list",
      "grep",
      "glob",
      "  SEARCH  ",
      "\tWeb_Search\n",
      "  FETCH ",
      "READ",
    ];
    const deniedKinds: Array<string | undefined> = [
      "write",
      "edit",
      "delete",
      "execute",
      "shell",
      "bash",
      "terminal",
      "run",
      "read_write",
      "search_and_delete",
      "",
      "   ",
      undefined,
    ];

    const boundaryServer = writeTempScript(
      "allow-ro-boundary-acp.ts",
      `
import { writeFileSync } from "node:fs";
import * as readline from "node:readline";

const resultsFile = ${JSON.stringify(resultsFile)};
const cases: Array<{ label: string; kind?: string; expectAllow: boolean }> = [
  ...${JSON.stringify(allowedKinds)}.map((k: string) => ({ label: JSON.stringify(k), kind: k, expectAllow: true })),
  ...${JSON.stringify(deniedKinds.map((k) => (k === undefined ? "__MISSING__" : k)))}.map((k: string) => ({
    label: k === "__MISSING__" ? "<missing>" : JSON.stringify(k),
    kind: k === "__MISSING__" ? undefined : k,
    expectAllow: false,
  })),
];

const pending = new Map<number, (msg: Record<string, unknown>) => void>();
let nextId = 1200;

function send(msg: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}
function ask(method: string, params: Record<string, unknown>) {
  const id = ++nextId;
  return new Promise<Record<string, unknown>>((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (!("method" in msg) && typeof msg.id === "number" && pending.has(msg.id)) {
    const res = pending.get(msg.id)!;
    pending.delete(msg.id);
    res(msg);
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-boundary" } });
  } else if (msg.method === "session/prompt") {
    const records: Array<{ label: string; expectAllow: boolean; response: Record<string, unknown> }> = [];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const toolCall: Record<string, unknown> = { toolCallId: "tc-" + i, title: "Test " + c.label };
      if (c.kind !== undefined) {
        toolCall.kind = c.kind;
      }
      const resp = await ask("session/request_permission", {
        sessionId: "s-boundary",
        toolCall,
        options: [
          { optionId: "opt_allow", name: "Allow Once", kind: "allow_once" },
          { optionId: "opt_reject", name: "Reject Once", kind: "reject_once" },
        ],
      });
      records.push({ label: c.label, expectAllow: c.expectAllow, response: resp });
    }
    writeFileSync(resultsFile, JSON.stringify(records), "utf8");
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`
    );

    const client = trackClient(
      new AcpClient({ cliPath: boundaryServer, permissionPolicy: "allow_read_only" })
    );
    await client.connect();
    const s = await client.newSession();
    await client.prompt(s.sessionId, [{ type: "text", text: "run boundary matrix" }]);

    const records = JSON.parse(readFileSync(resultsFile, "utf8")) as Array<{
      label: string;
      expectAllow: boolean;
      response: { error?: unknown; result?: { outcome?: { outcome: string; optionId?: string } } };
    }>;

    expect(records.length).toBe(allowedKinds.length + deniedKinds.length);
    for (const rec of records) {
      expect(rec.response.error).toBeUndefined();
      const expectedOption = rec.expectAllow ? "opt_allow" : "opt_reject";
      expect(rec.response.result?.outcome).toEqual({
        outcome: "selected",
        optionId: expectedOption,
      });
    }
  });

  test("allow_read_only with non-string toolCall.kind degrades cleanly to deny instead of -32603 crash", async () => {
    const resultsFile = join(makeTempDir(), "allow-ro-nonstring.json");
    const nonStringServer = writeTempScript(
      "allow-ro-nonstring-acp.ts",
      `
import { writeFileSync } from "node:fs";
import * as readline from "node:readline";

const resultsFile = ${JSON.stringify(resultsFile)};
const pending = new Map<number, (msg: Record<string, unknown>) => void>();
let nextId = 1500;

function send(msg: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (!("method" in msg) && typeof msg.id === "number" && pending.has(msg.id)) {
    const res = pending.get(msg.id)!;
    pending.delete(msg.id);
    res(msg);
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-nonstring" } });
  } else if (msg.method === "session/prompt") {
    const badKinds: unknown[] = [123, ["read"], { kind: "read" }, true];
    const responses: Array<Record<string, unknown>> = [];
    for (let i = 0; i < badKinds.length; i++) {
      const id = ++nextId;
      const resp = await new Promise<Record<string, unknown>>((resolve) => {
        pending.set(id, resolve);
        send({
          jsonrpc: "2.0",
          id,
          method: "session/request_permission",
          params: {
            sessionId: "s-nonstring",
            toolCall: { toolCallId: "tc-bad-" + i, kind: badKinds[i] },
            options: [
              { optionId: "opt_allow", name: "Allow", kind: "allow_once" },
              { optionId: "opt_reject", name: "Reject", kind: "reject_once" },
            ],
          },
        });
      });
      responses.push(resp);
    }
    writeFileSync(resultsFile, JSON.stringify(responses), "utf8");
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`
    );

    const client = trackClient(
      new AcpClient({ cliPath: nonStringServer, permissionPolicy: "allow_read_only" })
    );
    await client.connect();
    const s = await client.newSession();
    await client.prompt(s.sessionId, [{ type: "text", text: "test non-string kinds" }]);

    const responses = JSON.parse(readFileSync(resultsFile, "utf8")) as Array<{
      error?: unknown;
      result?: { outcome?: { outcome: string; optionId?: string } };
    }>;

    expect(responses).toHaveLength(4);
    for (const r of responses) {
      expect(r.error).toBeUndefined();
      expect(r.result?.outcome).toEqual({ outcome: "selected", optionId: "opt_reject" });
    }
  });

  test("session/update preserves _meta.kiro.toolName and nested array content blocks verbatim via AcpClient.prompt onUpdate", async () => {
    const metaServer = writeTempScript(
      "meta-content-acp.ts",
      `
import * as readline from "node:readline";

function send(msg: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-meta" } });
  } else if (msg.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s-meta",
        _meta: { kiro: { toolName: "web_search", traceId: "tr-1" } },
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-ws-1",
          title: "Searching web",
          kind: "search",
          status: "in_progress",
          _meta: { kiro: { toolName: "web_search" } },
          rawInput: { query: "opencode kiro acp" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s-meta",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-ws-1",
          status: "completed",
          _meta: { kiro: { toolName: "web_search" } },
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Search result snippet 1 🔍",
              },
            },
            {
              type: "content",
              content: {
                type: "text",
                text: "Search result snippet 2",
              },
            },
          ],
        },
      },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`
    );

    const client = trackClient(new AcpClient({ cliPath: metaServer }));
    await client.connect();
    const s = await client.newSession();

    const updates: AcpSessionUpdateParams[] = [];
    const res = await client.prompt(s.sessionId, [{ type: "text", text: "search" }], {
      onUpdate: (u) => updates.push(u),
    });

    expect(res.stopReason).toBe("end_turn");
    expect(updates).toHaveLength(2);

    // 1. tool_call update preserves top-level & update-level _meta.kiro.toolName
    const first = updates[0] as unknown as Record<string, unknown>;
    expect((first._meta as Record<string, unknown>)?.kiro).toEqual({
      toolName: "web_search",
      traceId: "tr-1",
    });
    expect((updates[0].update._meta as Record<string, unknown>)?.kiro).toEqual({
      toolName: "web_search",
    });

    // 2. tool_call_update preserves _meta.kiro.toolName AND nested array content verbatim
    expect((updates[1].update._meta as Record<string, unknown>)?.kiro).toEqual({
      toolName: "web_search",
    });
    expect(updates[1].update.content).toEqual([
      {
        type: "content",
        content: {
          type: "text",
          text: "Search result snippet 1 🔍",
        },
      },
      {
        type: "content",
        content: {
          type: "text",
          text: "Search result snippet 2",
        },
      },
    ] as unknown as AcpSessionUpdateParams["update"]["content"]);
  });

  test("end-to-end adversarial stdio: split UTF-8 bytes, garbage stdout lines, unsupported client request, and -32601 getUsage", async () => {
    const hostileServer = writeTempScript(
      "hostile-acp.ts",
      `
import * as readline from "node:readline";

const pending = new Map<number, (msg: Record<string, unknown>) => void>();
let nextId = 800;

function sendRaw(buf: Buffer) {
  process.stdout.write(buf);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (!("method" in msg) && typeof msg.id === "number" && pending.has(msg.id)) {
    const res = pending.get(msg.id)!;
    pending.delete(msg.id);
    res(msg);
    return;
  }

  if (msg.method === "initialize") {
    // Interleave garbage stdout before & after initialize response
    process.stdout.write("WARNING: stray debug line on stdout\\n");
    process.stdout.write("{broken-json\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
  } else if (msg.method === "_kiro/account/getUsage") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: "Method not found" },
    }) + "\\n");
  } else if (msg.method === "session/new") {
    // Also send an unsupported server->client request and verify client replies -32601
    const reqId = ++nextId;
    const unsupportedResp = new Promise<Record<string, unknown>>((resolve) => {
      pending.set(reqId, resolve);
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method: "fs/read_text_file",
        params: { path: "/etc/passwd" },
      }) + "\\n");
    });
    const clientReply = await unsupportedResp;
    const rejectedProperly = (clientReply.error as { code?: number })?.code === -32601;
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { sessionId: rejectedProperly ? "sess-safe" : "sess-UNSAFE" },
    }) + "\\n");
  } else if (msg.method === "session/prompt") {
    // Stream a 4-byte emoji + CJK update split across 2-byte chunks
    const updateFrame = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "🚀日本語🔥" },
          },
        },
      }) + "\\n",
      "utf8"
    );
    for (let i = 0; i < updateFrame.length; i += 2) {
      sendRaw(updateFrame.subarray(i, i + 2));
      await new Promise((r) => setTimeout(r, 1));
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { stopReason: "end_turn" },
    }) + "\\n");
  }
});
`
    );

    const client = trackClient(
      new AcpClient({ cliPath: hostileServer, requestTimeoutMs: 5_000 })
    );
    const parseErrors: string[] = [];
    client.onParseError((_err, raw) => parseErrors.push(raw));

    await client.connect();
    expect(parseErrors.length).toBeGreaterThanOrEqual(2);

    // _kiro/account/getUsage returns null on -32601
    const usage = await client.getUsage();
    expect(usage).toBeNull();

    // Server sent fs/read_text_file; client must have rejected it with -32601
    const sess = await client.newSession();
    expect(sess.sessionId).toBe("sess-safe");

    // Split UTF-8 over real stdio pipe
    const chunks: string[] = [];
    await client.prompt(sess.sessionId, [{ type: "text", text: "hi" }], {
      onUpdate: (u) => {
        if (u.update.content?.text) chunks.push(u.update.content.text);
      },
    });
    expect(chunks.join("")).toBe("🚀日本語🔥");
  });
});

// ===========================================================================
// 5. Security Audit: Command Injection & Zero Credential File Access
// ===========================================================================

describe("Security Audit: No shell:true, No Command Injection, Zero Credential Access", () => {
  test("static source audit of src/acp/ confirms shell: false and zero credential/fs access", () => {
    const files = ["index.ts", "jsonrpc.ts", "supervisor.ts", "client.ts"];
    let supervisorSource = "";

    for (const file of files) {
      const content = readFileSync(join(SRC_ACP_DIR, file), "utf8");
      if (file === "supervisor.ts") {
        supervisorSource = content;
      }

      // Must never use shell: true or child_process exec/execSync
      expect(content).not.toMatch(/shell\s*:\s*true/);
      expect(content).not.toMatch(/\bexecSync\s*\(/);
      expect(content).not.toMatch(/\bexec\s*\(/);

      // Must never access filesystem or credential stores
      expect(content).not.toMatch(/node:fs|from\s+["']fs["']/);
      expect(content).not.toMatch(/\.kiro\/|keychain|sqlite|\.aws\/sso/i);
    }

    // Explicitly verify shell: false is set in supervisor.ts
    expect(supervisorSource).toMatch(/shell\s*:\s*false/);
  });

  test("dynamic command injection test: shell metacharacters in acpArgs are NOT executed by a shell", async () => {
    const markerFile = join(makeTempDir(), "pwned-marker");
    const argEchoScript = writeTempScript(
      "echo-args.ts",
      `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markerFile + ".args")}, JSON.stringify(process.argv.slice(2)), "utf8");
process.exit(0);
`
    );

    const maliciousArg = `$(touch ${markerFile}); touch ${markerFile} | echo pwned`;
    const sup = trackSupervisor(
      new KiroProcessSupervisor({
        cliPath: argEchoScript,
        acpArgs: [maliciousArg],
      })
    );

    const exitPromise = new Promise<void>((resolve) => {
      sup.onExit(() => resolve());
    });
    sup.start();
    await exitPromise;

    // Marker file must NEVER have been created by a shell
    expect(existsSync(markerFile)).toBe(false);

    // The literal metacharacter string must have been passed verbatim as argv
    const receivedArgs = JSON.parse(
      readFileSync(markerFile + ".args", "utf8")
    ) as string[];
    expect(receivedArgs).toEqual([maliciousArg, "acp"]);
  });
});
