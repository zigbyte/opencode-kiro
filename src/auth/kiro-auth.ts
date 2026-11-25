import { spawn } from "node:child_process";
import {
  KIRO_PROVIDER_ID,
  type AcpInitializeResult,
  type KiroAuthStatus,
  type KiroPluginOptions,
  type OpenCodeAuthHook,
} from "../types";

const DEFAULT_CLI_PATH = "kiro-cli";
const DEFAULT_WHOAMI_TIMEOUT_MS = 15_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 120_000;
const SIGKILL_GRACE_MS = 500;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB cap per stream

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

export interface SpawnKiroCliOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface SpawnKiroCliResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnFailed: boolean;
  error?: string;
}

/**
 * Validates that a CLI path is non-empty, contains no control characters or
 * null bytes, and does not start with `-` (preventing flag injection when
 * script fixtures are invoked via `process.execPath`).
 */
export function validateCliPath(cliPath: string): string {
  if (typeof cliPath !== "string" || cliPath.trim().length === 0) {
    throw new Error("Invalid kiro-cli path: path must be a non-empty string.");
  }
  if (CONTROL_CHAR_RE.test(cliPath)) {
    throw new Error(
      "Invalid kiro-cli path: path must not contain null bytes or control characters."
    );
  }
  if (cliPath.trim().startsWith("-")) {
    throw new Error(
      "Invalid kiro-cli path: path must not start with '-' (flag injection rejected)."
    );
  }
  return cliPath;
}

/**
 * Spawns `kiro-cli` strictly via argv array with `shell: false`.
 * If `cliPath` ends in `.ts` or `.js`, executes via `process.execPath` so
 * test fixtures and script shims work seamlessly without shell invocation.
 */
export function spawnKiroCli(
  cliPath: string,
  args: string[],
  opts: SpawnKiroCliOptions = {}
): Promise<SpawnKiroCliResult> {
  const validatedPath = validateCliPath(cliPath);
  const isScriptFixture =
    validatedPath.endsWith(".ts") || validatedPath.endsWith(".js");

  const command = isScriptFixture ? process.execPath : validatedPath;
  const spawnArgs = isScriptFixture ? [validatedPath, ...args] : [...args];

  return new Promise<SpawnKiroCliResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: SpawnKiroCliResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      resolve(result);
    };

    let child;
    try {
      child = spawn(command, spawnArgs, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnFailed: true,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore kill errors if process already exited
        }
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore kill errors if process already exited
          }
        }, SIGKILL_GRACE_MS);
      }, opts.timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      stdout += slice.toString("utf8");
      stdoutBytes += slice.length;
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderrBytes >= MAX_OUTPUT_BYTES) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const remaining = MAX_OUTPUT_BYTES - stderrBytes;
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      stderr += slice.toString("utf8");
      stderrBytes += slice.length;
    });

    child.on("error", (err: Error) => {
      finish({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        spawnFailed: true,
        error: err.message,
      });
    });

    child.on("close", (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        spawnFailed: false,
        error: timedOut
          ? `kiro-cli command timed out after ${opts.timeoutMs}ms`
          : undefined,
      });
    });
  });
}

/**
 * Enforces strict provider isolation: Kiro authentication state may NEVER
 * be loaded or reused for any provider other than `"kiro"`.
 */
export function assertNoCredentialLeak(providerId: string): void {
  if (providerId !== KIRO_PROVIDER_ID) {
    throw new Error(
      `Kiro credential isolation violation: Kiro auth cannot be loaded for provider "${providerId}". ` +
        `Kiro authentication is strictly restricted to provider "${KIRO_PROVIDER_ID}".`
    );
  }
}

function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE_RE, "");
}

