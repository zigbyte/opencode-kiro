/**
 * ACP-backed LanguageModel adapter for OpenCode 2.x (AI SDK v2/v3 compatible).
 *
 * All prompt execution goes strictly through `AcpClient`:
 *   connect() -> session/new -> session/set_model -> session/prompt
 *
 * Never performs direct HTTP calls or accesses Kiro credentials.
 */

import {
  KIRO_PROVIDER_ID,
  type AcpContentBlock,
  type AcpPromptResult,
  type AcpSessionNewResult,
  type AcpSessionUpdateParams,
  type KiroModelInfo,
} from "../types.ts";
import {
  KiroProviderOwnershipError,
  isKiroModelId,
  stripKiroPrefix,
} from "./ownership.ts";

// ---------------------------------------------------------------------------
// AI SDK v2/v3 Compatible Prompt & Output Types
// ---------------------------------------------------------------------------

export type KiroPromptPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "image"; image: string | Uint8Array | URL; mimeType?: string }
  | { type: "file"; data: string | Uint8Array | URL; mimeType?: string; filename?: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args?: unknown; input?: unknown }
  | { type: "tool-result"; toolCallId: string; toolName?: string; result?: unknown; output?: unknown };

export interface KiroPromptMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | KiroPromptPart[];
}

export interface KiroCallOptions {
  prompt: KiroPromptMessage[] | string;
  system?: string;
  abortSignal?: AbortSignal;
  cwd?: string;
  maxTokens?: number;
  temperature?: number;
  headers?: Record<string, string | undefined>;
}

export type KiroFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other"
  | "unknown";

export interface KiroUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  creditsUsed?: number;
}

export interface KiroToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  status?: string;
  providerExecuted: true;
  dynamic: true;
  result?: unknown;
  isError?: boolean;
}

export interface KiroGenerateResult {
  text: string;
  reasoning: string;
  toolCalls: KiroToolCall[];
  finishReason: KiroFinishReason;
  usage: KiroUsage;
  rawResponse?: {
    sessionId: string;
    stopReason: string;
  };
}

export type KiroStreamPart =
  | { type: "text-delta"; textDelta: string; delta: string }
  | { type: "reasoning-delta"; textDelta: string; delta: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: unknown;
      providerExecuted: true;
      dynamic: true;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
      dynamic: true;
    }
  | { type: "finish"; finishReason: KiroFinishReason; usage: KiroUsage }
  | { type: "error"; error: unknown };

export interface KiroStreamResult {
  stream: ReadableStream<KiroStreamPart>;
}

// ---------------------------------------------------------------------------
// Minimal Structural ACP Client Dependency Interface
// ---------------------------------------------------------------------------

export interface KiroAcpClientLike {
  connect(): Promise<unknown>;
  isConnected(): boolean;
  newSession(cwd?: string): Promise<AcpSessionNewResult>;
  setModel(sessionId: string, modelId: string): Promise<unknown>;
  prompt(
    sessionId: string,
    blocks: AcpContentBlock[],
    options?: {
      signal?: AbortSignal;
      onUpdate?: (params: AcpSessionUpdateParams) => void;
    }
  ): Promise<AcpPromptResult>;
  cancel(sessionId: string): Promise<void>;
}

export interface KiroProviderDeps {
  acpClient: KiroAcpClientLike;
  cwd?: string;
  getKnownModels?: () => readonly KiroModelInfo[];
  onModelActive?: (modelId: string) => void;
}

export interface KiroProviderInstance {
  readonly id: typeof KIRO_PROVIDER_ID;
  languageModel(modelId: string): KiroAcpLanguageModel;
  ownsModel(modelId: string): boolean;
}

// ---------------------------------------------------------------------------
// Helpers: Prompt Conversion & Stop Reason Mapping
// ---------------------------------------------------------------------------

function toBase64(data: string | Uint8Array | URL): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof URL) {
    return data.toString();
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte !== undefined) {
      binary += String.fromCharCode(byte);
    }
  }
  return btoa(binary);
}

function safeJsonStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function convertPromptToAcpBlocks(
  prompt: KiroPromptMessage[] | string,
  system?: string
): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [];

  if (system && system.trim().length > 0) {
    blocks.push({
      type: "text",
      text: `[system]\n${system.trim()}`,
    });
  }

  if (typeof prompt === "string") {
    if (prompt.length > 0) {
      blocks.push({ type: "text", text: prompt });
    }
    if (blocks.length === 0) {
      blocks.push({ type: "text", text: "" });
    }
    return blocks;
  }

  for (const message of prompt) {
    if (typeof message.content === "string") {
      const prefix = message.role === "user" ? "" : `[${message.role}]\n`;
      if (message.content.length > 0) {
        blocks.push({
          type: "text",
          text: `${prefix}${message.content}`,
        });
      }
      continue;
    }

    for (const part of message.content) {
      switch (part.type) {
        case "text": {
          if (part.text.length > 0) {
            const prefix = message.role === "user" ? "" : `[${message.role}]\n`;
            blocks.push({ type: "text", text: `${prefix}${part.text}` });
          }
          break;
        }
        case "reasoning": {
          if (part.text.length > 0) {
            blocks.push({
              type: "text",
              text: `[assistant reasoning]\n${part.text}`,
            });
          }
          break;
        }
        case "image": {
          if (part.image instanceof URL) {
            blocks.push({
              type: "resource_link",
              uri: part.image.toString(),
              mimeType: part.mimeType ?? "image/png",
            });
          } else {
            blocks.push({
              type: "image",
              data: toBase64(part.image),
              mimeType: part.mimeType ?? "image/png",
            });
          }
          break;
        }
        case "file": {
          if (part.data instanceof URL) {
            blocks.push({
              type: "resource_link",
              uri: part.data.toString(),
              mimeType: part.mimeType,
            });
          } else {
            blocks.push({
              type: "resource",
              data: toBase64(part.data),
              mimeType: part.mimeType,
            });
          }
          break;
        }
        case "tool-call": {
          const args = part.args ?? part.input ?? {};
          blocks.push({
            type: "text",
            text: `[tool-call ${part.toolName}#${part.toolCallId}]\n${safeJsonStringify(args)}`,
          });
          break;
        }
        case "tool-result": {
          const output = part.result ?? part.output ?? "";
          blocks.push({
            type: "text",
            text: `[tool-result ${part.toolName ?? "tool"}#${part.toolCallId}]\n${safeJsonStringify(output)}`,
          });
          break;
        }
      }
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }

  return blocks;
}

export function mapAcpStopReason(stopReason: string | undefined): KiroFinishReason {
  switch (stopReason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content-filter";
    case "tool_use":
    case "tool_calls":
      return "tool-calls";
    case "cancelled":
    case "max_turn_requests":
      return "other";
    default:
      return stopReason ? "other" : "unknown";
  }
}

function normalizeUsage(result: AcpPromptResult): KiroUsage {
  const inputTokens =
    typeof result.usage?.inputTokens === "number" && Number.isFinite(result.usage.inputTokens)
      ? Math.max(0, result.usage.inputTokens)
      : 0;
  const outputTokens =
    typeof result.usage?.outputTokens === "number" && Number.isFinite(result.usage.outputTokens)
      ? Math.max(0, result.usage.outputTokens)
      : 0;
  const creditsUsed =
    typeof result.usage?.creditsUsed === "number" && Number.isFinite(result.usage.creditsUsed)
      ? Math.max(0, result.usage.creditsUsed)
      : undefined;

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(creditsUsed !== undefined ? { creditsUsed } : {}),
  };
}

const TERMINAL_TOOL_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
]);

const ERROR_TOOL_STATUSES = new Set(["failed", "error", "cancelled"]);

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves the canonical tool name from an ACP `tool_call` or `tool_call_update` payload:
 *   `_meta.kiro.toolName` -> `toolName` -> `name` -> `kind` -> `title` -> `"kiro_tool"`
 */
export function resolveCanonicalToolName(
  update: Record<string, unknown>
): string {
  const meta = isPlainRecord(update._meta) ? update._meta : undefined;
  const kiroMeta = meta && isPlainRecord(meta.kiro) ? meta.kiro : undefined;

  return (
    toNonEmptyString(kiroMeta?.toolName) ??
    toNonEmptyString(update.toolName) ??
    toNonEmptyString(update.name) ??
    toNonEmptyString(update.kind) ??
    toNonEmptyString(update.title) ??
    "kiro_tool"
  );
}

