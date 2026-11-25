/**
 * Native OpenCode 2.x (`@opencode/plugin` v2.1+ / OpenCode v2.3+) integration layer.
 *
 * Registers:
 * - `"kiro"` provider + dynamically discovered models via `ctx.provider.transform`
 * - `"kiro"` integration + `["kiro-cli", "login"]` command method via `ctx.integration.transform`
 * - Strict `"kiro"` AI SDK v3 LanguageModel adapter via `ctx.aisdk.hook("sdk" | "language")`
 *
 * Security invariants:
 * - Zero credential scraping; delegates 100% to `kiro-cli login` and `kiro-cli acp`.
 * - Provider hook is strictly scoped to `{ providerID: "kiro" }` and never touches other providers.
 */

import { AcpClient } from "./acp/index.ts";
import { KiroAuthManager } from "./auth/index.ts";
import { KiroCreditsStore } from "./credits/store.ts";
import { KiroModelDiscovery } from "./discovery/index.ts";
import {
  KiroAcpLanguageModel,
  createKiroProvider,
  type KiroDoGenerateOptions,
  type KiroPromptMessage,
} from "./provider/index.ts";
import {
  KIRO_PROVIDER_ID,
  type KiroModelInfo,
  type KiroPluginOptions,
} from "./types.ts";

const KIRO_PACKAGE_TAG = "aisdk:opencode-kiro";

interface V2ProviderEditor {
  get(providerID: string): unknown;
  add(input: { info: Record<string, unknown>; models: readonly unknown[] }): void;
  update(providerID: string, update: (provider: Record<string, unknown>) => void): void;
  models: {
    update(
      providerID: string,
      modelID: string,
      update: (model: Record<string, unknown>) => void
    ): void;
  };
}

interface V2IntegrationEditor {
  update(id: string, update: (integration: { id: string; name: string }) => void): void;
  method: {
    update(input: {
      integrationID: string;
      method: {
        id: string;
        type: "command";
        label: string;
        command: readonly string[];
      };
    }): void;
  };
}

interface V2Registration {
  dispose?: () => Promise<void> | void;
}

export interface OpenCodeV2Context {
  location?: { directory?: string };
  options?: Record<string, unknown>;
  provider: {
    transform: (fn: (editor: V2ProviderEditor) => void) => Promise<V2Registration> | V2Registration;
    reload?: () => Promise<void> | void;
  };
  integration?: {
    transform: (
      fn: (editor: V2IntegrationEditor) => void
    ) => Promise<V2Registration> | V2Registration;
  };
  aisdk: {
    hook: (
      name: "sdk" | "language",
      handler: (event: Record<string, unknown>) => Promise<void> | void,
      filter?: { providerID?: string }
    ) => Promise<V2Registration> | V2Registration;
  };
}

export function isOpenCodeV2Context(ctx: unknown): ctx is OpenCodeV2Context {
  if (!ctx || typeof ctx !== "object") return false;
  const candidate = ctx as Record<string, unknown>;
  const provider = candidate.provider as Record<string, unknown> | undefined;
  const aisdk = candidate.aisdk as Record<string, unknown> | undefined;
  return (
    typeof provider?.transform === "function" &&
    typeof aisdk?.hook === "function"
  );
}

function mapFinishReasonV3(reason: string): { unified: string; raw: string } {
  switch (reason) {
    case "stop":
    case "end_turn":
      return { unified: "stop", raw: reason };
    case "length":
    case "max_tokens":
      return { unified: "length", raw: reason };
    case "tool-calls":
      return { unified: "tool-calls", raw: reason };
    case "content-filter":
    case "refusal":
      return { unified: "content-filter", raw: reason };
    default:
      return { unified: "other", raw: reason };
  }
}

function toV3Usage(usage?: { promptTokens?: number; completionTokens?: number }) {
  const inputTotal = usage?.promptTokens ?? 0;
  const outputTotal = usage?.completionTokens ?? 0;
  return {
    inputTokens: {
      total: inputTotal,
      noCache: inputTotal,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: outputTotal,
      text: outputTotal,
      reasoning: 0,
    },
  };
}

