/**
 * Headless + OpenTUI-compatible slot renderers, reactive controller, and slash
 * commands for the OpenCode 2.x Kiro TUI plugin.
 *
 * Designed to compile cleanly under strict TypeScript without requiring
 * `@opentui/solid` to be installed at typecheck time.
 */

import type { KiroLoginRpcResult, KiroRpcContract, RpcCaller } from "../rpc";
import type {
  KiroAuthStatus,
  KiroCreditsSnapshot,
  KiroModelInfo,
} from "../types";
import { PLUGIN_ID } from "../types";
import {
  computeCreditSeverity,
  createInitialCreditsSnapshot,
  formatCreditsCompact,
  formatCreditsPanelLines,
  sanitizeDisplayText,
  type CreditSeverity,
} from "./format";

// ---------------------------------------------------------------------------
// OpenCode 2.x TUI Host API Surface (Self-Contained Type Definitions)
// ---------------------------------------------------------------------------

export type TuiToastVariant = "info" | "success" | "warning" | "error";

export interface TuiToastOptions {
  title?: string;
  message: string;
  variant?: TuiToastVariant;
  durationMs?: number;
}

export type TuiSlotName =
  | "sidebar_footer"
  | "sidebar_content"
  | "app_bottom"
  | (string & {});

export interface TuiRenderNode {
  type: "text" | "box" | "row" | "column";
  id?: string;
  slot?: TuiSlotName;
  text?: string;
  lines?: string[];
  severity?: CreditSeverity;
  children?: TuiRenderNode[];
  style?: Record<string, string | number | boolean>;
}

export interface TuiSlotRegistration {
  id: string;
  slot: TuiSlotName;
  priority?: number;
  render: () => TuiRenderNode;
}

export interface TuiCommandDefinition {
  name: string;
  description: string;
  aliases?: string[];
  handler: (args?: string[]) => Promise<void> | void;
}

export interface TuiPluginApi {
  rpc?: RpcCaller;
  slots?: {
    register: (registration: TuiSlotRegistration) => (() => void) | void;
  };
  command?: {
    register: (command: TuiCommandDefinition) => (() => void) | void;
  };
  ui?: {
    toast?: (opts: TuiToastOptions) => Promise<void> | void;
  };
  events?: {
    on?: (
      event: string,
      listener: (payload: unknown) => void
    ) => (() => void) | void;
  };
}

export interface TuiPluginOptions {
  /** Polling interval in ms for background credit refresh (0 disables polling) */
  pollIntervalMs?: number;
  /** Whether to trigger an initial non-blocking refresh on mount (default: true) */
  autoRefresh?: boolean;
}

// ---------------------------------------------------------------------------
// Controller State & Implementation
// ---------------------------------------------------------------------------

export interface KiroTuiState {
  credits: KiroCreditsSnapshot;
  auth: KiroAuthStatus | null;
  models: KiroModelInfo[];
  activeModel: string | null;
  loading: boolean;
  lastError: string | null;
}

export type KiroTuiStateListener = (state: Readonly<KiroTuiState>) => void;

const DEFAULT_POLL_INTERVAL_MS = 30_000;

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return sanitizeDisplayText(err.message || err.name);
  }
  if (typeof err === "string") {
    return sanitizeDisplayText(err);
  }
  return "Unknown RPC error";
}

function severityToColor(severity: CreditSeverity): string {
  switch (severity) {
    case "critical":
      return "red";
    case "warning":
      return "yellow";
    case "normal":
      return "green";
    case "unknown":
      return "gray";
  }
}

function safeRpcCall<T>(fn: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(fn);
}

function isValidCreditsSnapshot(val: unknown): val is KiroCreditsSnapshot {
  return (
    val !== null &&
    typeof val === "object" &&
    "used" in val &&
    "source" in val
  );
}

function isValidAuthStatus(val: unknown): val is KiroAuthStatus {
  return (
    val !== null &&
    typeof val === "object" &&
    "authenticated" in val &&
    "cliAvailable" in val
  );
}

export class KiroTuiController {
  private readonly rpc: KiroRpcContract | null;
  private readonly pollIntervalMs: number;
  private readonly listeners = new Set<KiroTuiStateListener>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private inFlightCount = 0;

  private creditsSeq = 0;
  private authSeq = 0;
  private modelsSeq = 0;
  private activeModelSeq = 0;

  private state: KiroTuiState = {
    credits: createInitialCreditsSnapshot(),
    auth: null,
    models: [],
    activeModel: null,
    loading: false,
    lastError: null,
  };

