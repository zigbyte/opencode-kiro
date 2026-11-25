import {
  KIRO_PROVIDER_ID,
  type AcpConfigOption,
  type AcpInitializeResult,
  type AcpModelDescriptor,
  type AcpSessionNewResult,
  type KiroModelInfo,
  type KiroPluginOptions,
} from "../types";
import { spawnKiroCli, validateCliPath } from "../auth/kiro-auth";

const DEFAULT_CLI_PATH = "kiro-cli";
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CONTEXT_LIMIT = 200_000;
const DEFAULT_OUTPUT_LIMIT = 8_192;

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

const KIRO_PREFIX = `${KIRO_PROVIDER_ID}/`;

const HEADER_LABELS = new Set([
  "id",
  "model",
  "model id",
  "model_id",
  "models",
  "name",
  "available models",
  "available models:",
]);

const PROSE_PREFIX_WORDS = new Set([
  "error",
  "warning",
  "warn",
  "fatal",
  "info",
  "note",
  "usage",
  "please",
  "run",
  "failed",
  "unable",
  "cannot",
  "not",
  "no",
  "try",
  "see",
  "help",
  "hint",
  "tip",
]);

const FALLBACK_MODELS: readonly KiroModelInfo[] = [
  {
    id: "auto",
    qualifiedId: "kiro/auto",
    name: "Kiro Auto",
    description: "Automatic model selection managed by Kiro CLI",
    contextLimit: DEFAULT_CONTEXT_LIMIT,
    outputLimit: DEFAULT_OUTPUT_LIMIT,
    reasoning: true,
    toolCall: true,
    vision: true,
    isDefault: true,
    source: "fallback",
  },
];

interface NormalizedModelEntry {
  model: KiroModelInfo;
  hasExplicitContext: boolean;
  hasExplicitOutput: boolean;
}

export interface DiscoverModelsOptions {
  forceRefresh?: boolean;
  acpInit?: AcpInitializeResult | null;
  acpSession?: AcpSessionNewResult | null;
}

function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE_RE, "");
}

function normalizeModelId(rawId: unknown): string {
  if (typeof rawId !== "string") return "";
  const trimmed = rawId.trim();
  if (trimmed.startsWith(KIRO_PREFIX)) {
    return trimmed.slice(KIRO_PREFIX.length).trim();
  }
  return trimmed;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function toOptionalPositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/x$/i, "");
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeDescriptor(
  raw: unknown,
  source: KiroModelInfo["source"],
  currentModelId?: unknown
): NormalizedModelEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const desc = raw as Partial<AcpModelDescriptor> & {
    id?: unknown;
    modelId?: unknown;
    model_id?: unknown;
    model_name?: unknown;
    context_window_tokens?: unknown;
    rate_multiplier?: unknown;
  };
  const id = normalizeModelId(desc.id ?? desc.modelId ?? desc.model_id);
  if (!id) return null;

  const normalizedCurrent =
    typeof currentModelId === "string"
      ? normalizeModelId(currentModelId)
      : undefined;

  const explicitContext = parsePositiveInt(
    desc.contextWindow ?? desc.context_window_tokens
  );
  const explicitOutput = parsePositiveInt(desc.maxOutputTokens);
  const creditMultiplier = toOptionalPositiveNumber(
    desc.creditMultiplier ?? desc.rate_multiplier
  );
  const rawName = desc.name ?? desc.model_name;

  return {
    model: {
      id,
      qualifiedId: `${KIRO_PROVIDER_ID}/${id}`,
      name:
        typeof rawName === "string" && rawName.trim().length > 0
          ? rawName.trim()
          : id,
      ...(typeof desc.description === "string" &&
      desc.description.trim().length > 0
        ? { description: desc.description.trim() }
        : {}),
      contextLimit: explicitContext ?? DEFAULT_CONTEXT_LIMIT,
      outputLimit: explicitOutput ?? DEFAULT_OUTPUT_LIMIT,
      ...(creditMultiplier !== undefined ? { creditMultiplier } : {}),
      reasoning: Boolean(desc.reasoning),
      toolCall: desc.supportsTools ?? true,
      vision: desc.supportsVision ?? false,
      isDefault:
        Boolean(desc.isDefault) ||
        (normalizedCurrent !== undefined &&
          normalizedCurrent.length > 0 &&
          id === normalizedCurrent),
      source,
    },
    hasExplicitContext: explicitContext !== undefined,
    hasExplicitOutput: explicitOutput !== undefined,
  };
}