/**
 * Adapts `KiroAcpLanguageModel` to Vercel AI SDK v3 (`LanguageModelV3`)
 * required by OpenCode 2.3+'s `ctx.aisdk.hook("language")`.
 */
function createLanguageModelV3Adapter(model: KiroAcpLanguageModel) {
  return {
    specificationVersion: "v3" as const,
    provider: KIRO_PROVIDER_ID,
    modelId: model.modelId,
    supportedUrls: {},

    async doGenerate(options: {
      prompt: KiroPromptMessage[] | string;
      abortSignal?: AbortSignal;
    }) {
      const result = await model.doGenerate({
        prompt: options.prompt,
        abortSignal: options.abortSignal,
      } satisfies KiroDoGenerateOptions);

      const content: Array<Record<string, unknown>> = [];
      if (result.reasoning) {
        content.push({ type: "reasoning", text: result.reasoning });
      }
      if (result.text) {
        content.push({ type: "text", text: result.text });
      }
      for (const tc of result.toolCalls) {
        content.push({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args ?? {}),
        });
      }

      return {
        content,
        finishReason: mapFinishReasonV3(result.finishReason),
        usage: toV3Usage(result.usage),
        warnings: [],
      };
    },

    async doStream(options: {
      prompt: KiroPromptMessage[] | string;
      abortSignal?: AbortSignal;
    }) {
      const { stream: v2Stream } = await model.doStream({
        prompt: options.prompt,
        abortSignal: options.abortSignal,
      });

      const textId = `kiro-text-${Date.now()}`;
      const reasoningId = `kiro-reasoning-${Date.now()}`;
      let textStarted = false;
      let reasoningStarted = false;

      const v3Stream = new ReadableStream<Record<string, unknown>>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          const reader = v2Stream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              if (value.type === "reasoning-delta") {
                if (!reasoningStarted) {
                  reasoningStarted = true;
                  controller.enqueue({ type: "reasoning-start", id: reasoningId });
                }
                controller.enqueue({
                  type: "reasoning-delta",
                  id: reasoningId,
                  delta: value.textDelta,
                });
              } else if (value.type === "text-delta") {
                if (reasoningStarted) {
                  reasoningStarted = false;
                  controller.enqueue({ type: "reasoning-end", id: reasoningId });
                }
                if (!textStarted) {
                  textStarted = true;
                  controller.enqueue({ type: "text-start", id: textId });
                }
                controller.enqueue({
                  type: "text-delta",
                  id: textId,
                  delta: value.textDelta,
                });
              } else if (value.type === "tool-call") {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: value.toolCallId,
                  toolName: value.toolName,
                  input: JSON.stringify(value.args ?? {}),
                });
              } else if (value.type === "error") {
                controller.enqueue({ type: "error", error: value.error });
              } else if (value.type === "finish") {
                if (reasoningStarted) {
                  reasoningStarted = false;
                  controller.enqueue({ type: "reasoning-end", id: reasoningId });
                }
                if (textStarted) {
                  textStarted = false;
                  controller.enqueue({ type: "text-end", id: textId });
                }
                controller.enqueue({
                  type: "finish",
                  finishReason: mapFinishReasonV3(value.finishReason),
                  usage: toV3Usage(value.usage),
                });
              }
            }
          } finally {
            reader.releaseLock();
            controller.close();
          }
        },
        cancel() {
          return v2Stream.cancel();
        },
      });

      return { stream: v3Stream };
    },
  };
}

/**
 * Initializes `opencode-kiro` inside OpenCode 2.3+'s native plugin runtime.
 */
