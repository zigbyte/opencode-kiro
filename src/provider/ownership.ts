/**
 * Strict Provider Ownership Guard for OpenCode 2.x.
 *
 * Guarantees that:
 * 1. `opencode-kiro` ONLY owns the `"kiro"` provider and `kiro/*` models.
 * 2. Requests for other providers (`openai/*`, `anthropic/*`, `google/*`, etc.)
 *    are explicitly rejected with `KiroProviderOwnershipError`.
 * 3. Injecting `providers.kiro` into OpenCode 2.x config NEVER mutates or reads
 *    any other provider's configuration or credentials.
 */

import {
  KIRO_PROVIDER_ID,
  PLUGIN_ID,
  type KiroModelInfo,
  type OpenCodeConfig,
  type OpenCodeProviderConfig,
  type OpenCodeProviderModelConfig,
} from "../types.ts";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const FOREIGN_PROVIDER_NAMES = new Set([
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
  "openrouter",
]);

const KNOWN_KIRO_MODEL_IDS = new Set([
  "auto",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-opus-4",
  "claude-opus-4.1",
  "claude-haiku-4.5",
  "claude-3.7-sonnet",
  "claude-3.5-sonnet",
]);

export class KiroProviderOwnershipError extends Error {
  readonly providerId?: string;
  readonly modelId?: string;

  constructor(
    message: string,
    details?: { providerId?: string; modelId?: string }
  ) {
    super(message);
    this.name = "KiroProviderOwnershipError";
    this.providerId = details?.providerId;
    this.modelId = details?.modelId;
  }
}

/**
 * Strictly asserts that a provider ID is `"kiro"`.
 * Rejects all other providers and prototype-pollution keys.
 */
export function assertKiroProviderOwnership(providerId: string): void {
  if (
    typeof providerId !== "string" ||
    FORBIDDEN_KEYS.has(providerId) ||
    providerId !== KIRO_PROVIDER_ID
  ) {
    throw new KiroProviderOwnershipError(
      `Provider ownership violation: "${String(providerId)}" is not owned by ${PLUGIN_ID}. Only "${KIRO_PROVIDER_ID}" is permitted.`,
      { providerId: String(providerId) }
    );
  }
}

/**
 * Returns true if `modelId` belongs to the Kiro provider:
 * - Explicitly prefixed with `kiro/<id>` (with non-empty `<id>`)
 * - Or matches a known Kiro model ID (unprefixed) with no foreign provider prefix.
 */
export function isKiroModelId(
  modelId: string,
  knownModels?: readonly KiroModelInfo[]
): boolean {
  if (typeof modelId !== "string") return false;
  const trimmed = modelId.trim();
  if (!trimmed || FORBIDDEN_KEYS.has(trimmed)) return false;

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

/**
 * Normalizes a Kiro model ID by stripping the `"kiro/"` prefix.
 * Rejects cross-provider prefixes (e.g. `"openai/gpt-4o"`, `"anthropic/claude-3-5-sonnet"`),
 * nested prefixes (e.g. `"kiro/openai/gpt-4o"`), bare foreign provider names,
 * and invalid/empty/prototype-pollution IDs with `KiroProviderOwnershipError`.
 */
export function stripKiroPrefix(modelId: string): string {
  if (typeof modelId !== "string") {
    throw new KiroProviderOwnershipError("Model ID must be a non-empty string.", {
      modelId: String(modelId),
    });
  }

  const trimmed = modelId.trim();
  if (!trimmed || FORBIDDEN_KEYS.has(trimmed)) {
    throw new KiroProviderOwnershipError(
      `Invalid Kiro model ID: "${modelId}".`,
      { modelId }
    );
  }

  const slashIdx = trimmed.indexOf("/");
  if (slashIdx !== -1) {
    const prefix = trimmed.slice(0, slashIdx);
    if (prefix !== KIRO_PROVIDER_ID) {
      throw new KiroProviderOwnershipError(
        `Cross-provider routing blocked: model "${modelId}" belongs to provider "${prefix}", not "${KIRO_PROVIDER_ID}".`,
        { providerId: prefix, modelId }
      );
    }

    const bare = trimmed.slice(slashIdx + 1).trim();
    if (
      !bare ||
      bare.includes("/") ||
      FORBIDDEN_KEYS.has(bare) ||
      FOREIGN_PROVIDER_NAMES.has(bare.toLowerCase())
    ) {
      throw new KiroProviderOwnershipError(
        `Invalid Kiro model ID "${modelId}": malformed or unauthorized model suffix.`,
        { providerId: KIRO_PROVIDER_ID, modelId }
      );
    }
    return bare;
  }

  if (FOREIGN_PROVIDER_NAMES.has(trimmed.toLowerCase())) {
    throw new KiroProviderOwnershipError(
      `Cross-provider routing blocked: "${modelId}" is a foreign provider name, not a "${KIRO_PROVIDER_ID}" model.`,
      { providerId: trimmed, modelId }
    );
  }

  return trimmed;
}

/**
 * Registers `"kiro"` under `config.providers.kiro` (OpenCode 2.x standard)
 * without mutating the input config or touching any other provider's settings
 * or credentials.
 */
export function applyKiroProviderConfig(
  config: OpenCodeConfig,
  models: readonly KiroModelInfo[]
): OpenCodeConfig {
  const modelMap: Record<string, OpenCodeProviderModelConfig> = {};

  for (const model of models) {
    const bareId = stripKiroPrefix(model.id);
    modelMap[bareId] = {
      name: model.name,
      limit: {
        context: model.contextLimit,
        output: model.outputLimit,
      },
      reasoning: model.reasoning,
      tool_call: model.toolCall,
      attachment: model.vision,
      metadata: {
        qualifiedId: model.qualifiedId,
        ...(model.creditMultiplier !== undefined
          ? { creditMultiplier: model.creditMultiplier }
          : {}),
        isDefault: model.isDefault,
        source: model.source,
      },
    };
  }

  const existingProviders = config.providers ?? {};
  const existingKiro = existingProviders[KIRO_PROVIDER_ID];

  const kiroProviderConfig: OpenCodeProviderConfig = {
    name: "Kiro",
    package: "opencode-kiro/provider",
    owner: PLUGIN_ID,
    ...(existingKiro?.settings ? { settings: { ...existingKiro.settings } } : {}),
    models: modelMap,
  };

  return {
    ...config,
    providers: {
      ...existingProviders,
      [KIRO_PROVIDER_ID]: kiroProviderConfig,
    },
  };
}
