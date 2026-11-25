/**
 * Shared types for opencode-kiro (OpenCode 2.x ACP-compliant Kiro plugin).
 *
 * Security invariants enforced across all modules:
 * 1. NEVER read, scrape, or parse Kiro credential files (~/.kiro, SQLite, Keychain, AWS SSO cache).
 * 2. NEVER export, copy, or reuse Kiro credentials against any non-Kiro provider.
 * 3. All model execution goes strictly through `kiro-cli acp` over JSON-RPC 2.0 stdio.
 */

export const KIRO_PROVIDER_ID = "kiro" as const;
export const PLUGIN_ID = "opencode-kiro" as const;
export const ACP_PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 & Agent Client Protocol (ACP) Wire Types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string;
  type?: "cli" | "client" | "oauth" | string;
}

export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: {
    name: string;
    version?: string;
  };
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
    mcpCapabilities?: {
      http?: boolean;
      sse?: boolean;
    };
  };
  authMethods?: AcpAuthMethod[];
  models?: AcpModelDescriptor[];
}

export interface AcpModelDescriptor {
  id?: string;
  /** kiro-cli 3.6+ ACP session/new returns `modelId` instead of `id` */
  modelId?: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  creditMultiplier?: number;
  reasoning?: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;
  isDefault?: boolean;
}

export interface AcpConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<{
    value: string;
    name?: string;
    description?: string;
  }>;
}

export interface AcpSessionNewParams {
  cwd: string;
  mcpServers: Array<Record<string, unknown>>;
}

export interface AcpSessionNewResult {
  sessionId: string;
  models?: {
    currentModelId?: string;
    availableModels?: AcpModelDescriptor[];
  };
  configOptions?: AcpConfigOption[];
}

export interface AcpContentBlock {
  type: "text" | "image" | "resource" | "resource_link";
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

export interface AcpPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
}

export interface AcpPromptResult {
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    creditsUsed?: number;
  };
}

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: {
    sessionUpdate:
      | "agent_message_chunk"
      | "agent_thought_chunk"
      | "tool_call"
      | "tool_call_update"
      | "plan"
      | "available_commands_update"
      | "current_mode_update"
      | string;
    content?: AcpContentBlock;
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
    rawOutput?: unknown;
    [key: string]: unknown;
  };
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface AcpPermissionRequestParams {
  sessionId: string;
  toolCall?: {
    toolCallId: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
  };
  options: AcpPermissionOption[];
}

export interface AcpPermissionResponse {
  outcome:
    | { outcome: "selected"; optionId: string }
    | { outcome: "cancelled" };
}

// ---------------------------------------------------------------------------
// Kiro Extensions (_kiro.dev/metadata, _kiro/account/getUsage)
// ---------------------------------------------------------------------------

export interface KiroCreditsSnapshot {
  /** Credits consumed in current billing period */
  used: number;
  /** Total plan credit cap (0 or null if unlimited/unknown) */
  limit: number | null;
  /** Remaining credits (derived safely if not provided directly) */
  remaining: number | null;
  /** Optional add-on/overage credits pool */
  addonRemaining?: number | null;
  /** Percentage of plan credits consumed (0-100, clamped) */
  percentUsed: number | null;
  /** Context window usage percentage reported by _kiro.dev/metadata */
  contextUsagePercent: number | null;
  /** Credits consumed by the most recent turn, if reported */
  lastTurnCredits: number | null;
  /** Subscription tier (e.g. Free, Pro, Pro+, Power, Enterprise) */
  planName: string | null;
  /** ISO-8601 billing reset date if available */
  resetAt: string | null;
  /** Active model ID in Kiro */
  activeModel: string | null;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
  /** Source of the snapshot */
  source: "acp_metadata" | "acp_usage" | "initial";
}

// ---------------------------------------------------------------------------
// Auth & Model Discovery Types
// ---------------------------------------------------------------------------