function parseWhoamiOutput(raw: string): {
  authenticated: boolean;
  accountLabel: string | null;
  authMethod: string | null;
} {
  const cleaned = stripAnsi(raw).trim();
  if (!cleaned) {
    return { authenticated: true, accountLabel: null, authMethod: null };
  }

  // Try structured JSON first (kiro-cli 3.6.1 `whoami --format json`)
  if (cleaned.startsWith("{")) {
    try {
      const parsed = JSON.parse(cleaned) as Record<string, unknown>;
      const explicitAuth =
        typeof parsed.authenticated === "boolean"
          ? parsed.authenticated
          : typeof parsed.loggedIn === "boolean"
            ? parsed.loggedIn
            : true;

      // Only read strictly non-secret display fields
      const labelCandidate =
        parsed.accountLabel ??
        parsed.email ??
        parsed.username ??
        parsed.user ??
        parsed.account ??
        parsed.profile;

      const methodCandidate =
        parsed.authMethod ??
        parsed.identityProvider ??
        parsed.method ??
        parsed.provider ??
        parsed.type;

      return {
        authenticated: explicitAuth,
        accountLabel:
          typeof labelCandidate === "string" && labelCandidate.trim().length > 0
            ? labelCandidate.trim()
            : null,
        authMethod:
          typeof methodCandidate === "string" &&
          methodCandidate.trim().length > 0
            ? methodCandidate.trim()
            : null,
      };
    } catch {
      // Fall through to plain-text parsing
    }
  }

  const lower = cleaned.toLowerCase();
  if (
    lower.includes("not logged in") ||
    lower.includes("not authenticated") ||
    lower.includes("unauthenticated")
  ) {
    return { authenticated: false, accountLabel: null, authMethod: null };
  }

  // Plain-text parsing: extract non-secret account label and optional method
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let accountLabel: string | null = null;
  let authMethod: string | null = null;

  for (const line of lines) {
    const loggedInMatch = line.match(
      /^(?:logged\s+in\s+as\s+|(?:username|user|account|email)\s*[:\-]\s*)(.+)$/i
    );
    if (loggedInMatch && loggedInMatch[1]) {
      accountLabel = loggedInMatch[1].trim();
      continue;
    }

    const methodMatch = line.match(
      /^(?:auth\s*method|identity\s*provider|method|provider)\s*[:\-]\s*(.+)$/i
    );
    if (methodMatch && methodMatch[1]) {
      authMethod = methodMatch[1].trim();
      continue;
    }

    if (!accountLabel) {
      accountLabel = line;
    }
  }

  return {
    authenticated: true,
    accountLabel,
    authMethod,
  };
}

/**
 * Manages Kiro authentication by delegating 100% to `kiro-cli login`,
 * `kiro-cli whoami`, and ACP `initialize` `authMethods`.
 *
 * Security invariants:
 * - NEVER reads `~/.kiro`, SQLite databases, macOS Keychain, `~/.aws`, or secret env vars.
 * - NEVER extracts, caches, or exposes raw tokens or API keys.
 */
export class KiroAuthManager {
  private readonly cliPath: string;
  private readonly cwd?: string;
  private readonly requestTimeoutMs: number;

  constructor(options: KiroPluginOptions = {}) {
    this.cliPath = validateCliPath(options.cliPath ?? DEFAULT_CLI_PATH);
    this.cwd = options.cwd;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_WHOAMI_TIMEOUT_MS;
  }

  getCliPath(): string {
    return this.cliPath;
  }

