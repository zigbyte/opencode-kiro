import { describe, expect, it } from "bun:test";
import { KIRO_RPC_METHODS, type KiroRpcContract, type RpcCaller } from "../src/rpc";
import type {
  KiroAuthStatus,
  KiroCreditsSnapshot,
  KiroModelInfo,
} from "../src/types";
import kiroTuiDefault, {
  KiroTuiController,
  computeCreditSeverity,
  createInitialCreditsSnapshot,
  createKiroTuiPlugin,
  formatCreditsCompact,
  formatCreditsNumber,
  formatCreditsPanelLines,
  formatResetDate,
  renderProgressBar,
  sanitizeDisplayText,
  setup,
  type TuiCommandDefinition,
  type TuiPluginApi,
  type TuiSlotRegistration,
  type TuiToastOptions,
} from "../src/tui";

// ---------------------------------------------------------------------------
// Test Helpers & Mock OpenCode 2.x TUI Host API
// ---------------------------------------------------------------------------

function makeSnapshot(
  overrides: Partial<KiroCreditsSnapshot> = {}
): KiroCreditsSnapshot {
  return {
    ...createInitialCreditsSnapshot(),
    source: "acp_usage",
    ...overrides,
  };
}

function makeAuth(overrides: Partial<KiroAuthStatus> = {}): KiroAuthStatus {
  return {
    authenticated: true,
    managedBy: "kiro-cli",
    accountLabel: "alice@example.com",
    authMethod: "builder-id",
    cliAvailable: true,
    cliPath: "/usr/local/bin/kiro-cli",
    checkedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeModel(overrides: Partial<KiroModelInfo> = {}): KiroModelInfo {
  return {
    id: "claude-sonnet-4",
    qualifiedId: "kiro/claude-sonnet-4",
    name: "Claude Sonnet 4",
    contextLimit: 200_000,
    outputLimit: 16_384,
    creditMultiplier: 1.5,
    reasoning: true,
    toolCall: true,
    vision: true,
    isDefault: true,
    source: "acp",
    ...overrides,
  };
}

interface MockTuiHost {
  api: TuiPluginApi;
  slots: Map<string, TuiSlotRegistration>;
  commands: Map<string, TuiCommandDefinition>;
  toasts: TuiToastOptions[];
  eventListeners: Map<string, Set<(payload: unknown) => void>>;
  emitEvent: (event: string, payload?: unknown) => void;
  rpcCalls: Array<{ method: string; args: unknown[] }>;
}

function createMockTuiHost(
  rpcHandlers?: Partial<Record<string, (...args: unknown[]) => unknown>>,
  opts?: { omitRpc?: boolean; throwingCleanup?: boolean }
): MockTuiHost {
  const slots = new Map<string, TuiSlotRegistration>();
  const commands = new Map<string, TuiCommandDefinition>();
  const toasts: TuiToastOptions[] = [];
  const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
  const rpcCalls: Array<{ method: string; args: unknown[] }> = [];

  const rpc: RpcCaller | undefined = opts?.omitRpc
    ? undefined
    : {
        call: async <T = unknown>(
          method: string,
          ...args: unknown[]
        ): Promise<T> => {
          rpcCalls.push({ method, args });
          const handler = rpcHandlers?.[method];
          if (!handler) {
            throw new Error(`Unhandled RPC method: ${method}`);
          }
          return (await handler(...args)) as T;
        },
      };

  const api: TuiPluginApi = {
    rpc,
    slots: {
      register: (reg) => {
        slots.set(reg.slot, reg);
        return () => {
          slots.delete(reg.slot);
          if (opts?.throwingCleanup) {
            throw new Error("slot cleanup boom");
          }
        };
      },
    },
    command: {
      register: (cmd) => {
        commands.set(cmd.name, cmd);
        return () => {
          commands.delete(cmd.name);
        };
      },
    },
    ui: {
      toast: async (toast) => {
        toasts.push(toast);
      },
    },
    events: {
      on: (event, listener) => {
        let set = eventListeners.get(event);
        if (!set) {
          set = new Set();
          eventListeners.set(event, set);
        }
        set.add(listener);
        return () => {
          set?.delete(listener);
        };
      },
    },
  };

  return {
    api,
    slots,
    commands,
    toasts,
    eventListeners,
    emitEvent: (event, payload) => {
      for (const listener of eventListeners.get(event) ?? []) {
        listener(payload);
      }
    },
    rpcCalls,
  };
}

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ===========================================================================
// 1. CREDIT MATH & FORMATTING ATTACKS
// ===========================================================================

describe("Adversarial Credit Math & Formatting", () => {
  describe("formatCreditsNumber", () => {
    it("handles normal integers, decimals, zero, -0, and thousands separators", () => {
      expect(formatCreditsNumber(0)).toBe("0");
      expect(formatCreditsNumber(-0)).toBe("0");
      expect(formatCreditsNumber(-0.01)).toBe("0");
      expect(formatCreditsNumber(500)).toBe("500");
      expect(formatCreditsNumber(1234.56)).toBe("1,234.6");
      expect(formatCreditsNumber(1_000_000)).toBe("1,000,000");
      expect(formatCreditsNumber(1_000_000.44)).toBe("1,000,000.4");
      expect(formatCreditsNumber(-42.5)).toBe("-42.5");
    });

    it("handles NaN, Infinity, -Infinity without throwing or leaking NaN/Infinity", () => {
      expect(formatCreditsNumber(Number.NaN)).toBe("--");
      expect(formatCreditsNumber(Number.POSITIVE_INFINITY)).toBe("--");
      expect(formatCreditsNumber(Number.NEGATIVE_INFINITY)).toBe("--");
    });

    it("BUG CHECK: does not overflow Number.MAX_VALUE into 'Infinity'", () => {
      // formatCreditsNumber does `Math.round(val * 10) / 10`, which overflows to Infinity for huge finite numbers!
      const formatted = formatCreditsNumber(Number.MAX_VALUE);
      expect(formatted).not.toContain("Infinity");
      expect(formatted).not.toContain("NaN");
    });
  });

  describe("renderProgressBar", () => {
    it("clamps percent to [0, 100] and handles null/NaN/Infinity/negative/overage", () => {
      expect(renderProgressBar(null, 10)).toBe("[░░░░░░░░░░]");
      expect(renderProgressBar(Number.NaN, 10)).toBe("[░░░░░░░░░░]");
      expect(renderProgressBar(Number.POSITIVE_INFINITY, 10)).toBe("[░░░░░░░░░░]");
      expect(renderProgressBar(Number.NEGATIVE_INFINITY, 10)).toBe("[░░░░░░░░░░]");
      expect(renderProgressBar(-50, 10)).toBe("[░░░░░░░░░░]");
      expect(renderProgressBar(0, 10)).toBe("[░░░░░░░░░░]");
      expect(renderProgressBar(50, 10)).toBe("[█████░░░░░]");
      expect(renderProgressBar(100, 10)).toBe("[██████████]");
      expect(renderProgressBar(125, 10)).toBe("[██████████]");
    });

    it("handles zero, negative, NaN, Infinity, and huge widths safely", () => {
      expect(renderProgressBar(50, 0)).toMatch(/^\[[█░]\]$/);
      expect(renderProgressBar(50, -10)).toMatch(/^\[[█░]\]$/);
      expect(renderProgressBar(50, Number.NaN)).toHaveLength(18); // default 16 + 2 brackets
      expect(renderProgressBar(50, Number.POSITIVE_INFINITY)).toHaveLength(18);
      expect(renderProgressBar(50, 10_000)).toHaveLength(66); // clamped to 64 + 2 brackets
    });
  });

  describe("formatResetDate", () => {
    it("returns empty string for null, empty, whitespace, or invalid dates", () => {
      expect(formatResetDate(null)).toBe("");
      expect(formatResetDate("")).toBe("");
      expect(formatResetDate("   ")).toBe("");
      expect(formatResetDate("not-a-date")).toBe("");
      expect(formatResetDate("2026-99-99T99:99:99Z")).toBe("");
      expect(formatResetDate("2026-12-01\x1b[31m")).toBe("");
    });

    it("formats near-future (<24h and <=60d), far-future, past, and NaN nowMs safely", () => {
      const base = Date.parse("2026-06-01T00:00:00.000Z");
      expect(formatResetDate("2026-06-01T00:30:00.000Z", base)).toBe(
        "in 1h (2026-06-01)"
      );
      expect(formatResetDate("2026-06-01T05:00:00.000Z", base)).toBe(
        "in 5h (2026-06-01)"
      );
      expect(formatResetDate("2026-06-11T00:00:00.000Z", base)).toBe(
        "in 10d (2026-06-11)"
      );
      expect(formatResetDate("2026-12-31T00:00:00.000Z", base)).toBe(
        "2026-12-31"
      );
      expect(formatResetDate("2026-05-01T00:00:00.000Z", base)).toBe(
        "2026-05-01"
      );
      expect(formatResetDate("2026-06-11T00:00:00.000Z", Number.NaN)).toBe(
        "2026-06-11"
      );
    });
  });

  describe("Extreme Credit Snapshots (0/0, 0/500, 500/500, 625/500, null limit, NaN, Infinity, negative, 1_000_000)", () => {
    it("handles 0/0 without NaN or division by zero", () => {
      const snap = makeSnapshot({
        used: 0,
        limit: 0,
        remaining: 0,
        percentUsed: null,
      });
      expect(computeCreditSeverity(snap)).toBe("unknown");
      expect(formatCreditsCompact(snap)).toBe("Kiro: 0 cr used");
      const lines = formatCreditsPanelLines(snap);
      expect(lines.join("\n")).not.toContain("NaN");
      expect(lines.join("\n")).toContain("Credits: 0 used");
    });

    it("handles 0/500 (fresh quota)", () => {
      const snap = makeSnapshot({
        used: 0,
        limit: 500,
        remaining: 500,
        percentUsed: 0,
      });
      expect(computeCreditSeverity(snap)).toBe("normal");
      expect(formatCreditsCompact(snap)).toBe("Kiro: 0/500 cr (0%)");
      expect(formatCreditsPanelLines(snap).join("\n")).toContain(
        "Credits: 0 / 500 (500 remaining)"
      );
    });

    it("handles 500/500 (100% exhausted)", () => {
      const snap = makeSnapshot({
        used: 500,
        limit: 500,
        remaining: 0,
        percentUsed: 100,
      });
      expect(computeCreditSeverity(snap)).toBe("critical");
      expect(formatCreditsCompact(snap)).toBe("Kiro: 500/500 cr (100%)");
      expect(formatCreditsPanelLines(snap).join("\n")).toContain(
        "Credits: 500 / 500 (0 remaining)"
      );
    });

    it("handles 625/500 (overage) with percentUsed: 125", () => {
      const snap = makeSnapshot({
        used: 625,
        limit: 500,
        remaining: 0,
        percentUsed: 125,
      });
      expect(computeCreditSeverity(snap)).toBe("critical");
      expect(formatCreditsCompact(snap)).toContain("625/500");
      expect(formatCreditsPanelLines(snap).join("\n")).not.toContain("NaN");
    });

    it("BUG CHECK: 625/500 overage with negative remaining (-125) and null percentUsed should be critical and never show negative remaining", () => {
      const snap = makeSnapshot({
        used: 625,
        limit: 500,
        remaining: -125,
        percentUsed: null,
      });
      // Bug 1: computeCreditSeverity checks `remaining === 0` instead of `remaining <= 0` or `used >= limit`
      expect(computeCreditSeverity(snap)).toBe("critical");
      // Bug 2: formatCreditsPanelLines displays "(-125 remaining)" instead of clamping remaining to 0
      const panel = formatCreditsPanelLines(snap).join("\n");
      expect(panel).not.toContain("-125 remaining");
    });

    it("handles NaN, Infinity, -Infinity in all numeric fields without leaking NaN/Infinity", () => {
      const snap = makeSnapshot({
        used: Number.NaN,
        limit: Number.POSITIVE_INFINITY,
        remaining: Number.NEGATIVE_INFINITY,
        addonRemaining: Number.NaN,
        percentUsed: Number.NaN,
        contextUsagePercent: Number.POSITIVE_INFINITY,
        lastTurnCredits: Number.NEGATIVE_INFINITY,
      });
      expect(computeCreditSeverity(snap)).toBe("unknown");
      const compact = formatCreditsCompact(snap);
      const panel = formatCreditsPanelLines(snap).join("\n");
      expect(compact).not.toContain("NaN");
      expect(compact).not.toContain("Infinity");
      expect(panel).not.toContain("NaN");
      expect(panel).not.toContain("Infinity");
    });

    it("handles negative used and negative limit gracefully", () => {
      const snap = makeSnapshot({
        used: -25,
        limit: -100,
        remaining: -75,
        percentUsed: -25,
      });
      const compact = formatCreditsCompact(snap);
      const panel = formatCreditsPanelLines(snap).join("\n");
      expect(compact).not.toContain("NaN");
      expect(panel).not.toContain("NaN");
    });

    it("handles null limit (unlimited / enterprise)", () => {
      const snap = makeSnapshot({
        used: 142.5,
        limit: null,
        remaining: null,
        percentUsed: null,
        planName: "Enterprise",
      });
      expect(computeCreditSeverity(snap)).toBe("unknown");
      expect(formatCreditsCompact(snap)).toBe("Kiro: 142.5 cr used");
      const panel = formatCreditsPanelLines(snap).join("\n");
      expect(panel).toContain("Kiro Credits (Enterprise)");
      expect(panel).toContain("Credits: 142.5 used");
    });

    it("handles huge numbers (1_000_000)", () => {
      const snap = makeSnapshot({
        used: 1_000_000,
        limit: 2_000_000,
        remaining: 1_000_000,
        percentUsed: 50,
      });
      expect(computeCreditSeverity(snap)).toBe("normal");
      expect(formatCreditsCompact(snap)).toBe("Kiro: 1,000,000/2,000,000 cr (50%)");
      expect(formatCreditsPanelLines(snap).join("\n")).toContain(
        "Credits: 1,000,000 / 2,000,000 (1,000,000 remaining)"
      );
    });
  });
});

// ===========================================================================
// 2. SANITIZATION & SECRET REDACTION ATTACKS
// ===========================================================================

describe("Adversarial Sanitization & Zero-Secret-Leakage", () => {
  it("strips ANSI CSI, OSC, ESC, and C0 control characters", () => {
    const payload =
      "\x1b[31mRED\x1b[0m \x1b]0;evil-title\x07\x1b]8;;https://evil\x1b\\link\x1bM\x00\x07\x7fOK";
    const cleaned = sanitizeDisplayText(payload);
    expect(cleaned).not.toContain("\x1b");
    expect(cleaned).not.toContain("\x00");
    expect(cleaned).not.toContain("\x07");
    expect(cleaned).not.toContain("\x7f");
    expect(cleaned).toContain("RED");
    expect(cleaned).toContain("OK");
  });

  it("BUG CHECK: strips 8-bit C1 ANSI control sequences (\\x9b CSI)", () => {
    // Modern terminals interpret U+009B (8-bit CSI) identically to ESC [
    const payload = "\x9b31mFAKE_RED\x9b0m";
    const cleaned = sanitizeDisplayText(payload);
    expect(cleaned).not.toContain("\x9b");
  });

  it("redacts Bearer tokens, JWTs, sk-/pk-/kiro- keys, AWS keys, GitHub tokens, and plain kv secrets", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const inputs = [
      { raw: "Authorization: Bearer supersecrettoken123456", secret: "supersecrettoken123456" },
      { raw: `Token: ${jwt}`, secret: "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" },
      { raw: "Key sk-proj1234567890abcdef", secret: "sk-proj1234567890abcdef" },
      { raw: "Key kiro-live1234567890abcd", secret: "kiro-live1234567890abcd" },
      { raw: "AWS AKIAIOSFODNN7EXAMPLE", secret: "AKIAIOSFODNN7EXAMPLE" },
      { raw: "AWS ASIAIOSFODNN7EXAMPLE", secret: "ASIAIOSFODNN7EXAMPLE" },
      { raw: "GH ghp_1234567890abcdefghij1234567890", secret: "ghp_1234567890abcdefghij1234567890" },
      { raw: "api_key=my_super_secret_value_123", secret: "my_super_secret_value_123" },
      { raw: "refresh_token='rt_secret_value_987654'", secret: "rt_secret_value_987654" },
    ];

    for (const { raw, secret } of inputs) {
      const cleaned = sanitizeDisplayText(raw);
      expect(cleaned).not.toContain(secret);
    }
  });

  it("BUG CHECK: redacts env-var prefixed secrets (KIRO_API_KEY=..., AWS_SECRET_ACCESS_KEY=..., CLIENT_SECRET=...)", () => {
    // SECRET_KV_REGEX uses leading \b which fails after '_' because '_' is a word char!
    const envSecrets = [
      { raw: "KIRO_API_KEY=supersecretvalue12345", secret: "supersecretvalue12345" },
      {
        raw: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      { raw: "CLIENT_SECRET=myclientsecret987654", secret: "myclientsecret987654" },
    ];

    for (const { raw, secret } of envSecrets) {
      const cleaned = sanitizeDisplayText(raw);
      expect(cleaned).not.toContain(secret);
    }
  });

  it("BUG CHECK: redacts JSON-formatted secrets (\"api_key\": \"...\", \"refresh_token\": \"...\")", () => {
    // SECRET_KV_REGEX expects : immediately after key name, failing on closing quote before ':'
    const jsonPayload =
      '{"api_key": "jsonsecretvalue12345", "refresh_token": "rt_json_secret_987654"}';
    const cleaned = sanitizeDisplayText(jsonPayload);
    expect(cleaned).not.toContain("jsonsecretvalue12345");
    expect(cleaned).not.toContain("rt_json_secret_987654");
  });

  it("never leaks secrets through any TUI slot renderer or slash command toast", async () => {
    const bearerSecret = "Bearer_LeakTest_99999999";
    const awsSecret = "AKIAIOSFODNN7EXAMPLE";
    const skSecret = "sk-leaktest1234567890";
    const jwtSecret =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.sig_secret_value_12345678";

    const host = createMockTuiHost({
      [KIRO_RPC_METHODS.getAuthStatus]: async () =>
        makeAuth({
          accountLabel: `user Bearer ${bearerSecret}`,
          authMethod: `oauth ${awsSecret}`,
          cliPath: `/bin/kiro-cli ${skSecret}`,
        }),
      [KIRO_RPC_METHODS.getCredits]: async () =>
        makeSnapshot({
          used: 100,
          limit: 500,
          remaining: 400,
          percentUsed: 20,
          planName: `Pro ${jwtSecret}`,
          activeModel: `claude ${skSecret}`,
        }),
      [KIRO_RPC_METHODS.refreshCredits]: async () =>
        makeSnapshot({
          used: 100,
          limit: 500,
          remaining: 400,
          percentUsed: 20,
          planName: `Pro ${jwtSecret}`,
          activeModel: `claude ${skSecret}`,
        }),
      [KIRO_RPC_METHODS.getActiveModel]: async () => `claude ${skSecret}`,
      [KIRO_RPC_METHODS.listModels]: async () => [
        makeModel({
          name: `Model ${awsSecret}`,
          qualifiedId: `kiro/model-${skSecret}` as `kiro/${string}`,
        }),
      ],
      [KIRO_RPC_METHODS.login]: async () => ({
        ok: false,
        status: makeAuth({ authenticated: false, accountLabel: `acct ${awsSecret}` }),
        message: `Failed with Bearer ${bearerSecret} and ${jwtSecret}`,
      }),
    });

    const plugin = createKiroTuiPlugin({ autoRefresh: false, pollIntervalMs: 0 });
    const handle = plugin.tui(host.api);
    await handle.controller.refreshAll();

    // Render all 3 slots
    const renderedOutputs: string[] = [];
    for (const reg of host.slots.values()) {
      const node = reg.render();
      renderedOutputs.push(JSON.stringify(node));
    }

    // Invoke all 4 slash commands
    for (const cmd of host.commands.values()) {
      await cmd.handler();
    }
    for (const toast of host.toasts) {
      renderedOutputs.push(JSON.stringify(toast));
    }

    const combined = renderedOutputs.join("\n");
    expect(combined).not.toContain(bearerSecret);
    expect(combined).not.toContain(awsSecret);
    expect(combined).not.toContain(skSecret);
    expect(combined).not.toContain("sig_secret_value_12345678");

    handle.dispose();
  });
});

// ===========================================================================
// 3. KiroTuiController & tui.tsx LIFECYCLE ATTACKS
// ===========================================================================

describe("Adversarial KiroTuiController & tui.tsx Lifecycle", () => {
  it("handles missing api.rpc and minimal empty api object without throwing", async () => {
    const plugin = createKiroTuiPlugin({ autoRefresh: true, pollIntervalMs: 100 });
    const handle = plugin.tui({});

    const state = await handle.controller.refreshAll();
    expect(state.lastError).toBe("Kiro server RPC unavailable");
    expect(state.loading).toBe(false);

    const credits = await handle.controller.refreshCredits(true);
    expect(credits.source).toBe("initial");

    const auth = await handle.controller.refreshAuth();
    expect(auth).toBeNull();

    const models = await handle.controller.refreshModels(true);
    expect(models).toEqual([]);

    const loginRes = await handle.controller.triggerLogin();
    expect(loginRes.ok).toBe(false);
    expect(loginRes.message).toBe("Kiro server RPC unavailable");

    handle.dispose();
  });

  it("handles RPC async rejections gracefully and sanitizes error messages", async () => {
    const host = createMockTuiHost({
      [KIRO_RPC_METHODS.getAuthStatus]: async () => {
        throw new Error("Auth failed with Bearer secret_token_12345678");
      },
      [KIRO_RPC_METHODS.getCredits]: async () => {
        throw new Error("\x1b[31mCredits RPC exploded\x1b[0m");
      },
      [KIRO_RPC_METHODS.getActiveModel]: async () => {
        throw "raw string error AKIAIOSFODNN7EXAMPLE";
      },
      [KIRO_RPC_METHODS.listModels]: async () => {
        throw new Error("Models unavailable");
      },
      [KIRO_RPC_METHODS.login]: async () => {
        throw new Error("Login crashed sk-secret1234567890");
      },
    });

    const plugin = createKiroTuiPlugin({ autoRefresh: false, pollIntervalMs: 0 });
    const handle = plugin.tui(host.api);

    const allState = await handle.controller.refreshAll();
    expect(allState.loading).toBe(false);
    expect(allState.lastError).toContain("[REDACTED]");
    expect(allState.lastError).not.toContain("secret_token_12345678");

    await handle.controller.refreshCredits(false);
    expect(handle.controller.getState().lastError).toBe("Credits RPC exploded");

    const loginRes = await handle.controller.triggerLogin();
    expect(loginRes.ok).toBe(false);
    expect(loginRes.message).not.toContain("sk-secret1234567890");

    handle.dispose();
  });

  it("BUG CHECK: refreshAll() must never throw if an RPC method throws synchronously", async () => {
    const throwingRpc: KiroRpcContract = {
      getAuthStatus: () => {
        throw new Error("sync RPC blowup");
      },
      getCredits: async () => makeSnapshot(),
      refreshCredits: async () => makeSnapshot(),
      login: async () => ({ ok: false, status: makeAuth({ authenticated: false }), message: "no" }),
      listModels: async () => [],
      getActiveModel: async () => null,
      setActiveModel: async (modelId) => ({ ok: true, modelId }),
    };

    const controller = new KiroTuiController(throwingRpc, { pollIntervalMs: 0 });

    // Contract comment on refreshAll(): "Never throws; records sanitized errors in state.lastError."
    const state = await controller.refreshAll();
    expect(state.loading).toBe(false);
    expect(state.lastError).toContain("sync RPC blowup");
    controller.dispose();
  });

  it("BUG CHECK: refreshAll() must not crash if RPC returns null for getCredits()", async () => {
    const nullCreditsRpc: KiroRpcContract = {
      getAuthStatus: async () => makeAuth(),
      getCredits: async () => null as unknown as KiroCreditsSnapshot,
      refreshCredits: async () => makeSnapshot(),
      login: async () => ({ ok: true, status: makeAuth(), message: "ok" }),
      listModels: async () => [],
      getActiveModel: async () => "claude-sonnet-4",
      setActiveModel: async (modelId) => ({ ok: true, modelId }),
    };

    const controller = new KiroTuiController(nullCreditsRpc, { pollIntervalMs: 0 });
    const state = await controller.refreshAll();
    expect(state.loading).toBe(false);
    controller.dispose();
  });

  it("BUG CHECK: refreshAll() must not overwrite credits.activeModel with null when getActiveModel() returns null", async () => {
    const rpc: KiroRpcContract = {
      getAuthStatus: async () => makeAuth(),
      getCredits: async () =>
        makeSnapshot({ used: 10, limit: 100, activeModel: "claude-sonnet-4" }),
      refreshCredits: async () => makeSnapshot(),
      login: async () => ({ ok: true, status: makeAuth(), message: "ok" }),
      listModels: async () => [],
      getActiveModel: async () => null,
      setActiveModel: async (modelId) => ({ ok: true, modelId }),
    };

    const controller = new KiroTuiController(rpc, { pollIntervalMs: 0 });
    const state = await controller.refreshAll();
    expect(state.activeModel).toBe("claude-sonnet-4");
    controller.dispose();
  });

  it("BUG CHECK: out-of-order overlapping rapid refreshes must not overwrite newer credits with stale response", async () => {
    const slowFirst = createDeferred<KiroCreditsSnapshot>();
    const fastSecond = createDeferred<KiroCreditsSnapshot>();

    let callIndex = 0;
    const rpc: KiroRpcContract = {
      getAuthStatus: async () => makeAuth(),
      getCredits: () => {
        callIndex += 1;
        return callIndex === 1 ? slowFirst.promise : fastSecond.promise;
      },
      refreshCredits: () => fastSecond.promise,
      login: async () => ({ ok: true, status: makeAuth(), message: "ok" }),
      listModels: async () => [],
      getActiveModel: async () => null,
      setActiveModel: async (modelId) => ({ ok: true, modelId }),
    };

    const controller = new KiroTuiController(rpc, { pollIntervalMs: 0 });

    const p1 = controller.refreshCredits(false); // started first (stale)
    const p2 = controller.refreshCredits(true); // started second (fresh)

    // Second (newer) request finishes first
    fastSecond.resolve(makeSnapshot({ used: 250, limit: 500, percentUsed: 50 }));
    await p2;
    expect(controller.getState().credits.used).toBe(250);

    // First (stale) request finishes late — MUST NOT clobber newer state
    slowFirst.resolve(makeSnapshot({ used: 10, limit: 500, percentUsed: 2 }));
    await p1;
    expect(controller.getState().credits.used).toBe(250);

    controller.dispose();
  });

  it("dispose() stops polling timers, blocks post-dispose state updates, and tolerates throwing cleanups", async () => {
    const pendingCredits = createDeferred<KiroCreditsSnapshot>();
    let pollCalls = 0;

    const host = createMockTuiHost(
      {
        [KIRO_RPC_METHODS.getCredits]: () => {
          pollCalls += 1;
          return pendingCredits.promise;
        },
        [KIRO_RPC_METHODS.getAuthStatus]: async () => makeAuth(),
        [KIRO_RPC_METHODS.getActiveModel]: async () => "claude-sonnet-4",
      },
      { throwingCleanup: true }
    );

    const plugin = createKiroTuiPlugin({ autoRefresh: false, pollIntervalMs: 15 });
    const handle = plugin.tui(host.api);

    let notifications = 0;
    handle.controller.subscribe(() => {
      notifications += 1;
    });

    // Start an in-flight refresh
    const inFlight = handle.controller.refreshCredits(false);
    const notificationsBeforeDispose = notifications;

    // Dispose (should not throw despite throwing slot cleanup, and should be idempotent)
    expect(() => handle.dispose()).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
    expect(handle.controller.isDisposed).toBe(true);
    expect(host.slots.size).toBe(0);
    expect(host.commands.size).toBe(0);

    // Resolve in-flight RPC after dispose — must NOT mutate state or notify listeners
    pendingCredits.resolve(makeSnapshot({ used: 999, limit: 1000, percentUsed: 99.9 }));
    await inFlight;
    expect(handle.controller.getState().credits.used).toBe(0);
    expect(notifications).toBe(notificationsBeforeDispose);

    // Subscribing or starting polling after dispose should be no-ops
    let postDisposeNotified = false;
    const unsub = handle.controller.subscribe(() => {
      postDisposeNotified = true;
    });
    unsub();
    handle.controller.startPolling(10);

    const callsAtDispose = pollCalls;
    await new Promise((r) => setTimeout(r, 50));
    expect(pollCalls).toBe(callsAtDispose);
    expect(postDisposeNotified).toBe(false);
  });

  it("renders unauthenticated and CLI-not-found states clearly across slots", async () => {
    // 1. CLI not found
    const cliMissingHost = createMockTuiHost({
      [KIRO_RPC_METHODS.getAuthStatus]: async () =>
        makeAuth({ cliAvailable: false, authenticated: false, accountLabel: null }),
      [KIRO_RPC_METHODS.getCredits]: async () => createInitialCreditsSnapshot(),
      [KIRO_RPC_METHODS.getActiveModel]: async () => null,
    });

    const plugin = createKiroTuiPlugin({ autoRefresh: false, pollIntervalMs: 0 });
    const h1 = plugin.tui(cliMissingHost.api);
    await h1.controller.refreshAll();

    expect(cliMissingHost.slots.get("sidebar_footer")!.render().text).toBe(
      "Kiro: CLI not found"
    );
    expect(cliMissingHost.slots.get("app_bottom")!.render().text).toBe(
      "Kiro: CLI not found"
    );
    expect(cliMissingHost.slots.get("sidebar_content")!.render().text).toContain(
      "kiro-cli not found"
    );
    h1.dispose();

    // 2. Unauthenticated (CLI present)
    const unauthHost = createMockTuiHost({
      [KIRO_RPC_METHODS.getAuthStatus]: async () =>
        makeAuth({ cliAvailable: true, authenticated: false, accountLabel: null }),
      [KIRO_RPC_METHODS.getCredits]: async () => createInitialCreditsSnapshot(),
      [KIRO_RPC_METHODS.getActiveModel]: async () => null,
    });

    const h2 = plugin.tui(unauthHost.api);
    await h2.controller.refreshAll();

    expect(unauthHost.slots.get("sidebar_footer")!.render().text).toBe(
      "Kiro: Not logged in (run /kiro-login)"
    );
    expect(unauthHost.slots.get("sidebar_content")!.render().text).toContain(
      "Status: Not logged in"
    );
    h2.dispose();
  });

  it("triggers credit refresh on kiro.credits.updated and session.idle events", async () => {
    let used = 10;
    const host = createMockTuiHost({
      [KIRO_RPC_METHODS.getCredits]: async () => {
        used += 5;
        return makeSnapshot({ used, limit: 500, remaining: 500 - used, percentUsed: (used / 500) * 100 });
      },
    });

    const plugin = createKiroTuiPlugin({ autoRefresh: false, pollIntervalMs: 0 });
    const handle = plugin.tui(host.api);

    host.emitEvent("kiro.credits.updated");
    await new Promise((r) => setTimeout(r, 10));
    expect(handle.controller.getState().credits.used).toBe(15);

    host.emitEvent("session.idle");
    await new Promise((r) => setTimeout(r, 10));
    expect(handle.controller.getState().credits.used).toBe(20);

    handle.dispose();
  });
});

// ===========================================================================
// 4. SLASH COMMANDS & SLOT REGISTRATION AGAINST MOCK OPENCODE 2.x TUI HOST
// ===========================================================================

describe("Slash Commands & Slot Registration (Mock OpenCode 2.x TUI Host)", () => {
  it("registers all 3 slots and all 4 slash commands with valid structures", () => {
    const host = createMockTuiHost({});
    const plugin = createKiroTuiPlugin({ autoRefresh: false, pollIntervalMs: 0 });
    expect(plugin.id).toBe("opencode-kiro");

    const handle = plugin.tui(host.api);

    expect([...host.slots.keys()].sort()).toEqual([
      "app_bottom",
      "sidebar_content",
      "sidebar_footer",
    ]);
    expect([...host.commands.keys()].sort()).toEqual([
      "/kiro-credits",
      "/kiro-login",
      "/kiro-models",
      "/kiro-status",
    ]);

    for (const [slotName, reg] of host.slots) {
      const node = reg.render();
      expect(node.slot).toBe(slotName);
      expect(typeof node.text).toBe("string");
    }

    handle.dispose();
  });

  it("executes /kiro-credits, /kiro-login, /kiro-models, and /kiro-status cleanly", async () => {
    const host = createMockTuiHost({
      [KIRO_RPC_METHODS.getAuthStatus]: async () => makeAuth(),
      [KIRO_RPC_METHODS.getCredits]: async () =>
        makeSnapshot({
          used: 410,
          limit: 500,
          remaining: 90,
          addonRemaining: 100,
          percentUsed: 82,
          contextUsagePercent: 45,
          lastTurnCredits: 2.5,
          planName: "Pro",
          resetAt: "2026-07-01T00:00:00.000Z",
          activeModel: "claude-sonnet-4",
        }),
      [KIRO_RPC_METHODS.refreshCredits]: async () =>
        makeSnapshot({
          used: 410,
          limit: 500,
          remaining: 90,
          addonRemaining: 100,
          percentUsed: 82,
          contextUsagePercent: 45,
          lastTurnCredits: 2.5,
          planName: "Pro",
          resetAt: "2026-07-01T00:00:00.000Z",
          activeModel: "claude-sonnet-4",
        }),
      [KIRO_RPC_METHODS.getActiveModel]: async () => "claude-sonnet-4",
      [KIRO_RPC_METHODS.listModels]: async () => [
        makeModel({ id: "claude-sonnet-4", qualifiedId: "kiro/claude-sonnet-4", isDefault: true }),
        makeModel({
          id: "claude-haiku-4",
          qualifiedId: "kiro/claude-haiku-4",
          name: "Claude Haiku 4",
          creditMultiplier: 0.25,
          isDefault: false,
        }),
      ],
      [KIRO_RPC_METHODS.login]: async () => ({
        ok: true,
        status: makeAuth({ accountLabel: "alice@example.com" }),
        message: "Authenticated with Kiro",
      }),
    });

    const plugin = createKiroTuiPlugin({ autoRefresh: false, pollIntervalMs: 0 });
    const handle = plugin.tui(host.api);

    // /kiro-credits
    await host.commands.get("/kiro-credits")!.handler();
    const creditsToast = host.toasts.at(-1)!;
    expect(creditsToast.title).toBe("Kiro Credits");
    expect(creditsToast.variant).toBe("warning"); // 82% => warning
    expect(creditsToast.message).toContain("410 / 500 (90 remaining)");
    expect(creditsToast.message).toContain("Add-on Pool: 100 remaining");
    expect(creditsToast.message).toContain("Last Turn: 2.5 cr");
    expect(creditsToast.message).toContain("Context: 45%");

    // /kiro-login
    await host.commands.get("/kiro-login")!.handler();
    const loginToast = host.toasts.at(-1)!;
    expect(loginToast.title).toBe("Kiro Login");
    expect(loginToast.variant).toBe("success");
    expect(loginToast.message).toContain("Authenticated with Kiro (alice@example.com)");

    // /kiro-models
    await host.commands.get("/kiro-models")!.handler();
    const modelsToast = host.toasts.at(-1)!;
    expect(modelsToast.title).toBe("Kiro Models (2)");
    expect(modelsToast.message).toContain("kiro/claude-sonnet-4");
    expect(modelsToast.message).toContain("[default]");
    expect(modelsToast.message).toContain("[active]");
    expect(modelsToast.message).toContain("(0.25x cr)");

    // /kiro-status
    await host.commands.get("/kiro-status")!.handler();
    const statusToast = host.toasts.at(-1)!;
    expect(statusToast.title).toBe("Kiro Status");
    expect(statusToast.variant).toBe("info");
    expect(statusToast.message).toContain("Authenticated as alice@example.com via builder-id");
    expect(statusToast.message).toContain("Kiro: 410/500 cr (82%)");

    handle.dispose();
  });

  it("handles /kiro-models empty state and /kiro-status when RPC is missing", async () => {
    const host = createMockTuiHost(undefined, { omitRpc: true });
    const plugin = createKiroTuiPlugin({ autoRefresh: false, pollIntervalMs: 0 });
    const handle = plugin.tui(host.api);

    await host.commands.get("/kiro-models")!.handler();
    expect(host.toasts.at(-1)!.message).toContain("No models available");
    expect(host.toasts.at(-1)!.variant).toBe("warning");

    await host.commands.get("/kiro-status")!.handler();
    const statusToast = host.toasts.at(-1)!;
    expect(statusToast.message).toContain("Auth: Unknown (server RPC unavailable)");
    expect(statusToast.variant).toBe("warning");

    handle.dispose();
  });
});

// ===========================================================================
// 5. OPENCODE 2.3.0 V2 TUI `Definition` CONTRACT, SUB-0.1 CREDITS & NODE DIST
// ===========================================================================

describe("OpenCode 2.3.0 V2 TUI setup() Contract, Sub-0.1 Credits & Node.js dist/tui.js", () => {
  it("formats positive sub-0.1 credits accurately alongside negative -0.01 -> '0'", () => {
    expect(formatCreditsNumber(0.0209)).toBe("0.0209");
    expect(formatCreditsNumber(0.0001)).toBe("0.0001");
    expect(formatCreditsNumber(0.00001)).toBe("0");
    expect(formatCreditsNumber(0.05)).toBe("0.05");
    expect(formatCreditsNumber(0.09999)).toBe("0.1");
    expect(formatCreditsNumber(-0.01)).toBe("0");
  });

  it("satisfies OpenCode 2.3.0 V2 Definition contract and registers keymap + event listener with working cleanup()", () => {
    expect(kiroTuiDefault.id).toBe("opencode-kiro");
    expect(typeof kiroTuiDefault.setup).toBe("function");
    expect(typeof setup).toBe("function");

    const toasts: Array<{ title?: string; message: string; variant?: string }> = [];
    const registeredEvents = new Map<string, (ev: unknown) => void>();
    const layers: Array<Record<string, unknown>> = [];
    let unsubCalled = 0;

    let currentModel: { providerID: string; modelID: string } | undefined = {
      providerID: "kiro",
      modelID: "claude-sonnet-4",
    };

    const mockV2Ctx = {
      ui: {
        toast: {
          show: (opts: { title?: string; message: string; variant?: string }) => {
            toasts.push(opts);
          },
        },
        model: {
          current: () => currentModel,
        },
        slot: () => () => {},
      },
      data: {
        on: (type: string, handler: (event: unknown) => void) => {
          registeredEvents.set(type, handler);
          return () => {
            unsubCalled += 1;
            registeredEvents.delete(type);
          };
        },
      },
      keymap: {
        layer: (factory: () => Record<string, unknown>) => {
          layers.push(factory());
        },
      },
    };

    const cleanup = kiroTuiDefault.setup(mockV2Ctx);
    expect(typeof cleanup).toBe("function");
    expect(registeredEvents.has("session.status")).toBe(true);
    expect(layers.length).toBe(1);

    const commands = layers[0]!.commands as Array<{
      id: string;
      title: string;
      category: string;
      onSelect: () => void;
    }>;
    expect(commands.length).toBe(1);
    expect(commands[0]!.id).toBe("opencode-kiro.status");

    commands[0]!.onSelect();
    expect(toasts.length).toBe(1);
    expect(toasts[0]!.message).toContain("kiro/claude-sonnet-4");

    // Cleanup should unsubscribe event listener and be idempotent
    (cleanup as () => void)();
    (cleanup as () => void)();
    expect(unsubCalled).toBe(1);
    expect(registeredEvents.size).toBe(0);
  });

  it("never throws if ctx.ui.model.current(), ctx.data.on(), ctx.keymap.layer(), or disposer throws", () => {
    const throwingCtx = {
      ui: {
        toast: {
          show: () => {},
        },
        model: {
          current: () => {
            throw new Error("Solid reactive read outside tracking scope");
          },
        },
      },
      data: {
        on: () => {
          throw new Error("Event type unavailable");
        },
      },
      keymap: {
        layer: () => {
          throw new Error("Keymap schema mismatch");
        },
      },
    };

    let cleanup: unknown;
    expect(() => {
      cleanup = kiroTuiDefault.setup(throwingCtx);
    }).not.toThrow();
    expect(typeof cleanup).toBe("function");
    expect(() => (cleanup as () => void)()).not.toThrow();

    // Also verify throwing disposer is swallowed cleanly
    const throwingDisposerCtx = {
      data: {
        on: () => () => {
          throw new Error("disposer boom");
        },
      },
    };
    const cleanup2 = kiroTuiDefault.setup(throwingDisposerCtx) as () => void;
    expect(() => cleanup2()).not.toThrow();
  });

  it("BUG CHECK: setup() V2 toast must sanitize activeModel (no ANSI or secret leakage)", () => {
    const toasts: Array<{ title?: string; message: string; variant?: string }> = [];
    const layers: Array<Record<string, unknown>> = [];

    const mockV2Ctx = {
      ui: {
        toast: {
          show: (opts: { title?: string; message: string; variant?: string }) => {
            toasts.push(opts);
          },
        },
        model: {
          current: () => ({
            providerID: "kiro",
            modelID: "\x1b[31mclaude sk-secretleak1234567890\x1b[0m",
          }),
        },
      },
      keymap: {
        layer: (factory: () => Record<string, unknown>) => {
          layers.push(factory());
        },
      },
    };

    const cleanup = kiroTuiDefault.setup(mockV2Ctx) as () => void;
    const commands = layers[0]!.commands as Array<{ onSelect: () => void }>;
    commands[0]!.onSelect();

    expect(toasts[0]!.message).not.toContain("\x1b");
    expect(toasts[0]!.message).not.toContain("sk-secretleak1234567890");
    cleanup();
  });

  it("BUG CHECK: setup() V2 must clear activeModel when user switches away from kiro provider", () => {
    const toasts: Array<{ title?: string; message: string; variant?: string }> = [];
    const layers: Array<Record<string, unknown>> = [];
    let currentModel: { providerID: string; modelID: string } = {
      providerID: "kiro",
      modelID: "claude-sonnet-4",
    };

    const mockV2Ctx = {
      ui: {
        toast: {
          show: (opts: { title?: string; message: string; variant?: string }) => {
            toasts.push(opts);
          },
        },
        model: {
          current: () => currentModel,
        },
      },
      keymap: {
        layer: (factory: () => Record<string, unknown>) => {
          layers.push(factory());
        },
      },
    };

    const cleanup = kiroTuiDefault.setup(mockV2Ctx) as () => void;
    const commands = layers[0]!.commands as Array<{ onSelect: () => void }>;

    // First select with kiro active
    commands[0]!.onSelect();
    expect(toasts.at(-1)!.message).toContain("kiro/claude-sonnet-4");

    // Switch to another provider — must NOT report stale kiro/claude-sonnet-4
    currentModel = { providerID: "anthropic", modelID: "claude-opus-4" };
    commands[0]!.onSelect();
    expect(toasts.at(-1)!.message).not.toContain("kiro/claude-sonnet-4");

    cleanup();
  });

  it("BUG CHECK: setup() should recognize V2 context with keymap.layer even without ui.slot/ui.toast.show/data.on", () => {
    let layerRegistered = false;
    const keymapOnlyV2Ctx = {
      keymap: {
        layer: () => {
          layerRegistered = true;
        },
      },
    };

    const cleanup = kiroTuiDefault.setup(keymapOnlyV2Ctx) as () => void;
    expect(layerRegistered).toBe(true);
    cleanup();
  });

  it("BUG CHECK: setup() cleanup should invoke disposer returned by ctx.keymap.layer()", () => {
    let keymapDisposed = false;
    const mockV2Ctx = {
      ui: {
        toast: { show: () => {} },
      },
      keymap: {
        layer: () => () => {
          keymapDisposed = true;
        },
      },
    };

    const cleanup = kiroTuiDefault.setup(mockV2Ctx) as () => void;
    cleanup();
    expect(keymapDisposed).toBe(true);
  });

  it("dist/tui.js imports and executes cleanly under real Node.js (node -e)", () => {
    const script = `
      import("./dist/tui.js").then((m) => {
        if (m.default?.id !== "opencode-kiro") throw new Error("bad id");
        if (typeof m.default?.setup !== "function") throw new Error("missing setup");
        const toasts = [];
        let unsubscribed = false;
        const layers = [];
        const cleanup = m.default.setup({
          ui: {
            model: { current: () => ({ providerID: "kiro", modelID: "claude-sonnet-4" }) },
            toast: { show: (t) => toasts.push(t) },
          },
          data: {
            on: () => () => { unsubscribed = true; },
          },
          keymap: {
            layer: (factory) => { layers.push(factory()); },
          },
        });
        layers[0].commands[0].onSelect();
        cleanup();
        if (!unsubscribed) throw new Error("cleanup did not unsubscribe");
        if (toasts.length !== 1) throw new Error("toast not shown");
        if (m.formatCreditsNumber(0.0209) !== "0.0209") throw new Error("bad sub-0.1 format");
        if (m.formatCreditsNumber(0.0001) !== "0.0001") throw new Error("bad 0.0001 format");
        if (m.formatCreditsNumber(0.00001) !== "0") throw new Error("bad 0.00001 format");
        if (m.formatCreditsNumber(-0.01) !== "0") throw new Error("bad -0.01 format");
        console.log("NODE_DIST_TUI_VERIFIED");
      });
    `;

    const proc = Bun.spawnSync(["node", "-e", script], {
      cwd: "/Users/sigma/Documents/antigravity/opencode-kiro",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("NODE_DIST_TUI_VERIFIED");
  });
});