function deduplicateEntries(entries: NormalizedModelEntry[]): KiroModelInfo[] {
  const byId = new Map<string, NormalizedModelEntry>();

  for (const entry of entries) {
    const existing = byId.get(entry.model.id);
    if (!existing) {
      byId.set(entry.model.id, {
        model: { ...entry.model },
        hasExplicitContext: entry.hasExplicitContext,
        hasExplicitOutput: entry.hasExplicitOutput,
      });
    } else {
      const useNewContext =
        !existing.hasExplicitContext && entry.hasExplicitContext;
      const useNewOutput =
        !existing.hasExplicitOutput && entry.hasExplicitOutput;

      byId.set(entry.model.id, {
        model: {
          ...existing.model,
          name:
            existing.model.name !== existing.model.id
              ? existing.model.name
              : entry.model.name,
          description: existing.model.description ?? entry.model.description,
          contextLimit: useNewContext
            ? entry.model.contextLimit
            : existing.model.contextLimit,
          outputLimit: useNewOutput
            ? entry.model.outputLimit
            : existing.model.outputLimit,
          creditMultiplier:
            existing.model.creditMultiplier ?? entry.model.creditMultiplier,
          reasoning: existing.model.reasoning || entry.model.reasoning,
          toolCall: existing.model.toolCall || entry.model.toolCall,
          vision: existing.model.vision || entry.model.vision,
          isDefault: existing.model.isDefault || entry.model.isDefault,
        },
        hasExplicitContext:
          existing.hasExplicitContext || entry.hasExplicitContext,
        hasExplicitOutput:
          existing.hasExplicitOutput || entry.hasExplicitOutput,
      });
    }
  }

  const result = Array.from(byId.values(), (e) => e.model);
  if (result.length > 0 && !result.some((m) => m.isDefault)) {
    const autoModel = result.find((m) => m.id === "auto");
    if (autoModel) {
      autoModel.isDefault = true;
    } else {
      const first = result[0];
      if (first) {
        first.isDefault = true;
      }
    }
  }

  return result;
}

function extractModelsFromConfigOptions(
  configOptions: AcpConfigOption[] | undefined
): NormalizedModelEntry[] {
  if (!Array.isArray(configOptions)) return [];

  const entries: NormalizedModelEntry[] = [];
  for (const option of configOptions) {
    if (!option || typeof option !== "object") continue;
    if (option.category !== "model" && option.id !== "model") {
      continue;
    }
    if (!Array.isArray(option.options)) {
      continue;
    }
    const currentValue =
      typeof option.currentValue === "string"
        ? normalizeModelId(option.currentValue)
        : undefined;

    for (const choice of option.options) {
      if (!choice || typeof choice !== "object") continue;
      if (typeof choice.value !== "string") continue;

      const normalized = normalizeDescriptor(
        {
          id: choice.value,
          name:
            typeof choice.name === "string" ? choice.name : choice.value,
          description:
            typeof choice.description === "string"
              ? choice.description
              : undefined,
          isDefault:
            currentValue !== undefined &&
            currentValue.length > 0 &&
            normalizeModelId(choice.value) === currentValue,
        },
        "acp",
        currentValue
      );
      if (normalized) {
        entries.push(normalized);
      }
    }
  }
  return entries;
}