  /**
   * Checks authentication status using `kiro-cli whoami --format json`
   * (falling back to plain `kiro-cli whoami` if `--format` is unsupported)
   * and optional ACP `initialize` metadata. Returns only non-secret status fields.
   */
  async getStatus(acpClient?: {
    getInitializeResult(): AcpInitializeResult | null;
  }): Promise<KiroAuthStatus> {
    const checkedAt = new Date().toISOString();
    const acpInit = acpClient?.getInitializeResult() ?? null;
    const acpAuthMethod =
      acpInit?.authMethods?.[0]?.id ?? acpInit?.authMethods?.[0]?.name ?? null;

    let result = await spawnKiroCli(
      this.cliPath,
      ["whoami", "--format", "json"],
      {
        cwd: this.cwd,
        timeoutMs: this.requestTimeoutMs,
      }
    );

    // Fallback to plain `kiro-cli whoami` if older CLI rejects `--format json`
    if (
      !result.spawnFailed &&
      !result.timedOut &&
      result.exitCode !== 0 &&
      /unexpected\s+argument|unknown\s+option|unrecognized|invalid\s+(?:option|flag).*format/i.test(
        result.stderr
      )
    ) {
      result = await spawnKiroCli(this.cliPath, ["whoami"], {
        cwd: this.cwd,
        timeoutMs: this.requestTimeoutMs,
      });
    }

    if (result.spawnFailed) {
      return {
        authenticated: false,
        managedBy: "kiro-cli",
        accountLabel: null,
        authMethod: acpAuthMethod,
        cliAvailable: false,
        cliPath: this.cliPath,
        checkedAt,
        error: result.error ?? `Failed to execute ${this.cliPath}`,
      };
    }

    if (result.timedOut) {
      return {
        authenticated: false,
        managedBy: "kiro-cli",
        accountLabel: null,
        authMethod: acpAuthMethod,
        cliAvailable: true,
        cliPath: this.cliPath,
        checkedAt,
        error: result.error,
      };
    }

    if (result.exitCode === 0) {
      const parsed = parseWhoamiOutput(result.stdout);
      return {
        authenticated: parsed.authenticated,
        managedBy: "kiro-cli",
        accountLabel: parsed.accountLabel,
        authMethod: parsed.authMethod ?? acpAuthMethod ?? "kiro-cli",
        cliAvailable: true,
        cliPath: this.cliPath,
        checkedAt,
      };
    }

    const errorOutput = stripAnsi(result.stderr || result.stdout).trim();
    return {
      authenticated: false,
      managedBy: "kiro-cli",
      accountLabel: null,
      authMethod: acpAuthMethod,
      cliAvailable: true,
      cliPath: this.cliPath,
      checkedAt,
      error:
        errorOutput ||
        "Not authenticated with Kiro CLI. Run `kiro-cli login` to sign in.",
    };
  }

  /**
   * Invokes `kiro-cli login` with `shell: false` and refreshes auth status.
   */
  async login(options?: {
    timeoutMs?: number;
  }): Promise<{ ok: boolean; status: KiroAuthStatus; output: string }> {
    const result = await spawnKiroCli(this.cliPath, ["login"], {
      cwd: this.cwd,
      timeoutMs: options?.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    });

    const output = stripAnsi(
      [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")
    ).trim();

    if (result.spawnFailed || result.timedOut) {
      const status: KiroAuthStatus = {
        authenticated: false,
        managedBy: "kiro-cli",
        accountLabel: null,
        authMethod: null,
        cliAvailable: !result.spawnFailed,
        cliPath: this.cliPath,
        checkedAt: new Date().toISOString(),
        error:
          result.error ??
          (result.spawnFailed
            ? `Failed to execute ${this.cliPath}`
            : "kiro-cli login timed out"),
      };

      return {
        ok: false,
        status,
        output: output || status.error || "",
      };
    }

    const status = await this.getStatus();
    const ok = result.exitCode === 0 && status.authenticated;

    return {
      ok,
      status,
      output: output || result.error || "",
    };
  }

  /**
   * Creates the OpenCode 2.x `auth` hook for `provider: "kiro"`.
   * Enforces strict provider isolation via `assertNoCredentialLeak` and never
   * exposes raw tokens or scraped credentials.
   */
  createOpenCodeAuthHook(
    onAuthenticated?: () => Promise<void> | void
  ): OpenCodeAuthHook {
    return {
      provider: KIRO_PROVIDER_ID,
      loader: async (
        _auth: unknown,
        provider: string
      ): Promise<Record<string, unknown>> => {
        assertNoCredentialLeak(provider);
        return {
          managedBy: "kiro-cli",
          provider: KIRO_PROVIDER_ID,
          protocol: "acp",
        };
      },
      methods: [
        {
          type: "cli",
          label: "Kiro CLI Login (kiro-cli login)",
          description:
            "Authenticate natively using kiro-cli login without credential scraping",
          authorize: async () => {
            return {
              method: "cli",
              instructions:
                "Authenticate via `kiro-cli login`. Credentials remain managed exclusively by kiro-cli.",
              callback: async () => {
                const loginResult = await this.login();
                if (loginResult.ok && onAuthenticated) {
                  await onAuthenticated();
                }
                return {
                  ok: loginResult.ok,
                  authenticated: loginResult.status.authenticated,
                  managedBy: "kiro-cli",
                  accountLabel: loginResult.status.accountLabel,
                  authMethod: loginResult.status.authMethod,
                };
              },
            };
          },
        },
      ],
    };
  }
}
