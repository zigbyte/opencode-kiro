// src/rpc.ts
var KIRO_RPC_NAMESPACE = "opencode-kiro";
var KIRO_RPC_METHODS = {
  getCredits: `${KIRO_RPC_NAMESPACE}.getCredits`,
  refreshCredits: `${KIRO_RPC_NAMESPACE}.refreshCredits`,
  getAuthStatus: `${KIRO_RPC_NAMESPACE}.getAuthStatus`,
  login: `${KIRO_RPC_NAMESPACE}.login`,
  listModels: `${KIRO_RPC_NAMESPACE}.listModels`,
  getActiveModel: `${KIRO_RPC_NAMESPACE}.getActiveModel`,
  setActiveModel: `${KIRO_RPC_NAMESPACE}.setActiveModel`
};
function createKiroRpcClient(caller) {
  return {
    getCredits: () => caller.call(KIRO_RPC_METHODS.getCredits),
    refreshCredits: () => caller.call(KIRO_RPC_METHODS.refreshCredits),
    getAuthStatus: () => caller.call(KIRO_RPC_METHODS.getAuthStatus),
    login: () => caller.call(KIRO_RPC_METHODS.login),
    listModels: (forceRefresh) => caller.call(KIRO_RPC_METHODS.listModels, forceRefresh ?? false),
    getActiveModel: () => caller.call(KIRO_RPC_METHODS.getActiveModel),
    setActiveModel: (modelId) => caller.call(KIRO_RPC_METHODS.setActiveModel, modelId)
  };
}

// src/types.ts
var PLUGIN_ID = "opencode-kiro";