export async function setupOpenCodeV2(
  ctx: OpenCodeV2Context,
  options: KiroPluginOptions = {}
): Promise<() => Promise<void>> {
  const cliPath =
    (typeof ctx.options?.cliPath === "string" && ctx.options.cliPath.trim()) ||
    options.cliPath ||
    "kiro-cli";
  const cwd = options.cwd ?? ctx.location?.directory ?? process.cwd();

  const effectiveOptions: KiroPluginOptions = {
    ...options,
    cliPath,
    cwd,
  };

  const acpClient = new AcpClient(effectiveOptions);
  const authManager = new KiroAuthManager(effectiveOptions);
  const modelDiscovery = new KiroModelDiscovery(effectiveOptions);
  const creditsStore = new KiroCreditsStore();

  const unsubscribeMetadata = acpClient.onMetadata((payload) => {
    creditsStore.updateFromMetadata(payload);
  });

  const providerInstance = createKiroProvider({
    acpClient,
    cwd,
    getKnownModels: () => modelDiscovery.getCachedModels(),
    onModelActive: (modelId) => {
      creditsStore.setActiveModel(modelId);
    },
  });

  const [authStatus, discoveredModels] = await Promise.all([
    authManager.getStatus().catch(() => ({
      authenticated: false,
      managedBy: "kiro-cli" as const,
      accountLabel: null,
      authMethod: null,
      cliAvailable: false,
      cliPath,
      checkedAt: new Date().toISOString(),
    })),
    modelDiscovery.discover({ forceRefresh: false }).catch((): KiroModelInfo[] => []),
  ]);

  const registrations: V2Registration[] = [];

  // 1. Register `"kiro"` integration using OpenCode 2.x native `command` method (`kiro-cli login`)
  if (ctx.integration && typeof ctx.integration.transform === "function") {
    registrations.push(
      await ctx.integration.transform((editor) => {
        editor.update(KIRO_PROVIDER_ID, (integration) => {
          integration.name = "Kiro";
        });
        editor.method.update({
          integrationID: KIRO_PROVIDER_ID,
          method: {
            id: "kiro-cli-login",
            type: "command",
            label: "Kiro CLI Login (kiro-cli login)",
            command: [cliPath, "login"],
          },
        });
      })
    );
  }

  // 2. Register `"kiro"` provider and all discovered models so OpenCode & OpenChamber display it
  registrations.push(
    await ctx.provider.transform((editor) => {
      if (!editor.get(KIRO_PROVIDER_ID)) {
        editor.add({
          info: {
            id: KIRO_PROVIDER_ID,
            name: "Kiro",
            package: KIRO_PACKAGE_TAG,
            activation: authStatus.authenticated ? "enabled" : "auto",
          },
          models: [],
        });
      }

      editor.update(KIRO_PROVIDER_ID, (provider) => {
        provider.name = "Kiro";
        provider.package = KIRO_PACKAGE_TAG;
        if (authStatus.authenticated && provider.activation === "auto") {
          provider.activation = "enabled";
        }
      });

      for (const model of discoveredModels) {
        editor.models.update(KIRO_PROVIDER_ID, model.id, (target) => {
          target.name = model.name;
          target.package = KIRO_PACKAGE_TAG;
          target.limit = {
            context: model.contextLimit,
            output: model.outputLimit,
          };
          target.capabilities = {
            tools: model.toolCall,
            input: model.vision ? ["text", "image"] : ["text"],
            output: ["text"],
          };
          target.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }];
          target.variants = [];
        });
      }
    })
  );

  // 3. Intercept AI SDK `sdk` & `language` hooks strictly for `{ providerID: "kiro" }`
  registrations.push(
    await ctx.aisdk.hook(
      "sdk",
      async (event) => {
        event.sdk = {
          languageModel: (id: string) =>
            createLanguageModelV3Adapter(providerInstance.languageModel(id)),
        };
      },
      { providerID: KIRO_PROVIDER_ID }
    )
  );

  registrations.push(
    await ctx.aisdk.hook(
      "language",
      async (event) => {
        const modelInfo = event.model as { id?: string } | undefined;
        const modelId = typeof modelInfo?.id === "string" ? modelInfo.id : "auto";
        event.language = createLanguageModelV3Adapter(
          providerInstance.languageModel(modelId)
        );
      },
      { providerID: KIRO_PROVIDER_ID }
    )
  );

  return async () => {
    unsubscribeMetadata();
    creditsStore.clearListeners();
    for (const reg of registrations) {
      try {
        await reg?.dispose?.();
      } catch {
        // Ignore disposal errors during shutdown
      }
    }
    await acpClient.dispose();
  };
}
