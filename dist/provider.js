// src/types.ts
var KIRO_PROVIDER_ID = "kiro";
var PLUGIN_ID = "opencode-kiro";

// src/provider/ownership.ts
var FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
var FOREIGN_PROVIDER_NAMES = new Set([
  "openai",
  "anthropic",
  "aws-bedrock",
  "google",
  "azure",
  "cohere",
  "mistral",
  "xai",
  "deepseek",
  "groq",
  "ollama",
  "bedrock",
  "vertex",
  "openrouter"
]);
var KNOWN_KIRO_MODEL_IDS = new Set([
  "auto",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-opus-4",
  "claude-opus-4.1",
  "claude-haiku-4.5",
  "claude-3.7-sonnet",
  "claude-3.5-sonnet"
]);

class KiroProviderOwnershipError extends Error {
  providerId;
  modelId;
  constructor(message, details) {
    super(message);
    this.name = "KiroProviderOwnershipError";
    this.providerId = details?.providerId;
    this.modelId = details?.modelId;
  }
}
function assertKiroProviderOwnership(providerId) {
  if (typeof providerId !== "string" || FORBIDDEN_KEYS.has(providerId) || providerId !== KIRO_PROVIDER_ID) {
    throw new KiroProviderOwnershipError(`Provider ownership violation: "${String(providerId)}" is not owned by ${PLUGIN_ID}. Only "${KIRO_PROVIDER_ID}" is permitted.`, { providerId: String(providerId) });
  }
}
function isKiroModelId(modelId, knownModels) {
  if (typeof modelId !== "string")
    return false;
  const trimmed = modelId.trim();
  if (!trimmed || FORBIDDEN_KEYS.has(trimmed))
    return false;
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx !== -1) {
    const prefix = trimmed.slice(0, slashIdx);
    const suffix = trimmed.slice(slashIdx + 1).trim();
    if (prefix !== KIRO_PROVIDER_ID) {
      return false;
    }
    if (!suffix || suffix.includes("/")) {
      return false;
    }
    if (FORBIDDEN_KEYS.has(suffix) || FOREIGN_PROVIDER_NAMES.has(suffix.toLowerCase())) {
      return false;
    }
    return true;
  }
  if (FOREIGN_PROVIDER_NAMES.has(trimmed.toLowerCase())) {
    return false;
  }
  if (knownModels && knownModels.length > 0) {
    if (knownModels.some((m) => m.id === trimmed || m.qualifiedId === `kiro/${trimmed}`)) {
      return true;
    }
  }
  return KNOWN_KIRO_MODEL_IDS.has(trimmed);
}
function stripKiroPrefix(modelId) {
  if (typeof modelId !== "string") {
    throw new KiroProviderOwnershipError("Model ID must be a non-empty string.", {
      modelId: String(modelId)
    });
  }
  const trimmed = modelId.trim();
  if (!trimmed || FORBIDDEN_KEYS.has(trimmed)) {
    throw new KiroProviderOwnershipError(`Invalid Kiro model ID: "${modelId}".`, { modelId });
  }
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx !== -1) {
    const prefix = trimmed.slice(0, slashIdx);
    if (prefix !== KIRO_PROVIDER_ID) {
      throw new KiroProviderOwnershipError(`Cross-provider routing blocked: model "${modelId}" belongs to provider "${prefix}", not "${KIRO_PROVIDER_ID}".`, { providerId: prefix, modelId });
    }
    const bare = trimmed.slice(slashIdx + 1).trim();
    if (!bare || bare.includes("/") || FORBIDDEN_KEYS.has(bare) || FOREIGN_PROVIDER_NAMES.has(bare.toLowerCase())) {
      throw new KiroProviderOwnershipError(`Invalid Kiro model ID "${modelId}": malformed or unauthorized model suffix.`, { providerId: KIRO_PROVIDER_ID, modelId });
    }
    return bare;
  }
  if (FOREIGN_PROVIDER_NAMES.has(trimmed.toLowerCase())) {
    throw new KiroProviderOwnershipError(`Cross-provider routing blocked: "${modelId}" is a foreign provider name, not a "${KIRO_PROVIDER_ID}" model.`, { providerId: trimmed, modelId });
  }
  return trimmed;
}
function applyKiroProviderConfig(config, models) {
  const modelMap = {};
  for (const model of models) {
    const bareId = stripKiroPrefix(model.id);
    modelMap[bareId] = {
      name: model.name,
      limit: {
        context: model.contextLimit,
        output: model.outputLimit
      },
      reasoning: model.reasoning,
      tool_call: model.toolCall,
      attachment: model.vision,
      metadata: {
        qualifiedId: model.qualifiedId,
        ...model.creditMultiplier !== undefined ? { creditMultiplier: model.creditMultiplier } : {},
        isDefault: model.isDefault,
        source: model.source
      }
    };
  }
  const existingProviders = config.providers ?? {};
  const existingKiro = existingProviders[KIRO_PROVIDER_ID];
  const kiroProviderConfig = {
    name: "Kiro",
    package: "opencode-kiro/provider",
    owner: PLUGIN_ID,
    ...existingKiro?.settings ? { settings: { ...existingKiro.settings } } : {},
    models: modelMap
  };
  return {
    ...config,
    providers: {
      ...existingProviders,
      [KIRO_PROVIDER_ID]: kiroProviderConfig
    }
  };
}
// src/provider/language-model.ts
function toBase64(data) {
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
  for (let i = 0;i < data.length; i++) {
    const byte = data[i];
    if (byte !== undefined) {
      binary += String.fromCharCode(byte);
    }
  }
  return btoa(binary);
}
function safeJsonStringify(value) {
  if (typeof value === "string")
    return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function convertPromptToAcpBlocks(prompt, system) {
  const blocks = [];
  if (system && system.trim().length > 0) {
    blocks.push({
      type: "text",
      text: `[system]
${system.trim()}`
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
      const prefix = message.role === "user" ? "" : `[${message.role}]
`;
      if (message.content.length > 0) {
        blocks.push({
          type: "text",
          text: `${prefix}${message.content}`
        });
      }
      continue;
    }
    for (const part of message.content) {
      switch (part.type) {
        case "text": {
          if (part.text.length > 0) {
            const prefix = message.role === "user" ? "" : `[${message.role}]
`;
            blocks.push({ type: "text", text: `${prefix}${part.text}` });
          }
          break;
        }
        case "reasoning": {
          if (part.text.length > 0) {
            blocks.push({
              type: "text",
              text: `[assistant reasoning]
${part.text}`
            });
          }
          break;
        }
        case "image": {
          if (part.image instanceof URL) {
            blocks.push({
              type: "resource_link",
              uri: part.image.toString(),
              mimeType: part.mimeType ?? "image/png"
            });
          } else {
            blocks.push({
              type: "image",
              data: toBase64(part.image),
              mimeType: part.mimeType ?? "image/png"
            });
          }
          break;
        }
        case "file": {
          if (part.data instanceof URL) {
            blocks.push({
              type: "resource_link",
              uri: part.data.toString(),
              mimeType: part.mimeType
            });
          } else {
            blocks.push({
              type: "resource",
              data: toBase64(part.data),
              mimeType: part.mimeType
            });
          }
          break;
        }
        case "tool-call": {
          const args = part.args ?? part.input ?? {};
          blocks.push({
            type: "text",
            text: `[tool-call ${part.toolName}#${part.toolCallId}]
${safeJsonStringify(args)}`
          });
          break;
        }
        case "tool-result": {
          const output = part.result ?? part.output ?? "";
          blocks.push({
            type: "text",
            text: `[tool-result ${part.toolName ?? "tool"}#${part.toolCallId}]
${safeJsonStringify(output)}`
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
function mapAcpStopReason(stopReason) {
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
function normalizeUsage(result) {
  const inputTokens = typeof result.usage?.inputTokens === "number" && Number.isFinite(result.usage.inputTokens) ? Math.max(0, result.usage.inputTokens) : 0;
  const outputTokens = typeof result.usage?.outputTokens === "number" && Number.isFinite(result.usage.outputTokens) ? Math.max(0, result.usage.outputTokens) : 0;
  const creditsUsed = typeof result.usage?.creditsUsed === "number" && Number.isFinite(result.usage.creditsUsed) ? Math.max(0, result.usage.creditsUsed) : undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...creditsUsed !== undefined ? { creditsUsed } : {}
  };
}

class KiroAcpLanguageModel {
  specificationVersion = "v2";
  provider = KIRO_PROVIDER_ID;
  modelId;
  acpClient;
  defaultCwd;
  onModelActive;
  constructor(modelId, deps) {
    this.modelId = stripKiroPrefix(modelId);
    this.acpClient = deps.acpClient;
    this.defaultCwd = deps.cwd;
    this.onModelActive = deps.onModelActive;
  }
  async doGenerate(options) {
    const throwIfAborted = () => {
      if (options.abortSignal?.aborted) {
        throw options.abortSignal.reason instanceof Error ? options.abortSignal.reason : new Error("Request aborted");
      }
    };
    throwIfAborted();
    if (!this.acpClient.isConnected()) {
      await this.acpClient.connect();
    }
    throwIfAborted();
    const session = await this.acpClient.newSession(options.cwd ?? this.defaultCwd);
    if (options.abortSignal?.aborted) {
      this.acpClient.cancel(session.sessionId).catch(() => {});
      throwIfAborted();
    }
    await this.acpClient.setModel(session.sessionId, this.modelId);
    if (options.abortSignal?.aborted) {
      this.acpClient.cancel(session.sessionId).catch(() => {});
      throwIfAborted();
    }
    this.onModelActive?.(this.modelId);
    const blocks = convertPromptToAcpBlocks(options.prompt, options.system);
    let text = "";
    let reasoning = "";
    const toolCallsById = new Map;
    const promptResult = await this.acpClient.prompt(session.sessionId, blocks, {
      signal: options.abortSignal,
      onUpdate: (params) => {
        const update = params.update;
        if (!update)
          return;
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
            const id = update.toolCallId ?? `tool_${toolCallsById.size + 1}`;
            const existing = toolCallsById.get(id);
            toolCallsById.set(id, {
              toolCallId: id,
              toolName: update.title ?? update.kind ?? existing?.toolName ?? "tool",
              args: update.rawInput !== undefined ? update.rawInput : existing?.args ?? {},
              status: update.status ?? existing?.status
            });
            break;
          }
        }
      }
    });
    return {
      text,
      reasoning,
      toolCalls: Array.from(toolCallsById.values()),
      finishReason: mapAcpStopReason(promptResult.stopReason),
      usage: normalizeUsage(promptResult),
      rawResponse: {
        sessionId: session.sessionId,
        stopReason: promptResult.stopReason
      }
    };
  }
  async doStream(options) {
    const internalAbort = new AbortController;
    let activeSessionId = null;
    let closed = false;
    const onExternalAbort = () => {
      internalAbort.abort(options.abortSignal?.reason);
      if (activeSessionId) {
        this.acpClient.cancel(activeSessionId).catch(() => {});
      }
    };
    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        internalAbort.abort(options.abortSignal.reason);
      } else {
        options.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    const cleanupListeners = () => {
      if (options.abortSignal) {
        options.abortSignal.removeEventListener("abort", onExternalAbort);
      }
    };
    const stream = new ReadableStream({
      start: (controller) => {
        const safeEnqueue = (part) => {
          if (closed)
            return;
          try {
            controller.enqueue(part);
          } catch {
            closed = true;
          }
        };
        const safeClose = () => {
          if (closed)
            return;
          closed = true;
          cleanupListeners();
          try {
            controller.close();
          } catch {}
        };
        const run = async () => {
          try {
            if (internalAbort.signal.aborted) {
              safeEnqueue({
                type: "error",
                error: internalAbort.signal.reason instanceof Error ? internalAbort.signal.reason : new Error("Stream aborted")
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
              this.acpClient.cancel(session.sessionId).catch(() => {});
              safeClose();
              return;
            }
            await this.acpClient.setModel(session.sessionId, this.modelId);
            this.onModelActive?.(this.modelId);
            const blocks = convertPromptToAcpBlocks(options.prompt, options.system);
            const result = await this.acpClient.prompt(session.sessionId, blocks, {
              signal: internalAbort.signal,
              onUpdate: (params) => {
                if (closed || internalAbort.signal.aborted)
                  return;
                const update = params.update;
                if (!update)
                  return;
                switch (update.sessionUpdate) {
                  case "agent_message_chunk": {
                    if (update.content?.type === "text" && typeof update.content.text === "string") {
                      safeEnqueue({
                        type: "text-delta",
                        textDelta: update.content.text,
                        delta: update.content.text
                      });
                    }
                    break;
                  }
                  case "agent_thought_chunk": {
                    if (update.content?.type === "text" && typeof update.content.text === "string") {
                      safeEnqueue({
                        type: "reasoning-delta",
                        textDelta: update.content.text,
                        delta: update.content.text
                      });
                    }
                    break;
                  }
                  case "tool_call": {
                    safeEnqueue({
                      type: "tool-call",
                      toolCallId: update.toolCallId ?? "tool_call",
                      toolName: update.title ?? update.kind ?? "tool",
                      args: update.rawInput ?? {}
                    });
                    break;
                  }
                  case "tool_call_update": {
                    if (update.rawOutput !== undefined || update.status === "completed") {
                      safeEnqueue({
                        type: "tool-result",
                        toolCallId: update.toolCallId ?? "tool_call",
                        toolName: update.title ?? update.kind,
                        result: update.rawOutput ?? null
                      });
                    } else if (update.rawInput !== undefined) {
                      safeEnqueue({
                        type: "tool-call",
                        toolCallId: update.toolCallId ?? "tool_call",
                        toolName: update.title ?? update.kind ?? "tool",
                        args: update.rawInput
                      });
                    }
                    break;
                  }
                }
              }
            });
            safeEnqueue({
              type: "finish",
              finishReason: mapAcpStopReason(result.stopReason),
              usage: normalizeUsage(result)
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
        run();
      },
      cancel: async () => {
        closed = true;
        internalAbort.abort(new Error("Stream cancelled by consumer"));
        cleanupListeners();
        if (activeSessionId) {
          try {
            await this.acpClient.cancel(activeSessionId);
          } catch {}
        }
      }
    });
    return { stream };
  }
}
function createKiroProvider(deps) {
  const ownsModel = (modelId) => isKiroModelId(modelId, deps.getKnownModels?.());
  return {
    id: KIRO_PROVIDER_ID,
    ownsModel,
    languageModel(modelId) {
      if (!ownsModel(modelId)) {
        throw new KiroProviderOwnershipError(`Model "${String(modelId)}" is not owned by provider "${KIRO_PROVIDER_ID}".`, { modelId: String(modelId) });
      }
      const bareId = stripKiroPrefix(modelId);
      return new KiroAcpLanguageModel(bareId, deps);
    }
  };
}
export {
  KiroAcpLanguageModel,
  KiroProviderOwnershipError,
  applyKiroProviderConfig,
  assertKiroProviderOwnership,
  convertPromptToAcpBlocks,
  createKiroProvider,
  isKiroModelId,
  mapAcpStopReason,
  stripKiroPrefix
};