// src/tui/format.ts
var ANSI_OSC_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
var ANSI_CSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
var ANSI_C1_CSI_REGEX = /\x9b[0-9;?]*[ -/]*[@-~]/g;
var ANSI_ESC_REGEX = /\x1b[@-Z\\-_]/g;
var CONTROL_CHARS_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g;
var BEARER_TOKEN_REGEX = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
var JWT_REGEX = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
var PREFIXED_KEY_REGEX = /\b(?:sk|pk|kiro)-[A-Za-z0-9_-]{8,}\b/gi;
var AWS_KEY_REGEX = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
var GITHUB_TOKEN_REGEX = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g;
var SECRET_KV_REGEX = /((?:["']?[A-Za-z0-9_]*?(?:access_?token|refresh_?token|id_?token|api_?key|secret(?:_?(?:access_?)?key)?))["']?\s*[:=]\s*)(["']?)[A-Za-z0-9._~+/=-]{8,}\2/gi;
function sanitizeDisplayText(text) {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }
  return text.replace(/\r\n?/g, `
`).replace(ANSI_OSC_REGEX, "").replace(ANSI_CSI_REGEX, "").replace(ANSI_C1_CSI_REGEX, "").replace(ANSI_ESC_REGEX, "").replace(CONTROL_CHARS_REGEX, "").replace(BEARER_TOKEN_REGEX, "Bearer [REDACTED]").replace(JWT_REGEX, "[REDACTED_JWT]").replace(PREFIXED_KEY_REGEX, "[REDACTED]").replace(AWS_KEY_REGEX, "[REDACTED]").replace(GITHUB_TOKEN_REGEX, "[REDACTED]").replace(SECRET_KV_REGEX, "$1$2[REDACTED]$2");
}
function sanitizeSingleLine(text) {
  return sanitizeDisplayText(text).replace(/\s*\n\s*/g, " ").trim();
}
function computeCreditSeverity(snapshot) {
  const hasValidLimit = snapshot.limit != null && Number.isFinite(snapshot.limit) && snapshot.limit > 0;
  const exhausted = hasValidLimit && (snapshot.remaining != null && Number.isFinite(snapshot.remaining) && snapshot.remaining <= 0 || Number.isFinite(snapshot.used) && snapshot.used >= snapshot.limit);
  if (snapshot.percentUsed == null || !Number.isFinite(snapshot.percentUsed)) {
    return exhausted ? "critical" : "unknown";
  }
  if (snapshot.percentUsed >= 95 || exhausted) {
    return "critical";
  }
  if (snapshot.percentUsed >= 80) {
    return "warning";
  }
  return "normal";
}
function formatCreditsNumber(val) {
  if (typeof val !== "number" || !Number.isFinite(val) || Math.abs(val) >= 1000000000000000) {
    return "--";
  }
  if (val > 0 && val < 0.1) {
    const subRounded = Math.round(val * 1e4) / 1e4;
    const subNormalized = Object.is(subRounded, -0) ? 0 : subRounded;
    if (subNormalized === 0)
      return "0";
    return subNormalized.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }
  const scaled = val * 10;
  if (!Number.isFinite(scaled)) {
    return "--";
  }
  const rounded = Math.round(scaled) / 10;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  const negative = normalized < 0;
  const abs = Math.abs(normalized);
  const isInt = Math.abs(abs - Math.round(abs)) < 0.000000001;
  const fixed = isInt ? String(Math.round(abs)) : abs.toFixed(1);
  const parts = fixed.split(".");
  const intPart = parts[0] ?? "0";
  const decPart = parts[1];
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${decPart !== undefined ? `${withCommas}.${decPart}` : withCommas}`;
}
function renderProgressBar(percent, width = 16) {
  const safeWidth = typeof width === "number" && Number.isFinite(width) ? Math.max(1, Math.min(64, Math.floor(width))) : 16;
  if (percent == null || typeof percent !== "number" || !Number.isFinite(percent)) {
    return `[${"░".repeat(safeWidth)}]`;
  }
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.max(0, Math.min(safeWidth, Math.round(clamped / 100 * safeWidth)));
  const empty = Math.max(0, safeWidth - filled);
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}
function formatResetDate(resetAt, nowMs = Date.now()) {
  if (!resetAt || typeof resetAt !== "string") {
    return "";
  }
  const trimmed = resetAt.trim();
  if (!trimmed) {
    return "";
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const date = new Date(timestamp);
  const isoDate = date.toISOString().slice(0, 10);
  if (Number.isFinite(nowMs)) {
    const diffMs = timestamp - nowMs;
    if (diffMs > 0) {
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      if (hours < 24) {
        return `in ${Math.max(1, hours)}h (${isoDate})`;
      }
      const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      if (days <= 60) {
        return `in ${days}d (${isoDate})`;
      }
    }
  }
  return isoDate;
}
function formatCreditsCompact(snapshot, auth) {
  if (auth) {
    if (!auth.cliAvailable) {
      return "Kiro: CLI not found";
    }
    if (!auth.authenticated) {
      return "Kiro: Not logged in (run /kiro-login)";
    }
  }
  if (snapshot.limit != null && Number.isFinite(snapshot.limit) && snapshot.limit > 0) {
    const usedStr = formatCreditsNumber(snapshot.used);
    const limitStr = formatCreditsNumber(snapshot.limit);
    const pctStr = snapshot.percentUsed != null && Number.isFinite(snapshot.percentUsed) ? ` (${Math.round(Math.max(0, Math.min(100, snapshot.percentUsed)))}%)` : "";
    return sanitizeDisplayText(`Kiro: ${usedStr}/${limitStr} cr${pctStr}`);
  }
  if (snapshot.source !== "initial" && Number.isFinite(snapshot.used)) {
    return sanitizeDisplayText(`Kiro: ${formatCreditsNumber(snapshot.used)} cr used`);
  }
  return "Kiro: -- cr";
}
function formatCreditsPanelLines(snapshot, auth) {
  const lines = [];
  const planLabel = snapshot.planName ? sanitizeSingleLine(snapshot.planName) : "";
  const planSuffix = planLabel ? ` (${planLabel})` : "";
  lines.push(`Kiro Credits${planSuffix}`);
  if (auth) {
    if (!auth.cliAvailable) {
      lines.push("Status: kiro-cli not found");
      lines.push("Install kiro-cli and ensure it is available on PATH.");
      return lines.map(sanitizeDisplayText);
    }
    if (!auth.authenticated) {
      lines.push("Status: Not logged in");
      lines.push("Run /kiro-login or 'kiro-cli login' to authenticate.");
      return lines.map(sanitizeDisplayText);
    }
  }
  const pctText = snapshot.percentUsed != null && Number.isFinite(snapshot.percentUsed) ? `${Math.round(Math.max(0, Math.min(100, snapshot.percentUsed)))}%` : "--%";
  lines.push(`Usage: ${renderProgressBar(snapshot.percentUsed, 16)} ${pctText}`);
  if (snapshot.limit != null && Number.isFinite(snapshot.limit) && snapshot.limit > 0) {
    const rawRemaining = snapshot.remaining != null && Number.isFinite(snapshot.remaining) ? snapshot.remaining : snapshot.limit - snapshot.used;
    const remaining = Number.isFinite(rawRemaining) ? Math.max(0, rawRemaining) : 0;
    lines.push(`Credits: ${formatCreditsNumber(snapshot.used)} / ${formatCreditsNumber(snapshot.limit)} (${formatCreditsNumber(remaining)} remaining)`);
  } else if (snapshot.source !== "initial" && Number.isFinite(snapshot.used)) {
    lines.push(`Credits: ${formatCreditsNumber(snapshot.used)} used`);
  } else {
    lines.push("Credits: --");
  }
  if (snapshot.addonRemaining != null && Number.isFinite(snapshot.addonRemaining)) {
    lines.push(`Add-on Pool: ${formatCreditsNumber(Math.max(0, snapshot.addonRemaining))} remaining`);
  }
  if (snapshot.lastTurnCredits != null && Number.isFinite(snapshot.lastTurnCredits)) {
    lines.push(`Last Turn: ${formatCreditsNumber(snapshot.lastTurnCredits)} cr`);
  }
  if (snapshot.contextUsagePercent != null && Number.isFinite(snapshot.contextUsagePercent)) {
    const ctxPct = Math.round(Math.max(0, Math.min(100, snapshot.contextUsagePercent)));
    lines.push(`Context: ${ctxPct}%`);
  }
  if (snapshot.activeModel) {
    const modelLabel = sanitizeSingleLine(snapshot.activeModel);
    if (modelLabel) {
      lines.push(`Model: ${modelLabel}`);
    }
  }
  const resetFormatted = formatResetDate(snapshot.resetAt);
  if (resetFormatted) {
    lines.push(`Resets: ${resetFormatted}`);
  }
  if (auth?.accountLabel) {
    const accountLabel = sanitizeSingleLine(auth.accountLabel);
    if (accountLabel) {
      lines.push(`Account: ${accountLabel}`);
    }
  }
  return lines.map(sanitizeDisplayText);
}
function createInitialCreditsSnapshot() {
  return {
    used: 0,
    limit: null,
    remaining: null,
    addonRemaining: null,
    percentUsed: null,
    contextUsagePercent: null,
    lastTurnCredits: null,
    planName: null,
    resetAt: null,
    activeModel: null,
    updatedAt: new Date().toISOString(),
    source: "initial"
  };
}

// src/tui/widget.ts
var DEFAULT_POLL_INTERVAL_MS = 30000;
function extractErrorMessage(err) {
  if (err instanceof Error) {
    return sanitizeDisplayText(err.message || err.name);
  }
  if (typeof err === "string") {
    return sanitizeDisplayText(err);
  }
  return "Unknown RPC error";
}
function severityToColor(severity) {
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
function safeRpcCall(fn) {
  return Promise.resolve().then(fn);
}
function isValidCreditsSnapshot(val) {
  return val !== null && typeof val === "object" && "used" in val && "source" in val;
}
function isValidAuthStatus(val) {
  return val !== null && typeof val === "object" && "authenticated" in val && "cliAvailable" in val;
}

class KiroTuiController {
  rpc;
  pollIntervalMs;
  listeners = new Set;
  pollTimer = null;
  disposed = false;
  inFlightCount = 0;
  creditsSeq = 0;
  authSeq = 0;
  modelsSeq = 0;
  activeModelSeq = 0;
  state = {
    credits: createInitialCreditsSnapshot(),
    auth: null,
    models: [],
    activeModel: null,
    loading: false,
    lastError: null
  };
  constructor(rpc, options) {
    this.rpc = rpc;
    const rawInterval = options?.pollIntervalMs;
    this.pollIntervalMs = typeof rawInterval === "number" && Number.isFinite(rawInterval) && rawInterval >= 0 ? rawInterval : DEFAULT_POLL_INTERVAL_MS;
  }
  get isDisposed() {
    return this.disposed;
  }
  getState() {
    return {
      ...this.state,
      credits: { ...this.state.credits },
      auth: this.state.auth ? { ...this.state.auth } : null,
      models: [...this.state.models]
    };
  }
  subscribe(listener) {
    if (this.disposed) {
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  setState(patch) {
    if (this.disposed) {
      return;
    }
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {}
    }
  }
  beginRequest() {
    this.inFlightCount += 1;
    if (!this.state.loading) {
      this.setState({ loading: true });
    }
  }
  endRequest(patch = {}) {
    this.inFlightCount = Math.max(0, this.inFlightCount - 1);
    this.setState({
      ...patch,
      loading: this.inFlightCount > 0
    });
  }
  async refreshAll() {
    if (this.disposed) {
      return this.getState();
    }
    if (!this.rpc) {
      this.setState({
        loading: this.inFlightCount > 0,
        lastError: "Kiro server RPC unavailable"
      });
      return this.getState();
    }
    const rpc = this.rpc;
    const authSeq = ++this.authSeq;
    const creditsSeq = ++this.creditsSeq;
    const activeModelSeq = ++this.activeModelSeq;
    this.beginRequest();
    try {
      const [authResult, creditsResult, activeModelResult] = await Promise.allSettled([
        safeRpcCall(() => rpc.getAuthStatus()),
        safeRpcCall(() => rpc.getCredits()),
        safeRpcCall(() => rpc.getActiveModel())
      ]);
      if (this.disposed) {
        return this.getState();
      }
      const errors = [];
      const patch = {};
      if (authResult.status === "fulfilled") {
        if (authSeq === this.authSeq && isValidAuthStatus(authResult.value)) {
          patch.auth = authResult.value;
        }
      } else {
        errors.push(extractErrorMessage(authResult.reason));
      }
      let creditsActiveModel = null;
      if (creditsResult.status === "fulfilled") {
        if (creditsSeq === this.creditsSeq && isValidCreditsSnapshot(creditsResult.value)) {
          patch.credits = creditsResult.value;
          if (typeof creditsResult.value.activeModel === "string" && creditsResult.value.activeModel.trim().length > 0) {
            creditsActiveModel = creditsResult.value.activeModel;
          }
        }
      } else {
        errors.push(extractErrorMessage(creditsResult.reason));
      }
      if (activeModelResult.status === "fulfilled") {
        if (activeModelSeq === this.activeModelSeq) {
          const rpcActiveModel = typeof activeModelResult.value === "string" && activeModelResult.value.trim().length > 0 ? activeModelResult.value : null;
          if (rpcActiveModel) {
            patch.activeModel = rpcActiveModel;
            if (patch.credits && !patch.credits.activeModel) {
              patch.credits = {
                ...patch.credits,
                activeModel: rpcActiveModel
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
  async refreshCredits(force = false) {
    if (this.disposed) {
      return this.state.credits;
    }
    if (!this.rpc) {
      this.setState({
        loading: this.inFlightCount > 0,
        lastError: "Kiro server RPC unavailable"
      });
      return this.state.credits;
    }
    const rpc = this.rpc;
    const seq = ++this.creditsSeq;
    this.beginRequest();
    try {
      const snapshot = await safeRpcCall(() => force ? rpc.refreshCredits() : rpc.getCredits());
      if (this.disposed) {
        return this.state.credits;
      }
      if (seq === this.creditsSeq && isValidCreditsSnapshot(snapshot)) {
        const nextActiveModel = typeof snapshot.activeModel === "string" && snapshot.activeModel.trim().length > 0 ? snapshot.activeModel : this.state.activeModel;
        this.endRequest({
          credits: snapshot,
          activeModel: nextActiveModel,
          lastError: null
        });
        return snapshot;
      }
      this.endRequest();
      return this.state.credits;
    } catch (err) {
      if (!this.disposed) {
        this.endRequest(seq === this.creditsSeq ? { lastError: extractErrorMessage(err) } : {});
      }
      return this.state.credits;
    }
  }
  async refreshAuth() {
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
  async refreshModels(force = false) {
    if (this.disposed) {
      return this.state.models;
    }
    if (!this.rpc) {
      this.setState({
        loading: this.inFlightCount > 0,
        lastError: "Kiro server RPC unavailable"
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
          lastError: null
        });
        return models;
      }
      this.endRequest();
      return this.state.models;
    } catch (err) {
      if (!this.disposed) {
        this.endRequest(seq === this.modelsSeq ? { lastError: extractErrorMessage(err) } : {});
      }
      return this.state.models;
    }
  }
  async triggerLogin() {
    const unavailableStatus = this.state.auth ?? {
      authenticated: false,
      managedBy: "kiro-cli",
      accountLabel: null,
      authMethod: null,
      cliAvailable: false,
      cliPath: "kiro-cli",
      checkedAt: new Date().toISOString(),
      error: "Kiro server RPC unavailable"
    };
    if (this.disposed || !this.rpc) {
      const message = "Kiro server RPC unavailable";
      if (!this.disposed) {
        this.setState({ lastError: message });
      }
      return {
        ok: false,
        status: unavailableStatus,
        message
      };
    }
    const rpc = this.rpc;
    const authSeq = ++this.authSeq;
    this.beginRequest();
    try {
      const result = await safeRpcCall(() => rpc.login());
      if (!this.disposed) {
        const sanitizedMessage = sanitizeDisplayText(result?.message ?? "");
        const nextAuth = isValidAuthStatus(result?.status) ? result.status : unavailableStatus;
        this.endRequest({
          ...authSeq === this.authSeq ? { auth: nextAuth } : {},
          lastError: result?.ok ? null : sanitizedMessage || "Login failed"
        });
        if (result?.ok) {
          this.refreshCredits(true);
        }
        return {
          ok: Boolean(result?.ok),
          status: nextAuth,
          message: sanitizedMessage
        };
      }
      return {
        ok: Boolean(result?.ok),
        status: isValidAuthStatus(result?.status) ? result.status : unavailableStatus,
        message: sanitizeDisplayText(result?.message ?? "")
      };
    } catch (err) {
      const message = extractErrorMessage(err);
      if (!this.disposed) {
        this.endRequest({
          lastError: message
        });
      }
      return {
        ok: false,
        status: {
          ...unavailableStatus,
          checkedAt: new Date().toISOString(),
          error: message
        },
        message
      };
    }
  }
  startPolling(intervalMs) {
    if (this.disposed || !this.rpc) {
      return;
    }
    this.stopPolling();
    const ms = typeof intervalMs === "number" && Number.isFinite(intervalMs) ? intervalMs : this.pollIntervalMs;
    if (ms <= 0) {
      return;
    }
    this.pollTimer = setInterval(() => {
      if (!this.disposed) {
        this.refreshCredits(false);
      }
    }, ms);
    if (this.pollTimer && typeof this.pollTimer === "object" && "unref" in this.pollTimer && typeof this.pollTimer.unref === "function") {
      this.pollTimer.unref();
    }
  }
  stopPolling() {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
  dispose() {
    this.disposed = true;
    this.inFlightCount = 0;
    this.stopPolling();
    this.listeners.clear();
  }
  getEffectiveSeverity() {
    if (this.state.auth && (!this.state.auth.cliAvailable || !this.state.auth.authenticated)) {
      return "unknown";
    }
    return computeCreditSeverity(this.state.credits);
  }
  renderSidebarFooter() {
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
        bold: severity === "critical"
      }
    };
  }
  renderSidebarContent() {
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
      text: lines.join(`
`),
      lines,
      severity,
      style: {
        borderColor: severityToColor(severity)
      },
      children: lines.map((line, index) => ({
        type: "text",
        id: `${PLUGIN_ID}:sidebar_content:line:${index}`,
        text: line,
        severity: index === 0 ? severity : undefined,
        style: index === 0 ? { bold: true, color: severityToColor(severity) } : undefined
      }))
    };
  }
  renderAppBottom() {
    const severity = this.getEffectiveSeverity();
    const label = formatCreditsCompact(this.state.credits, this.state.auth);
    return {
      type: "text",
      id: `${PLUGIN_ID}:app_bottom`,
      slot: "app_bottom",
      text: label,
      severity,
      style: {
        color: severityToColor(severity)
      }
    };
  }
  createSlotRegistrations() {
    return [
      {
        id: `${PLUGIN_ID}:sidebar_footer`,
        slot: "sidebar_footer",
        priority: 50,
        render: () => this.renderSidebarFooter()
      },
      {
        id: `${PLUGIN_ID}:sidebar_content`,
        slot: "sidebar_content",
        priority: 50,
        render: () => this.renderSidebarContent()
      },
      {
        id: `${PLUGIN_ID}:app_bottom`,
        slot: "app_bottom",
        priority: 50,
        render: () => this.renderAppBottom()
      }
    ];
  }
}
async function showToast(api, opts) {
  if (!api.ui?.toast) {
    return;
  }
  await api.ui.toast({
    ...opts,
    title: opts.title ? sanitizeDisplayText(opts.title) : undefined,
    message: sanitizeDisplayText(opts.message)
  });
}
function severityToToastVariant(severity) {
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
function createKiroTuiCommands(controller, api) {
  return [
    {
      name: "/kiro-credits",
      description: "Refresh and display current Kiro credits breakdown",
      handler: async () => {
        await Promise.all([
          controller.refreshAuth(),
          controller.refreshCredits(true)
        ]);
        const state = controller.getState();
        const lines = formatCreditsPanelLines(state.credits, state.auth);
        if (state.lastError) {
          lines.push(`Error: ${state.lastError}`);
        }
        const severity = computeCreditSeverity(state.credits);
        await showToast(api, {
          title: "Kiro Credits",
          message: lines.join(`
`),
          variant: state.lastError ? "warning" : severityToToastVariant(severity)
        });
      }
    },
    {
      name: "/kiro-login",
      description: "Authenticate with Kiro via kiro-cli login",
      handler: async () => {
        const result = await controller.triggerLogin();
        const details = result.status.accountLabel ? ` (${sanitizeDisplayText(result.status.accountLabel)})` : "";
        await showToast(api, {
          title: "Kiro Login",
          message: result.ok ? `${result.message}${details}` : `Login failed: ${result.message}`,
          variant: result.ok ? "success" : "error"
        });
      }
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
            message: state.lastError ? `No models available (${state.lastError})` : "No Kiro models discovered. Run /kiro-login if not authenticated.",
            variant: state.lastError ? "warning" : "info"
          });
          return;
        }
        const lines = models.map((model) => {
          const defaultTag = model.isDefault ? " [default]" : "";
          const activeTag = state.activeModel === model.id || state.activeModel === model.qualifiedId ? " [active]" : "";
          const multiplierTag = typeof model.creditMultiplier === "number" && Number.isFinite(model.creditMultiplier) ? ` (${model.creditMultiplier}x cr)` : "";
          return `- ${sanitizeDisplayText(model.qualifiedId)} — ${sanitizeDisplayText(model.name)}${multiplierTag}${defaultTag}${activeTag}`;
        });
        await showToast(api, {
          title: `Kiro Models (${models.length})`,
          message: lines.join(`
`),
          variant: "info"
        });
      }
    },
    {
      name: "/kiro-status",
      description: "Display Kiro authentication status, CLI path, model, and credits summary",
      handler: async () => {
        const state = await controller.refreshAll();
        const auth = state.auth;
        const lines = [];
        if (!auth) {
          lines.push("Auth: Unknown (server RPC unavailable)");
        } else if (!auth.cliAvailable) {
          lines.push(`Auth: kiro-cli not found (${sanitizeDisplayText(auth.cliPath)})`);
        } else if (auth.authenticated) {
          const label = auth.accountLabel ? ` as ${sanitizeDisplayText(auth.accountLabel)}` : "";
          const method = auth.authMethod ? ` via ${sanitizeDisplayText(auth.authMethod)}` : "";
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
          message: lines.join(`
`),
          variant: auth?.authenticated ? "info" : "warning"
        });
      }
    }
  ];
}
// src/tui.tsx
function isOpenCodeV2TuiContext(ctx) {
  if (!ctx || typeof ctx !== "object")
    return false;
  const candidate = ctx;
  return typeof candidate.ui?.slot === "function" || typeof candidate.ui?.toast?.show === "function" || typeof candidate.data?.on === "function";
}
function setupOpenCodeV2Tui(ctx) {
  const disposers = [];
  let activeModel = null;
  const updateActiveModel = () => {
    try {
      const current = ctx.ui?.model?.current?.();
      if (current?.providerID === "kiro") {
        activeModel = current.modelID;
      }
    } catch {}
  };
  updateActiveModel();
  if (typeof ctx.data?.on === "function") {
    try {
      const unsub = ctx.data.on("session.status", () => {
        updateActiveModel();
      });
      if (typeof unsub === "function") {
        disposers.push(unsub);
      }
    } catch {}
  }
  if (typeof ctx.keymap?.layer === "function") {
    try {
      ctx.keymap.layer(() => ({
        commands: [
          {
            id: "opencode-kiro.status",
            title: "Kiro: Show Status & Credits",
            category: "Kiro",
            onSelect: () => {
              updateActiveModel();
              ctx.ui?.toast?.show?.({
                title: "Kiro (ACP)",
                message: activeModel ? `Active model: kiro/${activeModel} (auth managed by kiro-cli)` : "Kiro provider ready via kiro-cli ACP. Select any kiro/* model.",
                variant: "info"
              });
            }
          }
        ]
      }));
    } catch {}
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {}
    }
  };
}
function createKiroTuiPlugin(defaultOptions) {
  const tui = (api, options) => {
    const mergedOptions = {
      ...defaultOptions,
      ...options
    };
    const rpc = api?.rpc ? createKiroRpcClient(api.rpc) : null;
    const controller = new KiroTuiController(rpc, {
      pollIntervalMs: mergedOptions.pollIntervalMs
    });
    const cleanups = [];
    if (api?.slots?.register) {
      for (const registration of controller.createSlotRegistrations()) {
        const unregister = api.slots.register(registration);
        if (typeof unregister === "function") {
          cleanups.push(unregister);
        }
      }
    }
    if (api?.command?.register) {
      for (const command of createKiroTuiCommands(controller, api)) {
        const unregister = api.command.register(command);
        if (typeof unregister === "function") {
          cleanups.push(unregister);
        }
      }
    }
    if (api?.events?.on) {
      const refreshOnEvent = () => {
        if (!controller.isDisposed) {
          controller.refreshCredits(false);
        }
      };
      const unsubCredits = api.events.on("kiro.credits.updated", refreshOnEvent);
      if (typeof unsubCredits === "function") {
        cleanups.push(unsubCredits);
      }
      const unsubIdle = api.events.on("session.idle", refreshOnEvent);
      if (typeof unsubIdle === "function") {
        cleanups.push(unsubIdle);
      }
    }
    if (mergedOptions.autoRefresh !== false && rpc) {
      controller.refreshAll();
    }
    if (rpc && mergedOptions.pollIntervalMs !== 0) {
      controller.startPolling(mergedOptions.pollIntervalMs);
    }
    let disposed = false;
    const dispose = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch {}
      }
      controller.dispose();
    };
    return {
      controller,
      dispose
    };
  };
  const setup = (ctx, options) => {
    if (isOpenCodeV2TuiContext(ctx)) {
      return setupOpenCodeV2Tui(ctx);
    }
    const handle = tui(ctx, options);
    return handle.dispose;
  };
  return {
    id: PLUGIN_ID,
    setup,
    tui
  };
}
var kiroTuiPlugin = createKiroTuiPlugin();
var setup = kiroTuiPlugin.setup;
var tui = kiroTuiPlugin.tui;
var tui_default = kiroTuiPlugin;
export {
  KiroTuiController,
  computeCreditSeverity,
  createInitialCreditsSnapshot,
  createKiroTuiCommands,
  createKiroTuiPlugin,
  tui_default as default,
  formatCreditsCompact,
  formatCreditsNumber,
  formatCreditsPanelLines,
  formatResetDate,
  renderProgressBar,
  sanitizeDisplayText,
  setup,
  tui
};