function normalizeJsonModelEntry(entry: unknown): NormalizedModelEntry | null {
  if (typeof entry === "string") {
    return normalizeDescriptor({ id: entry }, "cli");
  }
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const obj = entry as Record<string, unknown>;
  const rawId =
    obj.id ?? obj.modelId ?? obj.model_id ?? obj.model ?? obj.value ?? obj.slug;
  if (typeof rawId !== "string" || rawId.trim().length === 0) {
    return null;
  }

  const rawName = obj.name ?? obj.model_name ?? obj.displayName ?? obj.label;
  const rawDesc = obj.description;
  const rawContext =
    obj.contextLimit ??
    obj.contextWindow ??
    obj.context_window_tokens ??
    obj.context_window ??
    obj.context_length ??
    obj.maxContextTokens;
  const rawOutput =
    obj.outputLimit ??
    obj.maxOutputTokens ??
    obj.max_output_tokens ??
    obj.output_limit;
  const rawMultiplier =
    obj.creditMultiplier ??
    obj.credit_multiplier ??
    obj.rate_multiplier ??
    obj.multiplier ??
    obj.credits;

  return normalizeDescriptor(
    {
      id: rawId,
      name: typeof rawName === "string" ? rawName : undefined,
      description: typeof rawDesc === "string" ? rawDesc : undefined,
      contextWindow: parsePositiveInt(rawContext),
      maxOutputTokens: parsePositiveInt(rawOutput),
      creditMultiplier: toOptionalPositiveNumber(rawMultiplier),
      reasoning:
        typeof obj.reasoning === "boolean"
          ? obj.reasoning
          : typeof obj.supportsReasoning === "boolean"
            ? obj.supportsReasoning
            : false,
      supportsTools:
        typeof obj.toolCall === "boolean"
          ? obj.toolCall
          : typeof obj.supportsTools === "boolean"
            ? obj.supportsTools
            : typeof obj.tool_call === "boolean"
              ? obj.tool_call
              : true,
      supportsVision:
        typeof obj.vision === "boolean"
          ? obj.vision
          : typeof obj.supportsVision === "boolean"
            ? obj.supportsVision
            : false,
      isDefault: Boolean(obj.isDefault ?? obj.default),
    },
    "cli"
  );
}

function parsePlainTextModels(cleaned: string): KiroModelInfo[] {
  const entries: NormalizedModelEntry[] = [];
  const lines = cleaned.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Skip borders and markdown table separators (e.g. `---`, `| --- | --- |`)
    if (/^[|\s\-=+─═:]+$/.test(trimmed)) continue;

    let isDefault = false;
    let line = trimmed;

    // Strip leading/trailing pipe delimiters from markdown/ASCII tables
    if (line.startsWith("|")) {
      line = line.replace(/^\|+/, "").replace(/\|+$/, "").trim();
      if (!line) continue;
    }

    if (/^\*\s+/.test(line)) {
      isDefault = true;
      line = line.replace(/^\*\s+/, "");
    } else if (/^[-•>✓✔]\s+/.test(line)) {
      if (/^[✓✔]/.test(line)) {
        isDefault = true;
      }
      line = line.replace(/^[-•>✓✔]\s+/, "");
    }

    if (/\(default\)/i.test(line)) {
      isDefault = true;
      line = line.replace(/\(default\)/gi, "").trim();
    }

    // Split by 2+ spaces, tabs, or pipe separators
    const columns = line
      .split(/\t+|\s{2,}|\s*\|\s*/)
      .map((col) => col.trim())
      .filter((col) => col.length > 0);

    const firstCol = columns[0];
    if (!firstCol) continue;

    // Skip table/section header lines without dropping valid IDs like `model-v2`
    const firstColLower = firstCol.toLowerCase();
    if (HEADER_LABELS.has(firstColLower)) {
      continue;
    }

    // Reject lines whose first column ends with `:` (e.g., `Error:`, `Available models:`)
    if (firstCol.endsWith(":")) {
      continue;
    }

    // Extract candidate ID token and reject prose/error sentences
    const firstColWords = firstCol.split(/\s+/);
    const idToken = firstColWords[0];
    if (!idToken) continue;

    if (idToken.endsWith(":")) {
      continue;
    }

    if (PROSE_PREFIX_WORDS.has(idToken.toLowerCase())) {
      continue;
    }

    // If there are no structured columns and multiple single-spaced words,
    // only accept if the trailing words are a credit multiplier (e.g. `auto 1.0x`)
    if (columns.length === 1 && firstColWords.length > 1) {
      const rest = firstColWords.slice(1).join(" ");
      if (!/^\d+(?:\.\d+)?x(?:\s+credits?)?$/i.test(rest)) {
        continue;
      }
    }

    // Valid model IDs start with alphanumeric and contain only safe ID chars
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(idToken)) {
      continue;
    }

    let name: string | undefined;
    let creditMultiplier: number | undefined;

    for (let i = 1; i < columns.length; i++) {
      const col = columns[i];
      if (!col) continue;
      const multMatch = col.match(/^(\d+(?:\.\d+)?)x(?:\s+credits?)?$/i);
      if (multMatch && multMatch[1]) {
        creditMultiplier = toOptionalPositiveNumber(multMatch[1]);
      } else if (!name) {
        name = col;
      }
    }

    if (creditMultiplier === undefined) {
      const inlineMult = line.match(/\b(\d+(?:\.\d+)?)x\b/i);
      if (inlineMult && inlineMult[1]) {
        creditMultiplier = toOptionalPositiveNumber(inlineMult[1]);
      }
    }

    const normalized = normalizeDescriptor(
      {
        id: idToken,
        name: name ?? idToken,
        creditMultiplier,
        isDefault,
      },
      "cli"
    );

    if (normalized) {
      entries.push(normalized);
    }
  }

  return deduplicateEntries(entries);
}

