import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  KiroAuthManager,
  assertNoCredentialLeak,
  spawnKiroCli,
  validateCliPath,
} from "../src/auth";
import { KiroModelDiscovery } from "../src/discovery";
import type { AcpInitializeResult, AcpSessionNewResult } from "../src/types";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const MOCK_CLI = join(PROJECT_ROOT, "tests", "fixtures", "mock-kiro-cli.ts");

const TEMP_DIR = mkdtempSync(join(tmpdir(), "opencode-kiro-adv-"));
const SAVED_ENV: Record<string, string | undefined> = {};

const ENV_KEYS = [
  "MOCK_KIRO_AUTH",
  "MOCK_KIRO_STATE_FILE",
  "MOCK_KIRO_LOGIN_FAIL",
  "MOCK_KIRO_MODELS_FORMAT",
  "KIRO_API_KEY",
] as const;

function saveEnv(): void {
  for (const key of ENV_KEYS) {
    if (!(key in SAVED_ENV)) {
      SAVED_ENV[key] = process.env[key];
    }
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const prev = SAVED_ENV[key];
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

function writeTempScript(name: string, content: string): string {
  const path = join(TEMP_DIR, name);
  writeFileSync(path, content, "utf8");
  return path;
}

saveEnv();

afterEach(() => {
  restoreEnv();
});

afterAll(() => {
  restoreEnv();
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

// ============================================================================
// 1. STATIC & RUNTIME CREDENTIAL-SCRAPING AUDIT
// ============================================================================

describe("Security Audit: Zero Credential Scraping", () => {
  const AUDIT_FILES = [
    join(PROJECT_ROOT, "src", "auth", "index.ts"),
    join(PROJECT_ROOT, "src", "auth", "kiro-auth.ts"),
    join(PROJECT_ROOT, "src", "discovery", "index.ts"),
    join(PROJECT_ROOT, "src", "discovery", "model-discovery.ts"),
  ];

  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  test("src/auth and src/discovery contain ZERO filesystem, sqlite, keychain, or secret env scraping", () => {
    const forbiddenPatterns: Array<{ name: string; re: RegExp }> = [
      { name: "node:fs import", re: /from\s+["'](?:node:)?fs(?:\/promises)?["']/ },
      { name: "bun:sqlite or sqlite", re: /(?:bun:)?sqlite|better-sqlite3/i },
      { name: "keytar / keychain", re: /keytar|security\s+find-generic-password|keychain/i },
      { name: "~/.kiro path", re: /~\/\.kiro|\.kiro[/\\]/ },
      { name: "~/.aws path", re: /~\/\.aws|\.aws[/\\]/ },
      { name: "auth.json reference", re: /auth\.json/i },
      { name: "KIRO_API_KEY access", re: /KIRO_API_KEY/ },
      { name: "shell: true execution", re: /shell\s*:\s*true/ },
    ];

    for (const file of AUDIT_FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const { name, re } of forbiddenPatterns) {
        expect(re.test(code), `${file} must not match forbidden pattern: ${name}`).toBe(false);
      }
    }
  });

  test("runtime: KIRO_API_KEY in env is never extracted or returned by auth methods", async () => {
    const canarySecret = "kiro-canary-secret-99999";
    process.env.KIRO_API_KEY = canarySecret;
    process.env.MOCK_KIRO_AUTH = "1";

    const manager = new KiroAuthManager({ cliPath: MOCK_CLI });
    const status = await manager.getStatus();
    const loginRes = await manager.login();
    const hook = manager.createOpenCodeAuthHook();
    const loaded = await hook.loader?.({ apiKey: canarySecret, token: canarySecret }, "kiro");
    const authFlow = await hook.methods[0]?.authorize?.();
    const cbRes = await authFlow?.callback?.();

    const serialized = JSON.stringify({ status, loginRes, loaded, cbRes });
    expect(serialized).not.toContain(canarySecret);
    expect(status.managedBy).toBe("kiro-cli");
    expect(loaded).toEqual({
      managedBy: "kiro-cli",
      provider: "kiro",
      protocol: "acp",
    });
  });
});

// ============================================================================
// 2. STRICT PROVIDER ISOLATION (auth.loader & assertNoCredentialLeak)
// ============================================================================

describe("Security Audit: Provider Isolation", () => {
  test("auth.loader accepts strictly 'kiro' and rejects all other provider IDs", async () => {
    const manager = new KiroAuthManager({ cliPath: MOCK_CLI });
    const hook = manager.createOpenCodeAuthHook();

    expect(hook.provider).toBe("kiro");
    const ok = await hook.loader?.(null, "kiro");
    expect(ok).toEqual({
      managedBy: "kiro-cli",
      provider: "kiro",
      protocol: "acp",
    });

    const forbiddenProviders: unknown[] = [
      "openai",
      "anthropic",
      "google",
      "bedrock",
      "kiro ",
      " kiro",
      "KIRO",
      "Kiro",
      "kiro/auto",
      "kiro\0",
      "__proto__",
      "constructor",
      "prototype",
      "toString",
      "",
      "   ",
      null,
      undefined,
      123,
      { toString: () => "kiro" },
      ["kiro"],
    ];

    for (const bad of forbiddenProviders) {
      expect(() => assertNoCredentialLeak(bad as string)).toThrow(
        /Kiro credential isolation violation/
      );
      await expect(hook.loader!(null, bad as string)).rejects.toThrow(
        /Kiro credential isolation violation/
      );
    }
  });
});

// ============================================================================
// 3. COMMAND INJECTION, PATH VALIDATION & SUBPROCESS EDGE CASES
// ============================================================================

describe("Security Audit: Command Injection & Subprocess Safety", () => {
  test("validateCliPath rejects empty, whitespace, and null-byte paths", () => {
    expect(() => validateCliPath("")).toThrow();
    expect(() => validateCliPath("   ")).toThrow();
    expect(() => validateCliPath("\t\n")).toThrow();
    expect(() => validateCliPath("kiro-cli\0--evil")).toThrow();
    expect(() => validateCliPath(null as unknown as string)).toThrow();
  });

  test("ADVERSARIAL BUG: validateCliPath should reject flag-injection cliPaths starting with '-' (e.g. '--preload=evil.js')", () => {
    // Because spawnKiroCli runs `spawn(process.execPath, [validatedPath, ...args])`
    // whenever cliPath ends in `.js`/`.ts`, a path like `--preload=evil.js`
    // is interpreted as a Bun/Node CLI flag rather than a script path!
    expect(() => validateCliPath("--preload=/tmp/evil.js")).toThrow();
    expect(() => validateCliPath("-e=evil.js")).toThrow();
  });

  test("spawnKiroCli uses shell: false and does not execute shell metacharacters", async () => {
    const marker = join(TEMP_DIR, "shell-injection-pwned");
    const res = await spawnKiroCli(
      `kiro-cli; touch ${marker}`,
      ["whoami", `$(touch ${marker})`, "&&", `touch ${marker}`],
      { timeoutMs: 2000 }
    );

    expect(res.spawnFailed).toBe(true);
    expect(Bun.file(marker).size).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("kiro-cli whoami & login handle missing binary (ENOENT) cleanly", async () => {
    const missingBin = join(TEMP_DIR, "definitely-does-not-exist-kiro-cli");
    const manager = new KiroAuthManager({ cliPath: missingBin, requestTimeoutMs: 2000 });

    const status = await manager.getStatus();
    expect(status.authenticated).toBe(false);
    expect(status.cliAvailable).toBe(false);
    expect(status.error).toBeTruthy();

    const loginRes = await manager.login({ timeoutMs: 2000 });
    expect(loginRes.ok).toBe(false);
    expect(loginRes.status.authenticated).toBe(false);
    expect(loginRes.status.cliAvailable).toBe(false);
  });

  test("kiro-cli whoami & login handle unauthenticated -> login -> authenticated flow", async () => {
    const stateFile = join(TEMP_DIR, "auth-state.txt");
    writeFileSync(stateFile, "unauthenticated", "utf8");
    process.env.MOCK_KIRO_STATE_FILE = stateFile;

    let callbackFired = 0;
    const manager = new KiroAuthManager({ cliPath: MOCK_CLI });

    const before = await manager.getStatus();
    expect(before.authenticated).toBe(false);
    expect(before.cliAvailable).toBe(true);
    expect(before.error).toContain("Not logged in");

    const hook = manager.createOpenCodeAuthHook(() => {
      callbackFired += 1;
    });
    const authFlow = await hook.methods[0]!.authorize!();
    const cbResult = await authFlow.callback!();

    expect(cbResult.ok).toBe(true);
    expect(cbResult.authenticated).toBe(true);
    expect(callbackFired).toBe(1);

    const after = await manager.getStatus();
    expect(after.authenticated).toBe(true);
    expect(after.accountLabel).toContain("dev@example.com");
  });

  test("kiro-cli login handles non-zero exit cleanly without firing onAuthenticated", async () => {
    process.env.MOCK_KIRO_AUTH = "0";
    process.env.MOCK_KIRO_LOGIN_FAIL = "1";

    let callbackFired = 0;
    const manager = new KiroAuthManager({ cliPath: MOCK_CLI });
    const hook = manager.createOpenCodeAuthHook(() => {
      callbackFired += 1;
    });

    const authFlow = await hook.methods[0]!.authorize!();
    const cbResult = await authFlow.callback!();

    expect(cbResult.ok).toBe(false);
    expect(cbResult.authenticated).toBe(false);
    expect(callbackFired).toBe(0);
  });

  test("kiro-cli login handles non-interactive stdin EOF cleanly without hanging", async () => {
    const interactiveScript = writeTempScript(
      "non-interactive-login.ts",
      `
      if (process.argv[2] === "login") {
        // Attempt to read stdin as an interactive prompt would; with stdio: ignore, EOF is immediate
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(Buffer.from(chunk));
        }
        if (chunks.length === 0) {
          console.error("Cannot run interactive login in non-interactive terminal");
          process.exit(1);
        }
        process.exit(0);
      }
      console.error("Not logged in");
      process.exit(1);
      `
    );

    const manager = new KiroAuthManager({ cliPath: interactiveScript, requestTimeoutMs: 2000 });
    const res = await manager.login({ timeoutMs: 2000 });
    expect(res.ok).toBe(false);
    expect(res.status.authenticated).toBe(false);
    expect(res.output).toContain("non-interactive");
  });

  test("kiro-cli whoami handles normal timeout cleanly", async () => {
    const slowScript = writeTempScript(
      "slow-whoami.ts",
      `await new Promise((r) => setTimeout(r, 10_000));`
    );

    const manager = new KiroAuthManager({ cliPath: slowScript, requestTimeoutMs: 150 });
    const started = Date.now();
    const status = await manager.getStatus();
    const elapsed = Date.now() - started;

    expect(status.authenticated).toBe(false);
    expect(status.cliAvailable).toBe(true);
    expect(status.error).toContain("timed out");
    expect(elapsed).toBeLessThan(2000);
  });

  test("ADVERSARIAL BUG: spawnKiroCli must escalate to SIGKILL if child ignores SIGTERM (no hang/zombie)", async () => {
    const stubbornScript = writeTempScript(
      "ignore-sigterm.ts",
      `
      process.on("SIGTERM", () => {
        // Deliberately ignore SIGTERM
      });
      await new Promise((r) => setTimeout(r, 4000));
      `
    );

    const started = Date.now();
    const raceResult = await Promise.race([
      spawnKiroCli(stubbornScript, ["whoami"], { timeoutMs: 150 }).then((r) => ({
        kind: "resolved" as const,
        r,
      })),
      new Promise<{ kind: "hung" }>((resolve) =>
        setTimeout(() => resolve({ kind: "hung" }), 1200)
      ),
    ]);
    const elapsed = Date.now() - started;

    // Without SIGKILL escalation, spawnKiroCli hangs until the child exits naturally (4000ms)
    expect(raceResult.kind).toBe("resolved");
    expect(elapsed).toBeLessThan(1200);
  });

  test("ADVERSARIAL BUG: parseWhoamiOutput regex corrupts 'Username: alice@example.com' into 'name: alice@example.com'", async () => {
    const usernameScript = writeTempScript(
      "whoami-username.ts",
      `console.log("Username: alice@example.com"); process.exit(0);`
    );

    const manager = new KiroAuthManager({ cliPath: usernameScript, requestTimeoutMs: 2000 });
    const status = await manager.getStatus();

    expect(status.authenticated).toBe(true);
    expect(status.accountLabel).not.toBe("name: alice@example.com");
    expect(status.accountLabel).toContain("alice@example.com");
    expect(status.accountLabel?.startsWith("name:")).toBe(false);
  });
});

// ============================================================================
// 4. MODEL DISCOVERY EDGE CASES
// ============================================================================

describe("Model Discovery: ACP, CLI, Malformed, Deduplication & Caching", () => {
  test("discovers models from ACP session/new availableModels and respects currentModelId", async () => {
    const discovery = new KiroModelDiscovery({ cliPath: "/nonexistent/kiro-cli" });
    const acpSession: AcpSessionNewResult = {
      sessionId: "sess-1",
      models: {
        currentModelId: "claude-opus-4.5",
        availableModels: [
          {
            id: "claude-sonnet-4.5",
            name: "Claude Sonnet 4.5",
            contextWindow: 200_000,
            maxOutputTokens: 16_384,
            creditMultiplier: 1.3,
            reasoning: true,
            supportsTools: true,
            supportsVision: true,
          },
          {
            id: "kiro/claude-opus-4.5",
            name: "Claude Opus 4.5",
            contextWindow: 200_000,
            maxOutputTokens: 32_768,
            creditMultiplier: 2.5,
            reasoning: true,
          },
        ],
      },
    };

    const models = await discovery.discover({ acpSession });
    expect(models).toHaveLength(2);
    expect(models[0]?.id).toBe("claude-sonnet-4.5");
    expect(models[0]?.qualifiedId).toBe("kiro/claude-sonnet-4.5");
    expect(models[0]?.isDefault).toBe(false);
    expect(models[1]?.id).toBe("claude-opus-4.5");
    expect(models[1]?.qualifiedId).toBe("kiro/claude-opus-4.5");
    expect(models[1]?.isDefault).toBe(true);
    expect(models[1]?.source).toBe("acp");
  });

  test("discovers models from ACP v3 configOptions and ignores non-model options", async () => {
    const discovery = new KiroModelDiscovery({ cliPath: "/nonexistent/kiro-cli" });
    const acpSession: AcpSessionNewResult = {
      sessionId: "sess-v3",
      configOptions: [
        {
          id: "thinking",
          category: "reasoning",
          currentValue: "high",
          options: [{ value: "high", name: "High" }],
        },
        {
          id: "model",
          category: "model",
          currentValue: "kiro/claude-sonnet-4.5",
          options: [
            { value: "claude-sonnet-4.5", name: "Sonnet 4.5", description: "Fast" },
            { value: "auto", name: "Kiro Auto" },
          ],
        },
      ],
    };

    const models = await discovery.discover({ acpSession });
    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-4.5", "auto"]);
    expect(models[0]?.isDefault).toBe(true);
    expect(models[1]?.isDefault).toBe(false);
  });

  test("discovers models from CLI JSON output via mock-kiro-cli", async () => {
    process.env.MOCK_KIRO_MODELS_FORMAT = "json";
    const discovery = new KiroModelDiscovery({ cliPath: MOCK_CLI });
    const models = await discovery.discover();

    expect(models.length).toBe(3);
    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-4.5", "claude-opus-4.5", "auto"]);
    expect(models.every((m) => m.source === "cli")).toBe(true);
    expect(models[0]?.creditMultiplier).toBe(1.3);
  });

  test("discovers models from CLI plain-text table output via mock-kiro-cli", async () => {
    process.env.MOCK_KIRO_MODELS_FORMAT = "text";
    const discovery = new KiroModelDiscovery({ cliPath: MOCK_CLI });
    const models = await discovery.discover();

    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-4.5", "claude-opus-4.5", "auto"]);
    expect(models[0]?.isDefault).toBe(true);
    expect(models[0]?.creditMultiplier).toBe(1.3);
    expect(models[1]?.creditMultiplier).toBe(2.5);
    expect(models[2]?.creditMultiplier).toBe(1.0);
  });

  test("falls back safely to 'auto' on malformed JSON from CLI", async () => {
    process.env.MOCK_KIRO_MODELS_FORMAT = "invalid";
    const discovery = new KiroModelDiscovery({ cliPath: MOCK_CLI });
    const models = await discovery.discover();

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("auto");
    expect(models[0]?.source).toBe("fallback");
  });

  test("falls back safely on empty JSON lists [] and { models: [] }", () => {
    const discovery = new KiroModelDiscovery({ cliPath: MOCK_CLI });
    expect(discovery.parseCliModelsOutput("[]")).toEqual([]);
    expect(discovery.parseCliModelsOutput('{"models":[]}')).toEqual([]);
    expect(discovery.parseCliModelsOutput("")).toEqual([]);
    expect(discovery.parseCliModelsOutput("   \n\t  ")).toEqual([]);
  });

  test("deduplicates duplicate model IDs including prefixed 'kiro/<id>' vs '<id>'", () => {
    const discovery = new KiroModelDiscovery({ cliPath: MOCK_CLI });
    const parsed = discovery.parseCliModelsOutput(
      JSON.stringify([
        { id: "claude-sonnet-4.5", name: "Sonnet", reasoning: false },
        { id: "kiro/claude-sonnet-4.5", description: "Detailed desc", reasoning: true, creditMultiplier: 1.3 },
      ])
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("claude-sonnet-4.5");
    expect(parsed[0]?.qualifiedId).toBe("kiro/claude-sonnet-4.5");
    expect(parsed[0]?.name).toBe("Sonnet");
    expect(parsed[0]?.description).toBe("Detailed desc");
    expect(parsed[0]?.reasoning).toBe(true);
    expect(parsed[0]?.creditMultiplier).toBe(1.3);
  });

  test("TTL cache hit, expiry, forceRefresh, and invalidateCache work as expected", async () => {
    const discovery = new KiroModelDiscovery({
      cliPath: "/nonexistent/kiro-cli",
      modelCacheTtlMs: 80,
    });

    const firstAcp: AcpInitializeResult = {
      protocolVersion: 1,
      models: [{ id: "model-a", name: "Model A" }],
    };
    const secondAcp: AcpInitializeResult = {
      protocolVersion: 1,
      models: [{ id: "model-b", name: "Model B" }],
    };

    const r1 = await discovery.discover({ acpInit: firstAcp });
    expect(r1.map((m) => m.id)).toEqual(["model-a"]);

    // Within TTL -> returns cached
    const r2 = await discovery.discover({ acpInit: secondAcp });
    expect(r2.map((m) => m.id)).toEqual(["model-a"]);

    // forceRefresh bypasses TTL
    const r3 = await discovery.discover({ acpInit: secondAcp, forceRefresh: true });
    expect(r3.map((m) => m.id)).toEqual(["model-b"]);

    // invalidateCache clears cache immediately
    discovery.invalidateCache();
    expect(discovery.getCachedModels()).toEqual([]);

    const r4 = await discovery.discover({ acpInit: firstAcp });
    expect(r4.map((m) => m.id)).toEqual(["model-a"]);

    // Wait for TTL expiry
    await new Promise((r) => setTimeout(r, 110));
    const r5 = await discovery.discover({ acpInit: secondAcp });
    expect(r5.map((m) => m.id)).toEqual(["model-b"]);
  });

  // ---- Adversarial Bug Reproducers for Model Discovery ----

  test("ADVERSARIAL BUG: parsePlainTextModels must NOT turn error/prose messages into fake model IDs", () => {
    const discovery = new KiroModelDiscovery({ cliPath: MOCK_CLI });
    const parsed = discovery.parseCliModelsOutput(
      "Error: Not authenticated\nPlease run kiro-cli login"
    );
    expect(parsed).toEqual([]);
  });

  test("ADVERSARIAL BUG: parsePlainTextModels must NOT treat pipe-table headers as a model ID", () => {
    const discovery = new KiroModelDiscovery({ cliPath: MOCK_CLI });
    const table = [
      "| Model | Name | Credits |",
      "| --- | --- | --- |",
      "| claude-sonnet-4.5 | Claude Sonnet 4.5 | 1.3x |",
    ].join("\n");

    const parsed = discovery.parseCliModelsOutput(table);
    expect(parsed.map((m) => m.id)).toEqual(["claude-sonnet-4.5"]);
  });

  test("ADVERSARIAL BUG: parsePlainTextModels must NOT drop real model IDs starting with 'model-'", () => {
    const discovery = new KiroModelDiscovery({ cliPath: MOCK_CLI });
    const parsed = discovery.parseCliModelsOutput("model-v2  Model V2  1.0x");
    expect(parsed.map((m) => m.id)).toEqual(["model-v2"]);
  });

  test("ADVERSARIAL BUG: cached fallback catalog should NOT block fresh ACP models passed to discover()", async () => {
    const discovery = new KiroModelDiscovery({
      cliPath: "/nonexistent/kiro-cli",
      modelCacheTtlMs: 60_000,
    });

    // Initial discovery before ACP connects falls back to "auto"
    const fallback = await discovery.discover();
    expect(fallback[0]?.source).toBe("fallback");

    // Once ACP connects and supplies real models, discover({ acpSession }) should not stay stuck on fallback
    const acpSession: AcpSessionNewResult = {
      sessionId: "sess-live",
      models: {
        currentModelId: "claude-sonnet-4.5",
        availableModels: [{ id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" }],
      },
    };
    const live = await discovery.discover({ acpSession });
    expect(live[0]?.source).toBe("acp");
    expect(live[0]?.id).toBe("claude-sonnet-4.5");
  });

  test("ADVERSARIAL BUG: mutating returned model objects must NOT corrupt internal cache", async () => {
    const discovery = new KiroModelDiscovery({ cliPath: "/nonexistent/kiro-cli" });
    const acpInit: AcpInitializeResult = {
      protocolVersion: 1,
      models: [{ id: "claude-sonnet-4.5", name: "Original Name" }],
    };

    const first = await discovery.discover({ acpInit });
    first[0]!.name = "MUTATED_BY_CALLER";

    const cached = discovery.getCachedModels();
    expect(cached[0]?.name).toBe("Original Name");
  });

  test("ADVERSARIAL BUG: malformed ACP availableModels entry without 'id' must not crash discover()", async () => {
    const discovery = new KiroModelDiscovery({ cliPath: "/nonexistent/kiro-cli" });
    const malformedSession = {
      sessionId: "sess-bad",
      models: {
        availableModels: [
          { name: "Missing ID" },
          null,
          { id: "claude-sonnet-4.5", name: "Valid Model" },
        ],
      },
    } as unknown as AcpSessionNewResult;

    const models = await discovery.discover({ acpSession: malformedSession });
    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-4.5"]);
  });

  test("ADVERSARIAL BUG: deduplicateModels drops richer contextLimit/outputLimit from later duplicate entries", async () => {
    const discovery = new KiroModelDiscovery({ cliPath: "/nonexistent/kiro-cli" });
    // configOptions has minimal metadata (defaults to 200k / 8192), while acpInit has richer limits
    const acpSession: AcpSessionNewResult = {
      sessionId: "sess-dup",
      configOptions: [
        {
          id: "model",
          category: "model",
          currentValue: "claude-opus-4.5",
          options: [{ value: "claude-opus-4.5", name: "Claude Opus 4.5" }],
        },
      ],
    };
    const acpInit: AcpInitializeResult = {
      protocolVersion: 1,
      models: [
        {
          id: "claude-opus-4.5",
          name: "Claude Opus 4.5",
          contextWindow: 1_000_000,
          maxOutputTokens: 32_768,
        },
      ],
    };

    const models = await discovery.discover({ acpInit, acpSession });
    expect(models).toHaveLength(1);
    expect(models[0]?.contextLimit).toBe(1_000_000);
    expect(models[0]?.outputLimit).toBe(32_768);
  });
});