function extractToolContentText(update: Record<string, unknown>): string | null {
  const content = update.content;
  const texts: string[] = [];

  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isPlainRecord(item)) continue;
      // ACP nested content: { type: "content", content: { type: "text", text: "..." } }
      if (item.type === "content" && isPlainRecord(item.content)) {
        const nestedText = toNonEmptyString(item.content.text);
        if (nestedText !== null) {
          texts.push(nestedText);
        }
        continue;
      }
      // Direct text block: { type: "text", text: "..." }
      if (item.type === "text") {
        const directText = toNonEmptyString(item.text);
        if (directText !== null) {
          texts.push(directText);
        }
      }
    }
  } else if (isPlainRecord(content)) {
    if (content.type === "text") {
      const directText = toNonEmptyString(content.text);
      if (directText !== null) {
        texts.push(directText);
      }
    } else if (content.type === "content" && isPlainRecord(content.content)) {
      const nestedText = toNonEmptyString(content.content.text);
      if (nestedText !== null) {
        texts.push(nestedText);
      }
    }
  }

  return texts.length > 0 ? texts.join("\n") : null;
}

function hasExtractableToolOutput(update: Record<string, unknown>): boolean {
  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    return true;
  }
  return extractToolContentText(update) !== null;
}

function extractToolResult(
  update: Record<string, unknown>,
  status: string | null
): unknown {
  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    return update.rawOutput;
  }
  const text = extractToolContentText(update);
  if (text !== null) {
    return text;
  }
  return { status: status ?? "completed" };
}

// ---------------------------------------------------------------------------
// KiroAcpLanguageModel
// ---------------------------------------------------------------------------

export class KiroAcpLanguageModel {
  readonly specificationVersion = "v2" as const;
  readonly provider = KIRO_PROVIDER_ID;
  readonly modelId: string;

  private readonly acpClient: KiroAcpClientLike;
  private readonly defaultCwd?: string;
  private readonly onModelActive?: (modelId: string) => void;

  constructor(modelId: string, deps: KiroProviderDeps) {
    // Enforce strict ownership: rejects cross-provider prefixes like openai/* or anthropic/*
    this.modelId = stripKiroPrefix(modelId);
    this.acpClient = deps.acpClient;
    this.defaultCwd = deps.cwd;
    this.onModelActive = deps.onModelActive;
  }

  async doGenerate(options: KiroCallOptions): Promise<KiroGenerateResult> {
    const throwIfAborted = (): void => {
      if (options.abortSignal?.aborted) {
        throw options.abortSignal.reason instanceof Error
          ? options.abortSignal.reason
          : new Error("Request aborted");
      }
    };

    throwIfAborted();

    if (!this.acpClient.isConnected()) {
      await this.acpClient.connect();
    }
    throwIfAborted();

    const session = await this.acpClient.newSession(options.cwd ?? this.defaultCwd);
    if (options.abortSignal?.aborted) {
      void this.acpClient.cancel(session.sessionId).catch(() => {});
      throwIfAborted();
    }

    await this.acpClient.setModel(session.sessionId, this.modelId);
    if (options.abortSignal?.aborted) {
      void this.acpClient.cancel(session.sessionId).catch(() => {});
      throwIfAborted();
    }
    this.onModelActive?.(this.modelId);

    const blocks = convertPromptToAcpBlocks(options.prompt, options.system);

    let text = "";
    let reasoning = "";
    const toolCallsById = new Map<string, KiroToolCall>();

    const promptResult = await this.acpClient.prompt(session.sessionId, blocks, {
      signal: options.abortSignal,
      onUpdate: (params) => {
        const update = params.update;
        if (!update) return;

        switch (update.sessionUpdate) {
          case "agent_message_chunk": {
            if (update.content?.type === "text" && typeof update.content.text === "string") {
              text += update.content.text;
            }
            break;
          }
          case "agent_thought_chunk": {
            if (update.content?.type === "text" && typeof update.content.text === "string") {
              reasoning += update.content.text;
            }
            break;
          }
          case "tool_call":
          case "tool_call_update": {
            const id =
              toNonEmptyString(update.toolCallId) ?? `tool_${toolCallsById.size + 1}`;
            const existing = toolCallsById.get(id);
            const lockedName = existing?.toolName ?? resolveCanonicalToolName(update);
            const status = toNonEmptyString(update.status)?.toLowerCase() ?? null;
            const isTerminal = status !== null && TERMINAL_TOOL_STATUSES.has(status);
            const hasOutput = hasExtractableToolOutput(update);
            const isError =
              status !== null && ERROR_TOOL_STATUSES.has(status)
                ? true
                : existing?.isError;

            let nextResult = existing?.result;
            if (isTerminal || (status === null && hasOutput)) {
              nextResult = extractToolResult(update, status);
            }

            toolCallsById.set(id, {
              toolCallId: id,
              toolName: lockedName,
              args:
                existing !== undefined
                  ? existing.args
                  : update.rawInput !== undefined
                    ? update.rawInput
                    : {},
              status: toNonEmptyString(update.status) ?? existing?.status,
              providerExecuted: true,
              dynamic: true,
              ...(nextResult !== undefined ? { result: nextResult } : {}),
              ...(isError ? { isError: true } : {}),
            });
            break;
          }
        }
      },
    });

    const finalizedToolCalls = Array.from(toolCallsById.values()).map((tc) =>
      tc.result !== undefined
        ? tc
        : {
            ...tc,
            result: { status: tc.status ?? "completed" },
          }
    );

    return {
      text,
      reasoning,
      toolCalls: finalizedToolCalls,
      finishReason: mapAcpStopReason(promptResult.stopReason),
      usage: normalizeUsage(promptResult),
      rawResponse: {
        sessionId: session.sessionId,
        stopReason: promptResult.stopReason,
      },
    };
  }

