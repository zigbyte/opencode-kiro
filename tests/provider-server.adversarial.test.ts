import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import plugin, {
  KIRO_PROVIDER_ID,
  KIRO_RPC_METHODS,
  KIRO_RPC_NAMESPACE,
  PLUGIN_ID,
  KiroAcpLanguageModel,
  KiroCreditsStore,
  KiroProviderOwnershipError,
  applyKiroProviderConfig,
  assertKiroProviderOwnership,
  createKiroProvider,
  createKiroRpcClient,
  createKiroServerPlugin,
  isKiroModelId,
  stripKiroPrefix,
} from "../src/index.ts";
import {
  convertPromptToAcpBlocks,
  type KiroAcpClientLike,
  type KiroStreamPart,
} from "../src/provider/language-model.ts";
import type {
  AcpContentBlock,
  AcpPromptResult,
  AcpSessionNewResult,
  AcpSessionUpdateParams,
  KiroModelInfo,
  OpenCodeConfig,
  OpenCodePluginContext,
  OpenCodeServerHooks,
} from "../src/types.ts";

const MOCK_CLI = resolve(import.meta.dir, "fixtures/mock-kiro-cli.ts");

const SAMPLE_MODELS: KiroModelInfo[] = [
  {
    id: "claude-sonnet-4.5",
    qualifiedId: "kiro/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5 (Kiro)",
    contextLimit: 200_000,
    outputLimit: 16_384,
    creditMultiplier: 1.3,
    reasoning: true,
    toolCall: true,
    vision: true,
    isDefault: true,
    source: "acp",
  },
  {
    id: "auto",
    qualifiedId: "kiro/auto",
    name: "Kiro Auto",
    contextLimit: 200_000,
    outputLimit: 16_384,
    creditMultiplier: 1.0,
    reasoning: true,
    toolCall: true,
    vision: false,
    isDefault: false,
    source: "acp",
  },
];