/**
 * Dynamically discovers Kiro models via:
 * 1. ACP `initialize` / `session/new` (`availableModels` & `configOptions`)
 * 2. `kiro-cli chat --list-models --format json` (with text-table fallback parser)
 * 3. Safe minimal fallback catalog (`auto`) only if both ACP and CLI are unavailable
 */
export class KiroModelDiscovery {
  private readonly cliPath: string;
  private readonly cwd?: string;
  private readonly requestTimeoutMs: number;
  private readonly cacheTtlMs: number;

  private cachedModels: KiroModelInfo[] = [];
  private cacheExpiresAt = 0;

  constructor(options: KiroPluginOptions = {}) {
    this.cliPath = validateCliPath(options.cliPath ?? DEFAULT_CLI_PATH);
    this.cwd = options.cwd;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.cacheTtlMs = options.modelCacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Discovers available Kiro models using TTL caching unless `forceRefresh` is true
   * or cached entries are fallback-only while fresh ACP metadata is provided.
   */
  async discover(
    options: DiscoverModelsOptions = {}
  ): Promise<KiroModelInfo[]> {
    const now = Date.now();
    const isFallbackOnly =
      this.cachedModels.length > 0 &&
      this.cachedModels.every((m) => m.source === "fallback");
    const hasFreshAcpInput = Boolean(options.acpInit || options.acpSession);

    if (
      !options.forceRefresh &&
      this.cachedModels.length > 0 &&
      now < this.cacheExpiresAt &&
      !(isFallbackOnly && hasFreshAcpInput)
    ) {
      return this.cloneModels(this.cachedModels);
    }

    // Priority 1: ACP session/new and initialize metadata
    const acpModels = this.extractFromAcp(options.acpInit, options.acpSession);
    if (acpModels.length > 0) {
      return this.storeCache(acpModels);
    }

    // Priority 2: kiro-cli chat --list-models --format json
    const cliModels = await this.discoverFromCli();
    if (cliModels.length > 0) {
      return this.storeCache(cliModels);
    }

    // Priority 3: Safe minimal fallback catalog
    return this.storeCache(FALLBACK_MODELS.map((m) => ({ ...m })));
  }

  /**
   * Parses output from `kiro-cli chat --list-models --format json`, falling
   * back to plain-text table/line parsing when JSON parsing fails.
   */
  parseCliModelsOutput(raw: string): KiroModelInfo[] {
    const cleaned = stripAnsi(raw).trim();
    if (!cleaned) return [];

    // Attempt JSON parsing first
    try {
      const parsed: unknown = JSON.parse(cleaned);
      let entries: unknown[] = [];

      if (Array.isArray(parsed)) {
        entries = parsed;
      } else if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        if (Array.isArray(record.models)) {
          entries = record.models;
        } else if (Array.isArray(record.availableModels)) {
          entries = record.availableModels;
        } else if (Array.isArray(record.data)) {
          entries = record.data;
        }
      }

      const normalized = entries
        .map(normalizeJsonModelEntry)
        .filter((m): m is NormalizedModelEntry => m !== null);

      if (normalized.length > 0) {
        return deduplicateEntries(normalized);
      }
    } catch {
      // Fall back to plain-text parser
    }

    return parsePlainTextModels(cleaned);
  }