  async doStream(options: KiroCallOptions): Promise<KiroStreamResult> {
    const internalAbort = new AbortController();
    let activeSessionId: string | null = null;
    let closed = false;

    const onExternalAbort = (): void => {
      internalAbort.abort(options.abortSignal?.reason);
      if (activeSessionId) {
        void this.acpClient.cancel(activeSessionId).catch(() => {
          // Best-effort cancellation
        });
      }
    };

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        internalAbort.abort(options.abortSignal.reason);
      } else {
        options.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    const cleanupListeners = (): void => {
      if (options.abortSignal) {
        options.abortSignal.removeEventListener("abort", onExternalAbort);
      }
    };

    const stream = new ReadableStream<KiroStreamPart>({
      start: (controller) => {
        const safeEnqueue = (part: KiroStreamPart): void => {
          if (closed) return;
          try {
            controller.enqueue(part);
          } catch {
            closed = true;
          }
        };

        const safeClose = (): void => {
          if (closed) return;
          closed = true;
          cleanupListeners();
          try {
            controller.close();
          } catch {
            // Stream already closed or cancelled
          }
        };

        const run = async (): Promise<void> => {
          try {
            if (internalAbort.signal.aborted) {
              safeEnqueue({
                type: "error",
                error:
                  internalAbort.signal.reason instanceof Error
                    ? internalAbort.signal.reason
                    : new Error("Stream aborted"),
              });
              safeClose();
              return;
            }

            if (!this.acpClient.isConnected()) {
              await this.acpClient.connect();
            }

            if (internalAbort.signal.aborted) {
              safeClose();
              return;
            }

            const session = await this.acpClient.newSession(options.cwd ?? this.defaultCwd);
            activeSessionId = session.sessionId;

            if (internalAbort.signal.aborted) {
              void this.acpClient.cancel(session.sessionId).catch(() => {});
              safeClose();
              return;
            }

            await this.acpClient.setModel(session.sessionId, this.modelId);
            this.onModelActive?.(this.modelId);

            const blocks = convertPromptToAcpBlocks(options.prompt, options.system);

            const toolState = new Map<
              string,
              { toolName: string; emittedCall: boolean; emittedFinalResult: boolean }
            >();

            const result = await this.acpClient.prompt(session.sessionId, blocks, {
              signal: internalAbort.signal,
              onUpdate: (params) => {
                if (closed || internalAbort.signal.aborted) return;
                const update = params.update;
                if (!update) return;

                switch (update.sessionUpdate) {
                  case "agent_message_chunk": {
                    if (update.content?.type === "text" && typeof update.content.text === "string") {
                      safeEnqueue({
                        type: "text-delta",
                        textDelta: update.content.text,
                        delta: update.content.text,
                      });
                    }
                    break;
                  }
                  case "agent_thought_chunk": {
                    if (update.content?.type === "text" && typeof update.content.text === "string") {
                      safeEnqueue({
                        type: "reasoning-delta",
                        textDelta: update.content.text,
                        delta: update.content.text,
                      });
                    }
                    break;
                  }
                  case "tool_call":
                  case "tool_call_update": {
                    const id =
                      toNonEmptyString(update.toolCallId) ?? `tool_${toolState.size + 1}`;
                    let state = toolState.get(id);
                    if (!state) {
                      state = {
                        toolName: resolveCanonicalToolName(update),
                        emittedCall: false,
                        emittedFinalResult: false,
                      };
                      toolState.set(id, state);
                    }

                    // Emit tool-call ONCE per toolCallId with permanently locked toolName
                    if (!state.emittedCall) {
                      state.emittedCall = true;
                      safeEnqueue({
                        type: "tool-call",
                        toolCallId: id,
                        toolName: state.toolName,
                        args: update.rawInput ?? {},
                        providerExecuted: true,
                        dynamic: true,
                      });
                    }

                    const status = toNonEmptyString(update.status)?.toLowerCase() ?? null;
                    const isTerminal =
                      status !== null && TERMINAL_TOOL_STATUSES.has(status);
                    const hasOutput = hasExtractableToolOutput(update);
                    const shouldFinalize =
                      isTerminal ||
                      (update.sessionUpdate === "tool_call_update" &&
                        status === null &&
                        hasOutput);

                    if (shouldFinalize && !state.emittedFinalResult) {
                      const isError =
                        status !== null && ERROR_TOOL_STATUSES.has(status);
                      const extracted = extractToolResult(update, status);
                      state.emittedFinalResult = true;
                      safeEnqueue({
                        type: "tool-result",
                        toolCallId: id,
                        toolName: state.toolName,
                        result: extracted,
                        ...(isError ? { isError: true } : {}),
                        dynamic: true,
                      });
                    }
                    break;
                  }
                }
              },
            });

            // Synthesize final tool-result for any dangling provider-executed tool calls
            for (const [toolCallId, state] of toolState.entries()) {
              if (state.emittedCall && !state.emittedFinalResult) {
                state.emittedFinalResult = true;
                safeEnqueue({
                  type: "tool-result",
                  toolCallId,
                  toolName: state.toolName,
                  result: { status: "completed" },
                  dynamic: true,
                });
              }
            }

            safeEnqueue({
              type: "finish",
              finishReason: mapAcpStopReason(result.stopReason),
              usage: normalizeUsage(result),
            });
            safeClose();
          } catch (error) {
            if (!closed) {
              safeEnqueue({ type: "error", error });
              safeClose();
            } else {
              cleanupListeners();
            }
          }
        };

        void run();
      },
      cancel: async () => {
        closed = true;
        internalAbort.abort(new Error("Stream cancelled by consumer"));
        cleanupListeners();
        if (activeSessionId) {
          try {
            await this.acpClient.cancel(activeSessionId);
          } catch {
            // Best-effort ACP session cancellation
          }
        }
      },
    });

    return { stream };
  }
}

// ---------------------------------------------------------------------------
// Provider Factory
// ---------------------------------------------------------------------------

export function createKiroProvider(deps: KiroProviderDeps): KiroProviderInstance {
  const ownsModel = (modelId: string): boolean =>
    isKiroModelId(modelId, deps.getKnownModels?.());

  return {
    id: KIRO_PROVIDER_ID,
    ownsModel,
    languageModel(modelId: string): KiroAcpLanguageModel {
      if (!ownsModel(modelId)) {
        throw new KiroProviderOwnershipError(
          `Model "${String(modelId)}" is not owned by provider "${KIRO_PROVIDER_ID}".`,
          { modelId: String(modelId) }
        );
      }
      const bareId = stripKiroPrefix(modelId);
      return new KiroAcpLanguageModel(bareId, deps);
    },
  };
}
