/**
 * Process lifecycle supervisor for spawning and managing `kiro-cli acp`.
 *
 * Security guarantees:
 * - Always invokes `child_process.spawn` with `shell: false` and explicit argv arrays.
 * - Never interpolates command strings or reads credential files.
 * - Captures stderr into a bounded ring buffer for diagnostics.
 * - Ensures clean SIGTERM -> timeout -> SIGKILL shutdown with no zombie processes.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface KiroSupervisorOptions {
  /** Binary name or script path (defaults to "kiro-cli") */
  cliPath?: string;
  /** Extra CLI args inserted before `"acp"` */
  acpArgs?: string[];
  /** Working directory for the spawned process */
  cwd?: string;
  /** Optional environment overrides (merged onto process.env) */
  env?: NodeJS.ProcessEnv;
  /** Maximum number of stderr lines kept in the ring buffer (default: 100) */
  maxStderrLines?: number;
  /** Maximum characters buffered per stderr line before truncation (default: 64 KiB) */
  maxStderrLineBytes?: number;
  /** Default graceful shutdown timeout before SIGKILL in ms (default: 3000) */
  gracefulShutdownMs?: number;
}

export interface ProcessExitEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const SCRIPT_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"] as const;

function isScriptPath(cliPath: string): boolean {
  const lower = cliPath.toLowerCase();
  return SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export class KiroProcessSupervisor {
  private readonly cliPath: string;
  private readonly acpArgs: readonly string[];
  private readonly cwd?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly maxStderrLines: number;
  private readonly maxStderrLineBytes: number;
  private readonly gracefulShutdownMs: number;

  private child: ChildProcess | null = null;
  private running = false;
  private stopping = false;
  private stderrBuffer: string[] = [];
  private stderrRemainder = "";
  private stderrTruncatingLine = false;
  private readonly stderrDecoder = new TextDecoder("utf-8");

  private readonly stdoutListeners = new Set<(chunk: Buffer) => void>();
  private readonly stderrListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(event: ProcessExitEvent) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  constructor(options: KiroSupervisorOptions = {}) {
    this.cliPath = options.cliPath ?? "kiro-cli";
    this.acpArgs = options.acpArgs ? [...options.acpArgs] : [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.maxStderrLines = Math.max(1, options.maxStderrLines ?? 100);
    this.maxStderrLineBytes = Math.max(256, options.maxStderrLineBytes ?? 64 * 1024);
    this.gracefulShutdownMs = Math.max(50, options.gracefulShutdownMs ?? 3_000);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  isRunning(): boolean {
    return this.running && this.child !== null && !this.child.killed;
  }

  /**
   * Returns a snapshot of the bounded stderr ring buffer (oldest to newest).
   */
  getStderrLines(): string[] {
    return [...this.stderrBuffer];
  }

  /**
   * Returns the last `count` stderr lines joined by newline.
   */
  getStderrTail(count = 20): string {
    if (this.stderrBuffer.length === 0) {
      return "";
    }
    return this.stderrBuffer.slice(-Math.max(1, count)).join("\n");
  }

  onStdout(listener: (chunk: Buffer) => void): () => void {
    this.stdoutListeners.add(listener);
    return () => {
      this.stdoutListeners.delete(listener);
    };
  }

  onStderr(listener: (line: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => {
      this.stderrListeners.delete(listener);
    };
  }

  onExit(listener: (event: ProcessExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /**
   * Spawns the `kiro-cli acp` subprocess (or script via `process.execPath` for
   * `.ts`/`.js` test servers). Idempotent if already running.
   */
  start(): void {
    if (this.isRunning()) {
      return;
    }

    this.stopping = false;
    this.stderrBuffer = [];
    this.stderrRemainder = "";
    this.stderrTruncatingLine = false;
    this.stderrDecoder.decode();

    const { command, args } = this.resolveSpawnCommand();

    const proc = spawn(command, args, {
      cwd: this.cwd,
      env: this.env ? { ...process.env, ...this.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    this.child = proc;
    this.running = true;

    proc.stdout?.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf-8");
      for (const listener of this.stdoutListeners) {
        listener(buf);
      }
    });

    proc.stderr?.on("data", (chunk: Buffer | string) => {
      const text =
        typeof chunk === "string"
          ? chunk
          : this.stderrDecoder.decode(chunk, { stream: true });
      this.ingestStderr(text);
    });

    proc.stdin?.on("error", (err: Error) => {
      // Suppress EPIPE during shutdown; forward unexpected errors.
      if (!this.stopping) {
        this.emitError(err);
      }
    });

    proc.on("error", (err: Error) => {
      if (this.child === proc) {
        this.running = false;
        this.child = null;
      }
      this.emitError(err);
    });

    // Listen to "close" rather than "exit" so stdout/stderr stdio streams have
    // finished flushing before we flush stderrRemainder and notify exit listeners.
    proc.on("close", (code, signal) => {
      this.flushStderrRemainder();
      if (this.child === proc) {
        this.running = false;
        this.child = null;
      }
      const event: ProcessExitEvent = { code, signal };
      for (const listener of this.exitListeners) {
        listener(event);
      }
    });
  }

  /**
   * Writes a UTF-8 frame to the child process stdin.
   * Throws if the process is not running or stdin is unavailable.
   */
  write(data: string): boolean {
    if (!this.isRunning() || !this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error("Kiro ACP process is not running");
    }
    return this.child.stdin.write(data, "utf-8");
  }

  /**
   * Stops the child process cleanly:
   * 1. Closes stdin and sends SIGTERM.
   * 2. Waits up to `gracefulTimeoutMs` for clean exit.
   * 3. Escalates to SIGKILL if the process is still alive.
   */
  async stop(gracefulTimeoutMs = this.gracefulShutdownMs): Promise<void> {
    const proc = this.child;
    if (!proc) {
      this.running = false;
      return;
    }

    this.stopping = true;

    if (
      proc.pid === undefined ||
      proc.exitCode !== null ||
      proc.signalCode !== null
    ) {
      this.running = false;
      if (this.child === proc) {
        this.child = null;
      }
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (killTimer !== undefined) {
          clearTimeout(killTimer);
        }
        if (hardTimer !== undefined) {
          clearTimeout(hardTimer);
        }
        proc.removeListener("exit", onExit);
        proc.removeListener("close", onExit);
        proc.removeListener("error", onExit);
        this.running = false;
        if (this.child === proc) {
          this.child = null;
        }
        resolve();
      };

      const onExit = (): void => {
        finish();
      };

      proc.once("exit", onExit);
      proc.once("close", onExit);
      proc.once("error", onExit);

      try {
        if (proc.stdin && !proc.stdin.destroyed) {
          proc.stdin.end();
        }
      } catch {
        // Ignore stdin close errors during teardown
      }

      try {
        const signaled = proc.kill("SIGTERM");
        if (!signaled) {
          finish();
          return;
        }
      } catch {
        finish();
        return;
      }

      killTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        try {
          proc.kill("SIGKILL");
        } catch {
          finish();
          return;
        }
        // Safety net in case the OS never emits exit after SIGKILL
        hardTimer = setTimeout(finish, 1_000);
        if (typeof hardTimer.unref === "function") {
          hardTimer.unref();
        }
      }, Math.max(20, gracefulTimeoutMs));

      if (typeof killTimer.unref === "function") {
        killTimer.unref();
      }
    });
  }

  /**
   * Stops any running instance and starts a fresh process.
   */
  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }

  private resolveSpawnCommand(): { command: string; args: string[] } {
    if (isScriptPath(this.cliPath)) {
      return {
        command: process.execPath,
        args: [this.cliPath, ...this.acpArgs, "acp"],
      };
    }
    return {
      command: this.cliPath,
      args: [...this.acpArgs, "acp"],
    };
  }

  private ingestStderr(text: string): void {
    if (text.length === 0) {
      return;
    }

    let remaining = text;
    if (this.stderrTruncatingLine) {
      const nlIdx = remaining.indexOf("\n");
      if (nlIdx === -1) {
        return;
      }
      this.stderrTruncatingLine = false;
      remaining = remaining.slice(nlIdx + 1);
      if (remaining.length === 0) {
        return;
      }
    }

    this.stderrRemainder += remaining;
    let idx = this.stderrRemainder.indexOf("\n");
    while (idx !== -1) {
      const rawLine = this.stderrRemainder.slice(0, idx);
      this.stderrRemainder = this.stderrRemainder.slice(idx + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      this.pushStderrLine(
        line.length > this.maxStderrLineBytes
          ? `${line.slice(0, this.maxStderrLineBytes)}... [truncated]`
          : line
      );
      idx = this.stderrRemainder.indexOf("\n");
    }

    if (this.stderrRemainder.length > this.maxStderrLineBytes) {
      const truncated = `${this.stderrRemainder.slice(0, this.maxStderrLineBytes)}... [truncated]`;
      this.stderrRemainder = "";
      this.stderrTruncatingLine = true;
      this.pushStderrLine(truncated);
    }
  }

  private flushStderrRemainder(): void {
    const tail = this.stderrDecoder.decode();
    if (tail.length > 0) {
      this.stderrRemainder += tail;
    }
    if (this.stderrRemainder.length > 0) {
      const line = this.stderrRemainder.endsWith("\r")
        ? this.stderrRemainder.slice(0, -1)
        : this.stderrRemainder;
      this.stderrRemainder = "";
      this.pushStderrLine(line);
    }
  }

  private pushStderrLine(line: string): void {
    if (line.length === 0) {
      return;
    }
    this.stderrBuffer.push(line);
    if (this.stderrBuffer.length > this.maxStderrLines) {
      this.stderrBuffer.shift();
    }
    for (const listener of this.stderrListeners) {
      listener(line);
    }
  }

  private emitError(err: Error): void {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }
}