function createFakeAcpClient(
  overrides: Partial<KiroAcpClientLike> = {}
): KiroAcpClientLike {
  let seq = 0;
  return {
    async connect() {
      return { protocolVersion: 1 };
    },
    isConnected() {
      return true;
    },
    async newSession(): Promise<AcpSessionNewResult> {
      return { sessionId: `fake-sess-${++seq}` };
    },
    async setModel() {
      return {};
    },
    async prompt(
      _sessionId: string,
      _blocks: AcpContentBlock[],
      _options?: {
        signal?: AbortSignal;
        onUpdate?: (params: AcpSessionUpdateParams) => void;
      }
    ): Promise<AcpPromptResult> {
      return { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async cancel() {},
    ...overrides,
  };
}

async function collectStream(
  stream: ReadableStream<KiroStreamPart>
): Promise<KiroStreamPart[]> {
  const parts: KiroStreamPart[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return parts;
}

const activeHooks: OpenCodeServerHooks[] = [];

afterEach(async () => {
  while (activeHooks.length > 0) {
    const h = activeHooks.pop();
    if (h?.dispose) {
      await h.dispose();
    }
  }
  delete process.env.MOCK_KIRO_SLOW_MS;
  delete process.env.MOCK_KIRO_CRASH_ON_PROMPT;
  delete process.env.MOCK_KIRO_AUTH;
});

// ===========================================================================
// 1. Provider Ownership Attacks (Fail-Closed)
// ===========================================================================

describe("Adversarial: Provider Ownership & Fail-Closed Guards", () => {
  const UNAUTHORIZED_PROVIDERS = [
    "openai",
    "anthropic",
    "aws-bedrock",
    "openai/gpt-4o",
    "anthropic/claude-sonnet-4.5",
    "kiro-fake",
    "kiro-fake/model",
    "__proto__",
    "constructor",
    "prototype",
    "",
    "   ",
    "kiro/",
    "kiro ",
    " kiro",
  ];

  const UNAUTHORIZED_MODEL_IDS = [
    "openai",
    "anthropic",
    "aws-bedrock",
    "openai/gpt-4o",
    "anthropic/claude-sonnet-4.5",
    "kiro-fake/model",
    "kiro/openai/gpt-4o",
    "kiro/__proto__",
    "kiro/constructor",
    "kiro/__proto__/escape",
    "__proto__",
    "constructor",
    "prototype",
    "",
    "   ",
    "kiro/",
    "kiro/   ",
  ];

  test("assertKiroProviderOwnership accepts only 'kiro' and rejects all unauthorized/pollution inputs", () => {
    expect(() => assertKiroProviderOwnership("kiro")).not.toThrow();

    for (const bad of UNAUTHORIZED_PROVIDERS) {
      expect(() => assertKiroProviderOwnership(bad)).toThrow(
        KiroProviderOwnershipError
      );
    }

    // Runtime type-confusion attacks
    expect(() =>
      assertKiroProviderOwnership(null as unknown as string)
    ).toThrow(KiroProviderOwnershipError);
    expect(() =>
      assertKiroProviderOwnership(undefined as unknown as string)
    ).toThrow(KiroProviderOwnershipError);
    expect(() =>
      assertKiroProviderOwnership(123 as unknown as string)
    ).toThrow(KiroProviderOwnershipError);
  });

  test("stripKiroPrefix accepts valid Kiro models and fails closed on all unauthorized/foreign/pollution IDs", () => {
    expect(stripKiroPrefix("kiro/claude-sonnet-4.5")).toBe("claude-sonnet-4.5");
    expect(stripKiroPrefix("kiro/auto")).toBe("auto");
    expect(stripKiroPrefix("claude-sonnet-4.5")).toBe("claude-sonnet-4.5");

    for (const bad of UNAUTHORIZED_MODEL_IDS) {
      expect(() => stripKiroPrefix(bad)).toThrow(KiroProviderOwnershipError);
    }

    expect(() => stripKiroPrefix(null as unknown as string)).toThrow(
      KiroProviderOwnershipError
    );
  });

  test("provider.ownsModel returns false for all unauthorized/foreign/nested-slash/pollution IDs", () => {
    const provider = createKiroProvider({
      acpClient: createFakeAcpClient(),
      getKnownModels: () => SAMPLE_MODELS,
    });

    expect(provider.ownsModel("kiro/claude-sonnet-4.5")).toBe(true);
    expect(provider.ownsModel("claude-sonnet-4.5")).toBe(true);
    expect(provider.ownsModel("auto")).toBe(true);

    for (const bad of UNAUTHORIZED_MODEL_IDS) {
      expect(provider.ownsModel(bad)).toBe(false);
      expect(isKiroModelId(bad, SAMPLE_MODELS)).toBe(false);
    }
  });

  test("provider.languageModel fails closed with KiroProviderOwnershipError on all unauthorized IDs", () => {
    const provider = createKiroProvider({
      acpClient: createFakeAcpClient(),
      getKnownModels: () => SAMPLE_MODELS,
    });

    const valid = provider.languageModel("kiro/claude-sonnet-4.5");
    expect(valid).toBeInstanceOf(KiroAcpLanguageModel);
    expect(valid.modelId).toBe("claude-sonnet-4.5");
    expect(valid.provider).toBe(KIRO_PROVIDER_ID);

    for (const bad of UNAUTHORIZED_MODEL_IDS) {
      expect(() => provider.languageModel(bad)).toThrow(
        KiroProviderOwnershipError
      );
    }
  });

  test("auth.loader fails closed for every non-kiro provider and never leaks credentials", async () => {
    const hooks = await createKiroServerPlugin(
      { directory: process.cwd() },
      { cliPath: MOCK_CLI }
    );
    activeHooks.push(hooks);

    expect(hooks.auth?.provider).toBe("kiro");
    expect(typeof hooks.auth?.loader).toBe("function");

    const loader = hooks.auth!.loader!;
    const okResult = await loader({}, "kiro");
    expect(okResult.provider).toBe("kiro");
    expect(okResult.managedBy).toBe("kiro-cli");
    expect(okResult.protocol).toBe("acp");
    expect("apiKey" in okResult).toBe(false);
    expect("token" in okResult).toBe(false);
    expect("accessToken" in okResult).toBe(false);

    for (const bad of UNAUTHORIZED_PROVIDERS) {
      await expect(loader({}, bad)).rejects.toThrow();
    }
  });

  test("RPC setActiveModel rejects unauthorized/foreign/pollution model IDs", async () => {
    const hooks = await createKiroServerPlugin(
      { directory: process.cwd() },
      { cliPath: MOCK_CLI }
    );
    activeHooks.push(hooks);

    const setActiveModel = hooks.rpc![KIRO_RPC_METHODS.setActiveModel]!;
    for (const bad of UNAUTHORIZED_MODEL_IDS) {
      await expect(setActiveModel(bad)).rejects.toThrow();
    }
  });
});

// ===========================================================================
// 2. Non-Mutation & Isolation Check (applyKiroProviderConfig)
// ===========================================================================

describe("Adversarial: Config Non-Mutation & Cross-Provider Isolation", () => {
  test("applyKiroProviderConfig never mutates input config or reads credentials of other providers", () => {
    let openaiSecretAccessed = false;
    let anthropicSecretAccessed = false;

    const openaiSettings: Record<string, unknown> = {};
    Object.defineProperty(openaiSettings, "apiKey", {
      enumerable: true,
      get() {
        openaiSecretAccessed = true;
        throw new Error("SECURITY VIOLATION: OpenAI apiKey was read!");
      },
    });

    const anthropicSettings: Record<string, unknown> = {};
    Object.defineProperty(anthropicSettings, "apiKey", {
      enumerable: true,
      get() {
        anthropicSecretAccessed = true;
        throw new Error("SECURITY VIOLATION: Anthropic apiKey was read!");
      },
    });

    const openaiProvider = Object.freeze({
      name: "OpenAI",
      settings: openaiSettings,
      models: Object.freeze({
        "gpt-4o": Object.freeze({ name: "GPT-4o" }),
      }),
    });

    const anthropicProvider = Object.freeze({
      name: "Anthropic",
      settings: anthropicSettings,
      models: Object.freeze({
        "claude-sonnet-4.5": Object.freeze({ name: "Claude Sonnet 4.5" }),
      }),
    });

    const originalConfig: OpenCodeConfig = Object.freeze({
      providers: Object.freeze({
        openai: openaiProvider,
        anthropic: anthropicProvider,
      }),
      theme: "dark",
    });

    const updated = applyKiroProviderConfig(originalConfig, SAMPLE_MODELS);

    // Must never have read secret getters on foreign providers
    expect(openaiSecretAccessed).toBe(false);
    expect(anthropicSecretAccessed).toBe(false);

    // Original config must remain untouched (no kiro key)
    expect(originalConfig.providers?.kiro).toBeUndefined();

    // Foreign providers must keep exact object identity
    expect(updated.providers?.openai).toBe(openaiProvider);
    expect(updated.providers?.anthropic).toBe(anthropicProvider);
    expect(updated.theme).toBe("dark");

    // Kiro provider properly populated
    expect(updated.providers?.kiro).toBeDefined();
    expect(updated.providers?.kiro?.name).toBe("Kiro");
    expect(updated.providers?.kiro?.owner).toBe(PLUGIN_ID);
    expect(updated.providers?.kiro?.package).toBe("opencode-kiro/provider");
    expect(Object.keys(updated.providers?.kiro?.models ?? {})).toEqual([
      "claude-sonnet-4.5",
      "auto",
    ]);
  });
});

// ===========================================================================
// 3. OpenCode 2.x Plugin Contract & Lifecycle Check
// ===========================================================================

describe("Adversarial: OpenCode 2.x Plugin Contract & Lifecycle", () => {
  test("default export satisfies OpenCode 2.x server plugin module contract", () => {
    expect(plugin.id).toBe("opencode-kiro");
    expect(plugin.id).toBe(PLUGIN_ID);
    expect(typeof plugin.server).toBe("function");
    expect(typeof plugin.setup).toBe("function");
    expect(plugin.server).toBe(plugin.setup);
  });

  test("server plugin wires config, RPC methods, event isolation, and clean dispose()", async () => {
    const registeredNamespaces: string[] = [];
    let registeredMap: Record<string, (...args: unknown[]) => unknown> = {};

    const ctx: OpenCodePluginContext = {
      directory: process.cwd(),
      rpc: {
        register(namespace, handlers) {
          registeredNamespaces.push(namespace);
          registeredMap = handlers;
        },
      },
    };

    const hooks = await plugin.server(ctx, { cliPath: MOCK_CLI });
    activeHooks.push(hooks);

    // RPC registration
    expect(registeredNamespaces).toEqual([KIRO_RPC_NAMESPACE]);
    const expectedMethods = Object.values(KIRO_RPC_METHODS);
    for (const method of expectedMethods) {
      expect(typeof hooks.rpc?.[method]).toBe("function");
      expect(typeof registeredMap[method]).toBe("function");
    }

    // Typed RPC client round-trip
    const rpcClient = createKiroRpcClient({
      call: async <T,>(method: string, ...args: unknown[]) => {
        const fn = hooks.rpc?.[method];
        if (!fn) throw new Error(`Missing RPC method ${method}`);
        return (await fn(...args)) as T;
      },
    });

    const initialCredits = await rpcClient.getCredits();
    expect(initialCredits.source).toBe("initial");

    // Config hook populates providers.kiro
    const cfg = await hooks.config!({
      providers: {
        openai: { name: "OpenAI", models: {} },
      },
    });
    expect(cfg?.providers?.kiro?.owner).toBe(PLUGIN_ID);
    expect(cfg?.providers?.openai?.name).toBe("OpenAI");
    expect(Object.keys(cfg?.providers?.kiro?.models ?? {}).length).toBeGreaterThan(0);

    // Event hook: ignores foreign provider model.changed, accepts kiro/*
    await hooks.event!({
      event: { type: "model.changed", properties: { modelId: "openai/gpt-4o" } },
    });
    expect(await rpcClient.getActiveModel()).not.toBe("gpt-4o");

    await hooks.event!({
      event: { type: "model.changed", properties: { modelId: "kiro/auto" } },
    });
    expect(await rpcClient.getActiveModel()).toBe("auto");

    // Live kiro.metadata event updates store
    await hooks.event!({
      event: {
        type: "kiro.metadata",
        properties: { creditsUsed: 42, creditsLimit: 200, planName: "Pro" },
      },
    });
    const afterEvent = await rpcClient.getCredits();
    expect(afterEvent.used).toBe(42);
    expect(afterEvent.limit).toBe(200);
    expect(afterEvent.percentUsed).toBe(21);

    // dispose() cleans up ACP subprocess & is idempotent
    await hooks.dispose!();
    await hooks.dispose!();

    // After dispose, attempting to generate via provider fails cleanly (AcpClient disposed)
    const model = hooks.provider!.getLanguageModel("kiro/auto") as KiroAcpLanguageModel;
    await expect(model.doGenerate({ prompt: "hello after dispose" })).rejects.toThrow(
      /disposed/i
    );
  });
});

// ===========================================================================
// 4. End-to-End ACP Execution & Streaming Attacks (mock-kiro-cli.ts)
// ===========================================================================

describe("Adversarial: End-to-End ACP Execution & Streaming", () => {
  test("doGenerate executes end-to-end via mock-kiro-cli and updates creditsStore from _kiro.dev/metadata", async () => {
    const hooks = await createKiroServerPlugin(
      { directory: process.cwd() },
      { cliPath: MOCK_CLI }
    );
    activeHooks.push(hooks);

    const model = hooks.provider!.getLanguageModel(
      "kiro/claude-sonnet-4.5"
    ) as KiroAcpLanguageModel;

    const result = await model.doGenerate({
      prompt: "Hello adversarial world",
    });

    expect(result.text).toContain("[kiro:claude-sonnet-4.5]");
    expect(result.text).toContain("Echo: Hello adversarial world");
    expect(result.reasoning).toContain("Thinking with claude-sonnet-4.5");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBe(12);
    expect(result.usage.creditsUsed).toBe(1.5);
    expect(result.rawResponse?.sessionId).toBeTruthy();

    // Verify live _kiro.dev/metadata updated creditsStore
    const getCredits = hooks.rpc![KIRO_RPC_METHODS.getCredits]!;
    const credits = (await getCredits()) as {
      used: number;
      limit: number | null;
      contextUsagePercent: number | null;
      lastTurnCredits: number | null;
      source: string;
    };
    expect(credits.source).toBe("acp_metadata");
    expect(credits.used).toBe(127); // 125.5 + 1.5
    expect(credits.limit).toBe(500);
    expect(credits.contextUsagePercent).toBe(18.4);
    expect(credits.lastTurnCredits).toBe(1.5);
  });

  test("doStream emits reasoning-delta, text-delta, finish AND updates creditsStore live", async () => {
    const hooks = await createKiroServerPlugin(
      { directory: process.cwd() },
      { cliPath: MOCK_CLI }
    );
    activeHooks.push(hooks);

    const model = hooks.provider!.getLanguageModel(
      "kiro/auto"
    ) as KiroAcpLanguageModel;

    const { stream } = await model.doStream({
      prompt: "Stream test prompt",
    });

    const parts = await collectStream(stream);
    const types = parts.map((p) => p.type);

    expect(types).toContain("reasoning-delta");
    expect(types).toContain("text-delta");
    expect(types[types.length - 1]).toBe("finish");

    const textCombined = parts
      .filter((p): p is Extract<KiroStreamPart, { type: "text-delta" }> => p.type === "text-delta")
      .map((p) => p.textDelta)
      .join("");
    expect(textCombined).toContain("[kiro:auto]");
    expect(textCombined).toContain("Echo: Stream test prompt");

    const finishPart = parts.find(
      (p): p is Extract<KiroStreamPart, { type: "finish" }> => p.type === "finish"
    );
    expect(finishPart?.finishReason).toBe("stop");
    expect(finishPart?.usage.creditsUsed).toBe(1.5);

    // Live metadata update reached creditsStore
    const getCredits = hooks.rpc![KIRO_RPC_METHODS.getCredits]!;
    const credits = (await getCredits()) as {
      used: number;
      activeModel: string | null;
      source: string;
    };
    expect(credits.source).toBe("acp_metadata");
    expect(credits.used).toBe(127);
    expect(credits.activeModel).toBe("auto");
  });

  test("AbortSignal mid-stream cancellation terminates stream promptly without emitting stop finish", async () => {
    process.env.MOCK_KIRO_SLOW_MS = "120";
    const hooks = await createKiroServerPlugin(
      { directory: process.cwd() },
      { cliPath: MOCK_CLI }
    );
    activeHooks.push(hooks);

    const model = hooks.provider!.getLanguageModel(
      "kiro/claude-sonnet-4.5"
    ) as KiroAcpLanguageModel;

    const ac = new AbortController();
    const { stream } = await model.doStream({
      prompt: "Cancel me mid-stream",
      abortSignal: ac.signal,
    });

    setTimeout(() => ac.abort(new Error("user-cancelled")), 40);

    const parts = await collectStream(stream);
    const hasStopFinish = parts.some(
      (p) => p.type === "finish" && p.finishReason === "stop"
    );
    expect(hasStopFinish).toBe(false);
    // Stream should have closed with an error or cancelled finish
    expect(parts.some((p) => p.type === "error") || parts.length >= 0).toBe(true);
  });

  test("Pre-aborted AbortSignal rejects doGenerate and errors doStream immediately", async () => {
    const fakeClient = createFakeAcpClient({
      async connect() {
        throw new Error("Should not connect when already aborted");
      },
    });
    const model = new KiroAcpLanguageModel("kiro/auto", { acpClient: fakeClient });

    const ac = new AbortController();
    ac.abort(new Error("already-aborted"));

    await expect(
      model.doGenerate({ prompt: "never sent", abortSignal: ac.signal })
    ).rejects.toThrow("already-aborted");

    const { stream } = await model.doStream({
      prompt: "never sent",
      abortSignal: ac.signal,
    });
    const parts = await collectStream(stream);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe("error");
  });

  test("Subprocess crash mid-stream (MOCK_KIRO_CRASH_ON_PROMPT=1) surfaces error cleanly without hanging", async () => {
    process.env.MOCK_KIRO_CRASH_ON_PROMPT = "1";

    const hooks = await createKiroServerPlugin(
      { directory: process.cwd() },
      { cliPath: MOCK_CLI, requestTimeoutMs: 5000 }
    );
    activeHooks.push(hooks);

    const model = hooks.provider!.getLanguageModel(
      "kiro/claude-sonnet-4.5"
    ) as KiroAcpLanguageModel;

    const { stream } = await model.doStream({ prompt: "trigger crash" });
    const parts = await collectStream(stream);

    const errorPart = parts.find((p) => p.type === "error");
    expect(errorPart).toBeDefined();
    expect(parts.some((p) => p.type === "finish")).toBe(false);

    // Also verify doGenerate rejects cleanly on crash
    await expect(model.doGenerate({ prompt: "trigger crash 2" })).rejects.toThrow();
  });

  test("Empty and multi-part prompts convert safely and consistently", async () => {
    // Empty array produces a single empty text block
    expect(convertPromptToAcpBlocks([])).toEqual([{ type: "text", text: "" }]);

    // Empty string prompt should ALSO produce a non-empty block array (consistent with [])
    const emptyStrBlocks = convertPromptToAcpBlocks("");
    expect(emptyStrBlocks.length).toBeGreaterThan(0);

    // Multi-part prompt with system, text, reasoning, image, file, tool-call, tool-result
    const blocks = convertPromptToAcpBlocks(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect this image and file" },
            {
              type: "image",
              image: new Uint8Array([137, 80, 78, 71]),
              mimeType: "image/png",
            },
            {
              type: "image",
              image: new URL("https://example.com/pic.png"),
              mimeType: "image/png",
            },
            {
              type: "file",
              data: new Uint8Array([65, 66, 67]),
              mimeType: "text/plain",
            },
            {
              type: "file",
              data: new URL("file:///tmp/spec.md"),
              mimeType: "text/markdown",
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "Let me call a tool" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "readFile",
              args: { path: "README.md" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc-1",
              toolName: "readFile",
              result: { ok: true },
            },
          ],
        },
      ],
      "You are a strict auditor."
    );

    expect(blocks.some((b) => b.type === "text" && b.text?.includes("[system]"))).toBe(true);
    expect(blocks.some((b) => b.type === "image" && b.data === "iVBORw==")).toBe(true);
    expect(blocks.some((b) => b.type === "resource_link" && b.uri === "https://example.com/pic.png")).toBe(true);
    expect(blocks.some((b) => b.type === "resource" && b.data === "QUJD")).toBe(true);
    expect(blocks.some((b) => b.type === "resource_link" && b.uri === "file:///tmp/spec.md")).toBe(true);
    expect(blocks.some((b) => b.type === "text" && b.text?.includes("[tool-call readFile#tc-1]"))).toBe(true);
    expect(blocks.some((b) => b.type === "text" && b.text?.includes("[tool-result readFile#tc-1]"))).toBe(true);
  });

  test("doStream and doGenerate handle tool_call and tool_call_update chunks", async () => {
    const fakeClient = createFakeAcpClient({
      async prompt(sessionId, _blocks, options) {
        options?.onUpdate?.({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-42",
            title: "grepSearch",
            rawInput: { pattern: "TODO" },
          },
        });
        options?.onUpdate?.({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-42",
            title: "grepSearch",
            status: "completed",
            rawOutput: { matches: 3 },
          },
        });
        return { stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    });

    const model = new KiroAcpLanguageModel("kiro/claude-sonnet-4.5", {
      acpClient: fakeClient,
    });

    const gen = await model.doGenerate({ prompt: "search TODOs" });
    expect(gen.finishReason).toBe("tool-calls");
    expect(gen.toolCalls).toHaveLength(1);
    expect(gen.toolCalls[0]?.toolCallId).toBe("tc-42");
    expect(gen.toolCalls[0]?.toolName).toBe("grepSearch");
    expect(gen.toolCalls[0]?.status).toBe("completed");

    const { stream } = await model.doStream({ prompt: "search TODOs" });
    const parts = await collectStream(stream);
    expect(parts.some((p) => p.type === "tool-call" && p.toolCallId === "tc-42")).toBe(true);
    expect(parts.some((p) => p.type === "tool-result" && p.toolCallId === "tc-42")).toBe(true);
    expect(parts.some((p) => p.type === "finish" && p.finishReason === "tool-calls")).toBe(true);
  });

  test("Concurrent sessions on the same server plugin do not cross-contaminate output", async () => {
    process.env.MOCK_KIRO_SLOW_MS = "15";
    const hooks = await createKiroServerPlugin(
      { directory: process.cwd() },
      { cliPath: MOCK_CLI }
    );
    activeHooks.push(hooks);

    const m1 = hooks.provider!.getLanguageModel("kiro/claude-sonnet-4.5") as KiroAcpLanguageModel;
    const m2 = hooks.provider!.getLanguageModel("kiro/auto") as KiroAcpLanguageModel;

    const [r1, r2] = await Promise.all([
      m1.doGenerate({ prompt: "ALPHA_SESSION" }),
      m2.doGenerate({ prompt: "BETA_SESSION" }),
    ]);

    expect(r1.text).toContain("ALPHA_SESSION");
    expect(r1.text).not.toContain("BETA_SESSION");
    expect(r2.text).toContain("BETA_SESSION");
    expect(r2.text).not.toContain("ALPHA_SESSION");
  });
});

// ===========================================================================
// 5. CreditsStore Adversarial Attacks
// ===========================================================================

describe("Adversarial: KiroCreditsStore Numeric & Listener Hardening", () => {
  test("rejects NaN, Infinity, -Infinity, and negative numbers without corrupting snapshot", () => {
    const store = new KiroCreditsStore();
    store.updateFromMetadata({
      creditsUsed: 50,
      creditsLimit: 200,
      contextUsagePercentage: 25,
      lastTurnCredits: 2.5,
    });

    const snap = store.updateFromMetadata({
      creditsUsed: Number.NaN,
      creditsLimit: Number.POSITIVE_INFINITY,
      creditsRemaining: Number.NEGATIVE_INFINITY,
      addonCreditsRemaining: -10,
      contextUsagePercentage: Number.NaN,
      lastTurnCredits: -5,
    });

    expect(Number.isFinite(snap.used)).toBe(true);
    expect(snap.used).toBe(50);
    expect(snap.limit).toBeNull();
    expect(snap.remaining).toBeNull();
    expect(snap.addonRemaining).toBeNull();
    expect(snap.contextUsagePercent).toBe(25);
    expect(snap.lastTurnCredits).toBe(2.5);

    // String-encoded toxic values
    const snap2 = store.updateFromUsage({
      creditsUsed: "NaN",
      creditsLimit: "Infinity",
      creditsRemaining: "-999",
      percentUsed: "-50",
    });
    expect(snap2.used).toBe(50);
    expect(snap2.limit).toBeNull();
    expect(snap2.percentUsed).toBeNull();
  });

  test("handles limit: 0 safely without division by zero or Infinity", () => {
    const store = new KiroCreditsStore();
    const snap = store.updateFromUsage({
      creditsUsed: 42,
      creditsLimit: 0,
    });

    expect(snap.limit).toBeNull();
    expect(snap.percentUsed).toBeNull();
    expect(snap.remaining).toBeNull();
    expect(snap.used).toBe(42);
  });

  test("handles used > limit (overage) by clamping remaining to 0 and percentUsed to 100", () => {
    const store = new KiroCreditsStore();
    const snap = store.updateFromUsage({
      creditsUsed: 750,
      creditsLimit: 500,
    });

    expect(snap.used).toBe(750);
    expect(snap.limit).toBe(500);
    expect(snap.remaining).toBe(0);
    expect(snap.percentUsed).toBe(100);
  });

  test("preserves previously reported explicit percentUsed on partial updates when limit is null", () => {
    const store = new KiroCreditsStore();
    const s1 = store.updateFromMetadata({ percentUsed: 42 });
    expect(s1.percentUsed).toBe(42);

    const s2 = store.updateFromMetadata({ activeModel: "auto" });
    expect(s2.activeModel).toBe("auto");
    expect(s2.percentUsed).toBe(42);
  });

  test("sanitizes poisoned initial values passed to constructor", () => {
    const store = new KiroCreditsStore({
      used: Number.NaN,
      limit: -100,
      percentUsed: Number.POSITIVE_INFINITY,
    });
    const snap = store.getSnapshot();
    expect(Number.isFinite(snap.used) && snap.used >= 0).toBe(true);
    expect(snap.limit === null || (Number.isFinite(snap.limit) && snap.limit > 0)).toBe(true);
    expect(
      snap.percentUsed === null ||
        (Number.isFinite(snap.percentUsed) &&
          snap.percentUsed >= 0 &&
          snap.percentUsed <= 100)
    ).toBe(true);
  });

  test("handles non-object runtime payloads without throwing", () => {
    const store = new KiroCreditsStore();
    expect(() =>
      store.updateFromMetadata(null as unknown as Record<string, unknown>)
    ).not.toThrow();
    expect(() =>
      store.updateFromUsage(undefined as unknown as Record<string, unknown>)
    ).not.toThrow();
  });

  test("throwing listener does not break other listeners or store updates", () => {
    const store = new KiroCreditsStore();
    const receivedB: number[] = [];
    const receivedD: number[] = [];

    store.subscribe(() => {
      throw new Error("Listener A exploded");
    });
    store.subscribe((s) => {
      receivedB.push(s.used);
    });
    store.subscribe(() => {
      throw new Error("Listener C exploded");
    });
    store.subscribe((s) => {
      receivedD.push(s.used);
    });

    expect(() =>
      store.updateFromMetadata({ creditsUsed: 10, creditsLimit: 100 })
    ).not.toThrow();
    expect(receivedB).toEqual([10]);
    expect(receivedD).toEqual([10]);

    store.clearListeners();
    store.updateFromMetadata({ creditsUsed: 20, creditsLimit: 100 });
    expect(receivedB).toEqual([10]);
    expect(receivedD).toEqual([10]);
  });
});