  constructor(
    rpc: KiroRpcContract | null,
    options?: Pick<TuiPluginOptions, "pollIntervalMs">
  ) {
    this.rpc = rpc;
    const rawInterval = options?.pollIntervalMs;
    this.pollIntervalMs =
      typeof rawInterval === "number" && Number.isFinite(rawInterval) && rawInterval >= 0
        ? rawInterval
        : DEFAULT_POLL_INTERVAL_MS;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  getState(): Readonly<KiroTuiState> {
    return {
      ...this.state,
      credits: { ...this.state.credits },
      auth: this.state.auth ? { ...this.state.auth } : null,
      models: [...this.state.models],
    };
  }

  subscribe(listener: KiroTuiStateListener): () => void {
    if (this.disposed) {
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(patch: Partial<KiroTuiState>): void {
    if (this.disposed) {
      return;
    }
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Isolate listener failures so UI updates never crash the controller.
      }
    }
  }

  private beginRequest(): void {
    this.inFlightCount += 1;
    if (!this.state.loading) {
      this.setState({ loading: true });
    }
  }

  private endRequest(patch: Partial<KiroTuiState> = {}): void {
    this.inFlightCount = Math.max(0, this.inFlightCount - 1);
    this.setState({
      ...patch,
      loading: this.inFlightCount > 0,
    });
  }

  /**
   * Refreshes auth status, credits snapshot, and active model from the server plugin.
   * Never throws; records sanitized errors in `state.lastError`.
   */
  async refreshAll(): Promise<Readonly<KiroTuiState>> {
    if (this.disposed) {
      return this.getState();
    }

    if (!this.rpc) {
      this.setState({
        loading: this.inFlightCount > 0,
        lastError: "Kiro server RPC unavailable",
      });
      return this.getState();
    }

    const rpc = this.rpc;
    const authSeq = ++this.authSeq;
    const creditsSeq = ++this.creditsSeq;
    const activeModelSeq = ++this.activeModelSeq;

    this.beginRequest();
    try {
      const [authResult, creditsResult, activeModelResult] =
        await Promise.allSettled([
          safeRpcCall(() => rpc.getAuthStatus()),
          safeRpcCall(() => rpc.getCredits()),
          safeRpcCall(() => rpc.getActiveModel()),
        ]);

      if (this.disposed) {
        return this.getState();
      }

      const errors: string[] = [];
      const patch: Partial<KiroTuiState> = {};

      if (authResult.status === "fulfilled") {
        if (authSeq === this.authSeq && isValidAuthStatus(authResult.value)) {
          patch.auth = authResult.value;
        }
      } else {
        errors.push(extractErrorMessage(authResult.reason));
      }

      let creditsActiveModel: string | null = null;
      if (creditsResult.status === "fulfilled") {
        if (
          creditsSeq === this.creditsSeq &&
          isValidCreditsSnapshot(creditsResult.value)
        ) {
          patch.credits = creditsResult.value;
          if (
            typeof creditsResult.value.activeModel === "string" &&
            creditsResult.value.activeModel.trim().length > 0
          ) {
            creditsActiveModel = creditsResult.value.activeModel;
          }
        }
      } else {
        errors.push(extractErrorMessage(creditsResult.reason));
      }

      if (activeModelResult.status === "fulfilled") {
        if (activeModelSeq === this.activeModelSeq) {
          const rpcActiveModel =
            typeof activeModelResult.value === "string" &&
            activeModelResult.value.trim().length > 0
              ? activeModelResult.value
              : null;

          if (rpcActiveModel) {
            patch.activeModel = rpcActiveModel;
            if (patch.credits && !patch.credits.activeModel) {
              patch.credits = {
                ...patch.credits,
                activeModel: rpcActiveModel,
              };
            }
          } else if (creditsActiveModel) {
            patch.activeModel = creditsActiveModel;
          }
        }
      } else {
        if (activeModelSeq === this.activeModelSeq && creditsActiveModel) {
          patch.activeModel = creditsActiveModel;
        }
        errors.push(extractErrorMessage(activeModelResult.reason));
      }

      patch.lastError = errors.length > 0 ? errors[0] ?? null : null;
      this.endRequest(patch);
      return this.getState();
    } catch (err) {
      if (!this.disposed) {
        this.endRequest({ lastError: extractErrorMessage(err) });
      }
      return this.getState();
    }
  }

  async refreshCredits(force = false): Promise<KiroCreditsSnapshot> {
    if (this.disposed) {
      return this.state.credits;
    }

    if (!this.rpc) {
      this.setState({
        loading: this.inFlightCount > 0,
        lastError: "Kiro server RPC unavailable",
      });
      return this.state.credits;
    }

    const rpc = this.rpc;
    const seq = ++this.creditsSeq;
    this.beginRequest();
    try {
      const snapshot = await safeRpcCall(() =>
        force ? rpc.refreshCredits() : rpc.getCredits()
      );
      if (this.disposed) {
        return this.state.credits;
      }
      if (seq === this.creditsSeq && isValidCreditsSnapshot(snapshot)) {
        const nextActiveModel =
          typeof snapshot.activeModel === "string" &&
          snapshot.activeModel.trim().length > 0
            ? snapshot.activeModel
            : this.state.activeModel;
        this.endRequest({
          credits: snapshot,
          activeModel: nextActiveModel,
          lastError: null,
        });
        return snapshot;
      }
      this.endRequest();
      return this.state.credits;
    } catch (err) {
      if (!this.disposed) {
        this.endRequest(
          seq === this.creditsSeq
            ? { lastError: extractErrorMessage(err) }
            : {}
        );
      }
      return this.state.credits;
    }
  }

  async refreshAuth(): Promise<KiroAuthStatus | null> {
    if (this.disposed) {
      return this.state.auth;
    }

    if (!this.rpc) {
      this.setState({ lastError: "Kiro server RPC unavailable" });
      return this.state.auth;
    }

    const rpc = this.rpc;
    const seq = ++this.authSeq;
    try {
      const auth = await safeRpcCall(() => rpc.getAuthStatus());
      if (!this.disposed && seq === this.authSeq && isValidAuthStatus(auth)) {
        this.setState({ auth, lastError: null });
      }
      return this.state.auth;
    } catch (err) {
      if (!this.disposed && seq === this.authSeq) {
        this.setState({ lastError: extractErrorMessage(err) });
      }
      return this.state.auth;
    }
  }

  async refreshModels(force = false): Promise<KiroModelInfo[]> {
    if (this.disposed) {
      return this.state.models;
    }

    if (!this.rpc) {
      this.setState({
        loading: this.inFlightCount > 0,
        lastError: "Kiro server RPC unavailable",
      });
      return this.state.models;
    }

    const rpc = this.rpc;
    const seq = ++this.modelsSeq;
    this.beginRequest();
    try {
      const models = await safeRpcCall(() => rpc.listModels(force));
      if (this.disposed) {
        return this.state.models;
      }
      if (seq === this.modelsSeq && Array.isArray(models)) {
        this.endRequest({
          models,
          lastError: null,
        });
        return models;
      }
      this.endRequest();
      return this.state.models;
    } catch (err) {
      if (!this.disposed) {
        this.endRequest(
          seq === this.modelsSeq
            ? { lastError: extractErrorMessage(err) }
            : {}
        );
      }
      return this.state.models;
    }
  }

  async triggerLogin(): Promise<KiroLoginRpcResult> {
    const unavailableStatus: KiroAuthStatus = this.state.auth ?? {
      authenticated: false,
      managedBy: "kiro-cli",
      accountLabel: null,
      authMethod: null,
      cliAvailable: false,
      cliPath: "kiro-cli",
      checkedAt: new Date().toISOString(),
      error: "Kiro server RPC unavailable",
    };

    if (this.disposed || !this.rpc) {
      const message = "Kiro server RPC unavailable";
      if (!this.disposed) {
        this.setState({ lastError: message });
      }
      return {
        ok: false,
        status: unavailableStatus,
        message,
      };
    }

    const rpc = this.rpc;
    const authSeq = ++this.authSeq;
    this.beginRequest();
    try {
      const result = await safeRpcCall(() => rpc.login());
      if (!this.disposed) {
        const sanitizedMessage = sanitizeDisplayText(result?.message ?? "");
        const nextAuth = isValidAuthStatus(result?.status)
          ? result.status
          : unavailableStatus;
        this.endRequest({
          ...(authSeq === this.authSeq ? { auth: nextAuth } : {}),
          lastError: result?.ok ? null : sanitizedMessage || "Login failed",
        });
        if (result?.ok) {
          void this.refreshCredits(true);
        }
        return {
          ok: Boolean(result?.ok),
          status: nextAuth,
          message: sanitizedMessage,
        };
      }
      return {
        ok: Boolean(result?.ok),
        status: isValidAuthStatus(result?.status)
          ? result.status
          : unavailableStatus,
        message: sanitizeDisplayText(result?.message ?? ""),
      };
    } catch (err) {
      const message = extractErrorMessage(err);
      if (!this.disposed) {
        this.endRequest({
          lastError: message,
        });
      }
      return {
        ok: false,
        status: {
          ...unavailableStatus,
          checkedAt: new Date().toISOString(),
          error: message,
        },
        message,
      };
    }
  }

  startPolling(intervalMs?: number): void {
    if (this.disposed || !this.rpc) {
      return;
    }
    this.stopPolling();

    const ms =
      typeof intervalMs === "number" && Number.isFinite(intervalMs)
        ? intervalMs
        : this.pollIntervalMs;

    if (ms <= 0) {
      return;
    }

    this.pollTimer = setInterval(() => {
      if (!this.disposed) {
        void this.refreshCredits(false);
      }
    }, ms);

    if (
      this.pollTimer &&
      typeof this.pollTimer === "object" &&
      "unref" in this.pollTimer &&
      typeof this.pollTimer.unref === "function"
    ) {
      this.pollTimer.unref();
    }
  }

  stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.inFlightCount = 0;
    this.stopPolling();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Slot Renderers
  // -------------------------------------------------------------------------

  private getEffectiveSeverity(): CreditSeverity {
    if (
      this.state.auth &&
      (!this.state.auth.cliAvailable || !this.state.auth.authenticated)
    ) {
      return "unknown";
    }
    return computeCreditSeverity(this.state.credits);
  }

  /**
   * Compact single-line pill for `sidebar_footer`.
   */
  renderSidebarFooter(): TuiRenderNode {
    const severity = this.getEffectiveSeverity();
    const label = formatCreditsCompact(this.state.credits, this.state.auth);

    return {
      type: "text",
      id: `${PLUGIN_ID}:sidebar_footer`,
      slot: "sidebar_footer",
      text: label,
      severity,
      style: {
        color: severityToColor(severity),
        bold: severity === "critical",
      },
    };
  }

  /**
   * Multi-line credits detail card for `sidebar_content`.
   */
  renderSidebarContent(): TuiRenderNode {
    const severity = this.getEffectiveSeverity();
    const lines = formatCreditsPanelLines(this.state.credits, this.state.auth);

    if (this.state.loading) {
      lines.push("Syncing...");
    } else if (this.state.lastError) {
      lines.push(`Notice: ${sanitizeDisplayText(this.state.lastError)}`);
    }

    return {
      type: "box",
      id: `${PLUGIN_ID}:sidebar_content`,
      slot: "sidebar_content",
      text: lines.join("\n"),
      lines,
      severity,
      style: {
        borderColor: severityToColor(severity),
      },
      children: lines.map((line, index) => ({
        type: "text" as const,
        id: `${PLUGIN_ID}:sidebar_content:line:${index}`,
        text: line,
        severity: index === 0 ? severity : undefined,
        style: index === 0 ? { bold: true, color: severityToColor(severity) } : undefined,
      })),
    };
  }

  /**
   * Compact status bar badge for `app_bottom`.
   */
  renderAppBottom(): TuiRenderNode {
    const severity = this.getEffectiveSeverity();
    const label = formatCreditsCompact(this.state.credits, this.state.auth);

    return {
      type: "text",
      id: `${PLUGIN_ID}:app_bottom`,
      slot: "app_bottom",
      text: label,
      severity,
      style: {
        color: severityToColor(severity),
      },
    };
  }

  createSlotRegistrations(): TuiSlotRegistration[] {
    return [
      {
        id: `${PLUGIN_ID}:sidebar_footer`,
        slot: "sidebar_footer",
        priority: 50,
        render: () => this.renderSidebarFooter(),
      },
      {
        id: `${PLUGIN_ID}:sidebar_content`,
        slot: "sidebar_content",
        priority: 50,
        render: () => this.renderSidebarContent(),
      },
      {
        id: `${PLUGIN_ID}:app_bottom`,
        slot: "app_bottom",
        priority: 50,
        render: () => this.renderAppBottom(),
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// Slash Command Builders
// ---------------------------------------------------------------------------

async function showToast(
  api: TuiPluginApi,
  opts: TuiToastOptions
): Promise<void> {
  if (!api.ui?.toast) {
    return;
  }
  await api.ui.toast({
    ...opts,
    title: opts.title ? sanitizeDisplayText(opts.title) : undefined,
    message: sanitizeDisplayText(opts.message),
  });
}

function severityToToastVariant(severity: CreditSeverity): TuiToastVariant {
  switch (severity) {
    case "critical":
      return "error";
    case "warning":
      return "warning";
    case "normal":
    case "unknown":
      return "info";
  }
}

/**
 * Creates the four Kiro slash commands for the OpenCode 2.x TUI:
 * `/kiro-credits`, `/kiro-login`, `/kiro-models`, and `/kiro-status`.
 */
export function createKiroTuiCommands(
  controller: KiroTuiController,
  api: TuiPluginApi
): TuiCommandDefinition[] {
  return [
    {
      name: "/kiro-credits",
      description: "Refresh and display current Kiro credits breakdown",
      handler: async () => {
        await Promise.all([
          controller.refreshAuth(),
          controller.refreshCredits(true),
        ]);
        const state = controller.getState();
        const lines = formatCreditsPanelLines(state.credits, state.auth);
        if (state.lastError) {
          lines.push(`Error: ${state.lastError}`);
        }
        const severity = computeCreditSeverity(state.credits);
        await showToast(api, {
          title: "Kiro Credits",
          message: lines.join("\n"),
          variant: state.lastError ? "warning" : severityToToastVariant(severity),
        });
      },
    },
    {
      name: "/kiro-login",
      description: "Authenticate with Kiro via kiro-cli login",
      handler: async () => {
        const result = await controller.triggerLogin();
        const details = result.status.accountLabel
          ? ` (${sanitizeDisplayText(result.status.accountLabel)})`
          : "";
        await showToast(api, {
          title: "Kiro Login",
          message: result.ok
            ? `${result.message}${details}`
            : `Login failed: ${result.message}`,
          variant: result.ok ? "success" : "error",
        });
      },
    },
    {
      name: "/kiro-models",
      description: "Refresh and list discovered Kiro models",
      handler: async () => {
        const models = await controller.refreshModels(true);
        const state = controller.getState();

        if (models.length === 0) {
          await showToast(api, {
            title: "Kiro Models",
            message: state.lastError
              ? `No models available (${state.lastError})`
              : "No Kiro models discovered. Run /kiro-login if not authenticated.",
            variant: state.lastError ? "warning" : "info",
          });
          return;
        }

        const lines = models.map((model) => {
          const defaultTag = model.isDefault ? " [default]" : "";
          const activeTag =
            state.activeModel === model.id ||
            state.activeModel === model.qualifiedId
              ? " [active]"
              : "";
          const multiplierTag =
            typeof model.creditMultiplier === "number" &&
            Number.isFinite(model.creditMultiplier)
              ? ` (${model.creditMultiplier}x cr)`
              : "";
          return `- ${sanitizeDisplayText(model.qualifiedId)} — ${sanitizeDisplayText(model.name)}${multiplierTag}${defaultTag}${activeTag}`;
        });

        await showToast(api, {
          title: `Kiro Models (${models.length})`,
          message: lines.join("\n"),
          variant: "info",
        });
      },
    },
    {
      name: "/kiro-status",
      description: "Display Kiro authentication status, CLI path, model, and credits summary",
      handler: async () => {
        const state = await controller.refreshAll();
        const auth = state.auth;
        const lines: string[] = [];

        if (!auth) {
          lines.push("Auth: Unknown (server RPC unavailable)");
        } else if (!auth.cliAvailable) {
          lines.push(`Auth: kiro-cli not found (${sanitizeDisplayText(auth.cliPath)})`);
        } else if (auth.authenticated) {
          const label = auth.accountLabel
            ? ` as ${sanitizeDisplayText(auth.accountLabel)}`
            : "";
          const method = auth.authMethod
            ? ` via ${sanitizeDisplayText(auth.authMethod)}`
            : "";
          lines.push(`Auth: Authenticated${label}${method}`);
          lines.push(`CLI: ${sanitizeDisplayText(auth.cliPath)}`);
        } else {
          lines.push("Auth: Not logged in (run /kiro-login)");
          lines.push(`CLI: ${sanitizeDisplayText(auth.cliPath)}`);
        }

        const activeModel = state.activeModel ?? state.credits.activeModel;
        lines.push(`Model: ${activeModel ? sanitizeDisplayText(activeModel) : "default"}`);
        lines.push(`Credits: ${formatCreditsCompact(state.credits, state.auth)}`);

        if (state.lastError) {
          lines.push(`Last Error: ${sanitizeDisplayText(state.lastError)}`);
        }

        await showToast(api, {
          title: "Kiro Status",
          message: lines.join("\n"),
          variant: auth?.authenticated ? "info" : "warning",
        });
      },
    },
  ];
}