  getCachedModels(): KiroModelInfo[] {
    return this.cloneModels(this.cachedModels);
  }

  invalidateCache(): void {
    this.cachedModels = [];
    this.cacheExpiresAt = 0;
  }

  private extractFromAcp(
    acpInit?: AcpInitializeResult | null,
    acpSession?: AcpSessionNewResult | null
  ): KiroModelInfo[] {
    const collected: NormalizedModelEntry[] = [];
    const currentModelId = acpSession?.models?.currentModelId;

    if (Array.isArray(acpSession?.models?.availableModels)) {
      for (const desc of acpSession.models.availableModels) {
        const normalized = normalizeDescriptor(desc, "acp", currentModelId);
        if (normalized) {
          collected.push(normalized);
        }
      }
    }

    const fromConfig = extractModelsFromConfigOptions(
      acpSession?.configOptions
    );
    collected.push(...fromConfig);

    if (Array.isArray(acpInit?.models)) {
      for (const desc of acpInit.models) {
        const normalized = normalizeDescriptor(desc, "acp", currentModelId);
        if (normalized) {
          collected.push(normalized);
        }
      }
    }

    return deduplicateEntries(collected);
  }

  private async discoverFromCli(): Promise<KiroModelInfo[]> {
    const jsonResult = await spawnKiroCli(
      this.cliPath,
      ["chat", "--list-models", "--format", "json"],
      {
        cwd: this.cwd,
        timeoutMs: this.requestTimeoutMs,
      }
    );

    if (jsonResult.spawnFailed) {
      return [];
    }

    if (jsonResult.exitCode === 0 && jsonResult.stdout.trim().length > 0) {
      const parsed = this.parseCliModelsOutput(jsonResult.stdout);
      if (parsed.length > 0) {
        return parsed;
      }
    }

    // Fallback CLI invocation without `--format json` in case older CLI rejects the flag
    if (jsonResult.exitCode !== 0 && !jsonResult.timedOut) {
      const textResult = await spawnKiroCli(
        this.cliPath,
        ["chat", "--list-models"],
        {
          cwd: this.cwd,
          timeoutMs: this.requestTimeoutMs,
        }
      );

      if (
        !textResult.spawnFailed &&
        textResult.exitCode === 0 &&
        textResult.stdout.trim().length > 0
      ) {
        return this.parseCliModelsOutput(textResult.stdout);
      }
    }

    return [];
  }

  private cloneModels(models: readonly KiroModelInfo[]): KiroModelInfo[] {
    return models.map((m) => ({ ...m }));
  }

  private storeCache(models: KiroModelInfo[]): KiroModelInfo[] {
    this.cachedModels = this.cloneModels(models);
    this.cacheExpiresAt = Date.now() + this.cacheTtlMs;
    return this.cloneModels(this.cachedModels);
  }
}