export interface KiroAuthStatus {
  authenticated: boolean;
  /** Strictly managed by kiro-cli — never contains raw tokens or secrets */
  managedBy: "kiro-cli";
  accountLabel: string | null;
  authMethod: string | null;
  cliAvailable: boolean;
  cliPath: string;
  checkedAt: string;
  error?: string;
}

export interface KiroModelInfo {
  id: string;
  /** Fully qualified OpenCode model ID: `kiro/<id>` */
  qualifiedId: `kiro/${string}`;
  name: string;
  description?: string;
  contextLimit: number;
  outputLimit: number;
  creditMultiplier?: number;
  reasoning: boolean;
  toolCall: boolean;
  vision: boolean;
  isDefault: boolean;
  source: "acp" | "cli" | "fallback";
}

export interface KiroPluginOptions {
  /** Path or binary name for kiro-cli (defaults to "kiro-cli") */
  cliPath?: string;
  /** Extra CLI args passed before `acp` */
  acpArgs?: string[];
  /** Default working directory for ACP sessions */
  cwd?: string;
  /** Request timeout in milliseconds */
  requestTimeoutMs?: number;
  /** Model discovery cache TTL in milliseconds */
  modelCacheTtlMs?: number;
  /** Permission policy for ACP session/request_permission callbacks */
  permissionPolicy?: "deny_by_default" | "allow_read_only" | "allow_once";
  /** Optional custom permission handler */
  onPermissionRequest?: (
    params: AcpPermissionRequestParams
  ) => Promise<AcpPermissionResponse>;
}

// ---------------------------------------------------------------------------
// OpenCode 2.x Plugin Surface Types (Self-contained & @opencode/plugin compatible)
// ---------------------------------------------------------------------------

export interface OpenCodeProviderModelConfig {
  name: string;
  limit?: {
    context?: number;
    output?: number;
  };
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  cost?: {
    input?: number;
    output?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface OpenCodeProviderConfig {
  name: string;
  package?: string;
  settings?: Record<string, unknown>;
  models: Record<string, OpenCodeProviderModelConfig>;
  /** Explicit ownership marker */
  owner?: string;
}

export interface OpenCodeConfig {
  providers?: Record<string, OpenCodeProviderConfig>;
  provider?: Record<string, OpenCodeProviderConfig>;
  [key: string]: unknown;
}

export interface OpenCodeAuthMethod {
  type: "oauth" | "api" | "cli" | string;
  label: string;
  description?: string;
  authorize?: () => Promise<{
    url?: string;
    instructions?: string;
    method?: string;
    callback?: () => Promise<Record<string, unknown>>;
  }>;
}

export interface OpenCodeAuthHook {
  provider: string;
  loader?: (
    auth: unknown,
    provider: string
  ) => Promise<Record<string, unknown>>;
  methods: OpenCodeAuthMethod[];
}

export interface OpenCodePluginContext {
  directory: string;
  project?: { id?: string; name?: string; root?: string };
  client?: {
    tui?: {
      showToast?: (opts: {
        title?: string;
        message: string;
        variant?: "info" | "success" | "warning" | "error";
      }) => Promise<void> | void;
    };
  };
  rpc?: {
    register?: (namespace: string, handlers: Record<string, (...args: unknown[]) => unknown>) => void;
  };
}

export interface OpenCodeServerHooks {
  auth?: OpenCodeAuthHook;
  config?: (config: OpenCodeConfig) => Promise<OpenCodeConfig | void> | OpenCodeConfig | void;
  provider?: {
    id: string;
    ownsModel: (modelId: string) => boolean;
    getLanguageModel: (modelId: string) => unknown;
    listModels: () => Promise<KiroModelInfo[]>;
  };
  rpc?: Record<string, (...args: unknown[]) => unknown>;
  event?: (payload: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void> | void;
  dispose?: () => Promise<void> | void;
}

export interface OpenCodeServerPluginModule {
  id: string;
  server: (ctx: OpenCodePluginContext, options?: KiroPluginOptions) => Promise<OpenCodeServerHooks>;
  setup?: (ctx: OpenCodePluginContext, options?: KiroPluginOptions) => Promise<OpenCodeServerHooks>;
}
