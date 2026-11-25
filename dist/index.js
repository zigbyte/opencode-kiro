// src/acp/jsonrpc.ts
var JSON_RPC_METHOD_NOT_FOUND = -32601;
var JSON_RPC_INTERNAL_ERROR = -32603;

class JsonRpcResponseError extends Error {
  code;
  data;
  constructor(error) {
    super(error.message);
    this.name = "JsonRpcResponseError";
    this.code = error.code;
    this.data = error.data;
  }
}

class JsonRpcTimeoutError extends Error {
  method;
  timeoutMs;
  constructor(method, timeoutMs) {
    super(`JSON-RPC request "${method}" timed out after ${timeoutMs}ms`);
    this.name = "JsonRpcTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

class JsonRpcAbortedError extends Error {
  method;
  constructor(method, reason) {
    const detail = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "aborted";
    super(`JSON-RPC request "${method}" was aborted: ${detail}`);
    this.name = "JsonRpcAbortedError";
    this.method = method;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isJsonRpcRequest(msg) {
  return "method" in msg && typeof msg.method === "string" && "id" in msg && (typeof msg.id === "string" || typeof msg.id === "number");
}
function isJsonRpcNotification(msg) {
  return "method" in msg && typeof msg.method === "string" && !(("id" in msg) && msg.id !== undefined);
}
function isJsonRpcResponse(msg) {
  return !("method" in msg) && "id" in msg && (("result" in msg) || ("error" in msg));
}
function serializeJsonRpc(msg) {
  return `${JSON.stringify(msg)}
`;
}
var DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

class JsonRpcLineBuffer {
  decoder = new TextDecoder("utf-8");
  onMessage;
  onParseError;
  maxLineBytes;
  remainder = "";
  discardingOversizedLine = false;
  constructor(options) {
    this.onMessage = options.onMessage;
    this.onParseError = options.onParseError;
    this.maxLineBytes = Math.max(1024, options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);
  }
  push(chunk) {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    if (text.length === 0) {
      return;
    }
    if (this.discardingOversizedLine) {
      const newlineIdx = text.indexOf(`
`);
      if (newlineIdx === -1) {
        return;
      }
      this.discardingOversizedLine = false;
      this.remainder = text.slice(newlineIdx + 1);
    } else {
      this.remainder += text;
    }
    this.drainLines();
    if (!this.discardingOversizedLine && this.remainder.length > this.maxLineBytes) {
      const preview = this.remainder.slice(0, 256);
      this.remainder = "";
      this.discardingOversizedLine = true;
      this.safeParseError(new Error(`JSON-RPC line exceeded maximum size of ${this.maxLineBytes} bytes`), preview);
    }
  }
  flush() {
    const tail = this.decoder.decode();
    if (tail.length > 0 && !this.discardingOversizedLine) {
      this.remainder += tail;
    }
    this.drainLines();
    if (!this.discardingOversizedLine && this.remainder.length > 0) {
      const last = this.remainder;
      this.remainder = "";
      this.processLine(last);
    }
    this.discardingOversizedLine = false;
  }
  reset() {
    this.remainder = "";
    this.discardingOversizedLine = false;
    this.decoder.decode();
  }
  drainLines() {
    let newlineIdx = this.remainder.indexOf(`
`);
    while (newlineIdx !== -1) {
      const rawLine = this.remainder.slice(0, newlineIdx);
      this.remainder = this.remainder.slice(newlineIdx + 1);
      if (this.discardingOversizedLine) {
        this.discardingOversizedLine = false;
      } else {
        this.processLine(rawLine);
      }
      newlineIdx = this.remainder.indexOf(`
`);
    }
  }
  processLine(rawLine) {
    if (rawLine.length > this.maxLineBytes) {
      this.safeParseError(new Error(`JSON-RPC line exceeded maximum size of ${this.maxLineBytes} bytes`), rawLine.slice(0, 256));
      return;
    }
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const parseErr = err instanceof Error ? err : new Error(`Failed to parse JSON: ${String(err)}`);
      this.safeParseError(parseErr, trimmed);
      return;
    }
    if (!isRecord(parsed) || parsed["jsonrpc"] !== "2.0") {
      this.safeParseError(new Error('Invalid JSON-RPC 2.0 frame: expected object with jsonrpc="2.0"'), trimmed);
      return;
    }
    const hasMethod = typeof parsed["method"] === "string";
    const hasId = "id" in parsed;
    const hasResultOrError = "result" in parsed || "error" in parsed;
    if (!hasMethod && !(hasId && hasResultOrError)) {
      this.safeParseError(new Error("Invalid JSON-RPC 2.0 frame: missing method or response payload"), trimmed);
      return;
    }
    try {
      this.onMessage(parsed);
    } catch (err) {
      const handlerErr = err instanceof Error ? err : new Error(`Message handler threw: ${String(err)}`);
      this.safeParseError(handlerErr, trimmed);
    }
  }
  safeParseError(error, rawLine) {
    try {
      this.onParseError?.(error, rawLine);
    } catch {}
  }
}

class JsonRpcDispatcher {
  nextRequestId = 1;
  defaultTimeoutMs;
  pending = new Map;
  constructor(options = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60000;
  }
  get pendingCount() {
    return this.pending.size;
  }
  nextId() {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return id;
  }
  sendRequest(send, method, params, options = {}) {
    const { signal } = options;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (signal?.aborted) {
      return Promise.reject(new JsonRpcAbortedError(method, signal.reason));
    }
    const id = this.nextId();
    const request = params !== undefined ? { jsonrpc: "2.0", id, method, params } : { jsonrpc: "2.0", id, method };
    return new Promise((resolve, reject) => {
      const entry = {
        method,
        resolve,
        reject
      };
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        entry.timer = setTimeout(() => {
          const current = this.takePending(id);
          if (current) {
            current.reject(new JsonRpcTimeoutError(method, timeoutMs));
          }
        }, timeoutMs);
      }
      if (signal) {
        const onAbort = () => {
          const current = this.takePending(id);
          if (current) {
            current.reject(new JsonRpcAbortedError(method, signal.reason));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanupAbort = () => {
          signal.removeEventListener("abort", onAbort);
        };
      }
      this.pending.set(id, entry);
      try {
        send(request);
      } catch (err) {
        const current = this.takePending(id);
        if (current) {
          current.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }
  handleResponse(response) {
    if (response.id === null || response.id === undefined) {
      return false;
    }
    const entry = this.takePending(response.id);
    if (!entry) {
      return false;
    }
    if ("error" in response && response.error !== undefined && response.error !== null) {
      const rawErr = response.error;
      if (isRecord(rawErr) && typeof rawErr["code"] === "number" && typeof rawErr["message"] === "string") {
        entry.reject(new JsonRpcResponseError({
          code: rawErr["code"],
          message: rawErr["message"],
          data: rawErr["data"]
        }));
      } else {
        entry.reject(new JsonRpcResponseError({
          code: JSON_RPC_INTERNAL_ERROR,
          message: `Malformed JSON-RPC error payload: ${String(rawErr)}`,
          data: rawErr
        }));
      }
    } else {
      entry.resolve(response.result);
    }
    return true;
  }
  rejectAll(error) {
    const entries = Array.from(this.pending.entries());
    this.pending.clear();
    for (const [, entry] of entries) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
      }
      entry.cleanupAbort?.();
      entry.reject(error);
    }
  }
  takePending(id) {
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    this.pending.delete(id);
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    entry.cleanupAbort?.();
    return entry;
  }
}
// src/acp/supervisor.ts
import { spawn } from "node:child_process";
var SCRIPT_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"];
function isScriptPath(cliPath) {
  const lower = cliPath.toLowerCase();
  return SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

class KiroProcessSupervisor {
  cliPath;
  acpArgs;
  cwd;
  env;
  maxStderrLines;
  maxStderrLineBytes;
  gracefulShutdownMs;
  child = null;
  running = false;
  stopping = false;
  stderrBuffer = [];
  stderrRemainder = "";
  stderrTruncatingLine = false;
  stderrDecoder = new TextDecoder("utf-8");
  stdoutListeners = new Set;
  stderrListeners = new Set;
  exitListeners = new Set;
  errorListeners = new Set;
  constructor(options = {}) {
    this.cliPath = options.cliPath ?? "kiro-cli";
    this.acpArgs = options.acpArgs ? [...options.acpArgs] : [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.maxStderrLines = Math.max(1, options.maxStderrLines ?? 100);
    this.maxStderrLineBytes = Math.max(256, options.maxStderrLineBytes ?? 64 * 1024);
    this.gracefulShutdownMs = Math.max(50, options.gracefulShutdownMs ?? 3000);
  }
  get pid() {
    return this.child?.pid;
  }
  isRunning() {
    return this.running && this.child !== null && !this.child.killed;
  }
  getStderrLines() {
    return [...this.stderrBuffer];
  }
  getStderrTail(count = 20) {
    if (this.stderrBuffer.length === 0) {
      return "";
    }
    return this.stderrBuffer.slice(-Math.max(1, count)).join(`
`);
  }
  onStdout(listener) {
    this.stdoutListeners.add(listener);
    return () => {
      this.stdoutListeners.delete(listener);
    };
  }
  onStderr(listener) {
    this.stderrListeners.add(listener);
    return () => {
      this.stderrListeners.delete(listener);
    };
  }
  onExit(listener) {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }
  onError(listener) {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }
  start() {
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
      windowsHide: true
    });
    this.child = proc;
    this.running = true;
    proc.stdout?.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf-8");
      for (const listener of this.stdoutListeners) {
        listener(buf);
      }
    });
    proc.stderr?.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : this.stderrDecoder.decode(chunk, { stream: true });
      this.ingestStderr(text);
    });
    proc.stdin?.on("error", (err) => {
      if (!this.stopping) {
        this.emitError(err);
      }
    });
    proc.on("error", (err) => {
      if (this.child === proc) {
        this.running = false;
        this.child = null;
      }
      this.emitError(err);
    });
    proc.on("close", (code, signal) => {
      this.flushStderrRemainder();
      if (this.child === proc) {
        this.running = false;
        this.child = null;
      }
      const event = { code, signal };
      for (const listener of this.exitListeners) {
        listener(event);
      }
    });
  }
  write(data) {
    if (!this.isRunning() || !this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error("Kiro ACP process is not running");
    }
    return this.child.stdin.write(data, "utf-8");
  }
  async stop(gracefulTimeoutMs = this.gracefulShutdownMs) {
    const proc = this.child;
    if (!proc) {
      this.running = false;
      return;
    }
    this.stopping = true;
    if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) {
      this.running = false;
      if (this.child === proc) {
        this.child = null;
      }
      return;
    }
    await new Promise((resolve) => {
      let settled = false;
      let killTimer;
      let hardTimer;
      const finish = () => {
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
      const onExit = () => {
        finish();
      };
      proc.once("exit", onExit);
      proc.once("close", onExit);
      proc.once("error", onExit);
      try {
        if (proc.stdin && !proc.stdin.destroyed) {
          proc.stdin.end();
        }
      } catch {}
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
        hardTimer = setTimeout(finish, 1000);
        if (typeof hardTimer.unref === "function") {
          hardTimer.unref();
        }
      }, Math.max(20, gracefulTimeoutMs));
      if (typeof killTimer.unref === "function") {
        killTimer.unref();
      }
    });
  }
  async restart() {
    await this.stop();
    this.start();
  }
  resolveSpawnCommand() {
    if (isScriptPath(this.cliPath)) {
      return {
        command: process.execPath,
        args: [this.cliPath, ...this.acpArgs, "acp"]
      };
    }
    return {
      command: this.cliPath,
      args: [...this.acpArgs, "acp"]
    };
  }
  ingestStderr(text) {
    if (text.length === 0) {
      return;
    }
    let remaining = text;
    if (this.stderrTruncatingLine) {
      const nlIdx = remaining.indexOf(`
`);
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
    let idx = this.stderrRemainder.indexOf(`
`);
    while (idx !== -1) {
      const rawLine = this.stderrRemainder.slice(0, idx);
      this.stderrRemainder = this.stderrRemainder.slice(idx + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      this.pushStderrLine(line.length > this.maxStderrLineBytes ? `${line.slice(0, this.maxStderrLineBytes)}... [truncated]` : line);
      idx = this.stderrRemainder.indexOf(`
`);
    }
    if (this.stderrRemainder.length > this.maxStderrLineBytes) {
      const truncated = `${this.stderrRemainder.slice(0, this.maxStderrLineBytes)}... [truncated]`;
      this.stderrRemainder = "";
      this.stderrTruncatingLine = true;
      this.pushStderrLine(truncated);
    }
  }
  flushStderrRemainder() {
    const tail = this.stderrDecoder.decode();
    if (tail.length > 0) {
      this.stderrRemainder += tail;
    }
    if (this.stderrRemainder.length > 0) {
      const line = this.stderrRemainder.endsWith("\r") ? this.stderrRemainder.slice(0, -1) : this.stderrRemainder;
      this.stderrRemainder = "";
      this.pushStderrLine(line);
    }
  }
  pushStderrLine(line) {
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
  emitError(err) {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }
}
// src/types.ts
var KIRO_PROVIDER_ID = "kiro";
var PLUGIN_ID = "opencode-kiro";
var ACP_PROTOCOL_VERSION = 1;

// src/acp/client.ts
class AcpTransportError extends Error {
  code;
  data;
  stderr;
  constructor(message, options) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AcpTransportError";
    this.code = options?.code;
    this.data = options?.data;
    this.stderr = options?.stderr;
  }
}

class AcpAuthRequiredError extends AcpTransportError {
  authMethods;
  constructor(message, options) {
    super(message, options);
    this.name = "AcpAuthRequiredError";
    this.authMethods = options?.authMethods ?? [];
  }
}
var AUTH_ERROR_CODES = new Set([-32001, -32002, 401]);
var AUTH_ERROR_PATTERN = /\b(auth|unauthenticated|unauthorized|not logged in|login required|authentication required|credentials?)\b/i;
var READ_ONLY_TOOL_KINDS = new Set([
  "read",
  "search",
  "fetch",
  "list",
  "grep",
  "glob",
  "view",
  "find",
  "think"
]);
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isAuthError(error) {
  return AUTH_ERROR_CODES.has(error.code) || AUTH_ERROR_PATTERN.test(error.message);
}
function selectOptionByKind(options, kinds) {
  for (const kind of kinds) {
    const match = options.find((opt) => opt !== null && typeof opt === "object" && opt.kind === kind && typeof opt.optionId === "string" && opt.optionId.length > 0);
    if (match) {
      return { outcome: { outcome: "selected", optionId: match.optionId } };
    }
  }
  return null;
}
function evaluatePermissionPolicy(policy, params) {
  const options = Array.isArray(params.options) ? params.options : [];
  if (policy === "allow_once") {
    const allow = selectOptionByKind(options, ["allow_once"]);
    if (allow) {
      return allow;
    }
  } else if (policy === "allow_read_only") {
    const kind = params.toolCall?.kind?.toLowerCase().trim();
    if (kind && READ_ONLY_TOOL_KINDS.has(kind)) {
      const allow = selectOptionByKind(options, ["allow_once"]);
      if (allow) {
        return allow;
      }
    }
  }
  const deny = selectOptionByKind(options, ["reject_once", "reject_always"]);
  return deny ?? { outcome: { outcome: "cancelled" } };
}

class AcpClient {
  options;
  supervisor;
  dispatcher;
  lineBuffer;
  initializeResult = null;
  connected = false;
  disposed = false;
  connectPromise = null;
  supervisorUnsubs = [];
  sessionUpdateListeners = new Map;
  metadataListeners = new Set;
  parseErrorListeners = new Set;
  constructor(options = {}) {
    this.options = options;
    this.supervisor = new KiroProcessSupervisor({
      cliPath: options.cliPath,
      acpArgs: options.acpArgs,
      cwd: options.cwd
    });
    this.dispatcher = new JsonRpcDispatcher({
      defaultTimeoutMs: options.requestTimeoutMs ?? 60000
    });
    this.lineBuffer = new JsonRpcLineBuffer({
      onMessage: (msg) => this.handleMessage(msg),
      onParseError: (err, rawLine) => {
        for (const listener of this.parseErrorListeners) {
          listener(err, rawLine);
        }
      }
    });
    this.attachSupervisorListeners();
  }
  async connect() {
    if (this.disposed) {
      throw new AcpTransportError("AcpClient has been disposed");
    }
    if (this.connected && this.initializeResult) {
      return this.initializeResult;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    const promise = this.performConnect();
    this.connectPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.connectPromise === promise) {
        this.connectPromise = null;
      }
    }
  }
  isConnected() {
    return this.connected && this.supervisor.isRunning();
  }
  getInitializeResult() {
    return this.initializeResult;
  }
  getStderrTail(lines = 20) {
    return this.supervisor.getStderrTail(lines);
  }
  onMetadata(listener) {
    this.metadataListeners.add(listener);
    return () => {
      this.metadataListeners.delete(listener);
    };
  }
  onParseError(listener) {
    this.parseErrorListeners.add(listener);
    return () => {
      this.parseErrorListeners.delete(listener);
    };
  }
  async authenticate(methodId) {
    await this.ensureConnected();
    const params = methodId ? { methodId } : {};
    try {
      return await this.request("authenticate", params);
    } catch (err) {
      if (err instanceof JsonRpcResponseError && isAuthError(err)) {
        throw new AcpAuthRequiredError(err.message, {
          code: err.code,
          data: err.data,
          stderr: this.supervisor.getStderrTail(),
          authMethods: this.initializeResult?.authMethods,
          cause: err
        });
      }
      throw this.wrapError(err, "authenticate");
    }
  }
  async newSession(cwd, mcpServers) {
    await this.ensureConnected();
    const params = {
      cwd: cwd ?? this.options.cwd ?? process.cwd(),
      mcpServers: mcpServers ?? []
    };
    try {
      return await this.request("session/new", params);
    } catch (err) {
      if (err instanceof JsonRpcResponseError && isAuthError(err)) {
        throw new AcpAuthRequiredError(err.message, {
          code: err.code,
          data: err.data,
          stderr: this.supervisor.getStderrTail(),
          authMethods: this.initializeResult?.authMethods,
          cause: err
        });
      }
      throw this.wrapError(err, "session/new");
    }
  }
  async setModel(sessionId, modelId) {
    await this.ensureConnected();
    try {
      await this.request("session/set_model", { sessionId, modelId });
    } catch (err) {
      if (err instanceof JsonRpcResponseError && err.code === JSON_RPC_METHOD_NOT_FOUND) {
        try {
          await this.request("session/set_config_option", {
            sessionId,
            configId: "model",
            value: modelId
          });
          return;
        } catch (fallbackErr) {
          throw this.wrapError(fallbackErr, "session/set_config_option");
        }
      }
      throw this.wrapError(err, "session/set_model");
    }
  }
  async prompt(sessionId, blocks, options = {}) {
    await this.ensureConnected();
    const { signal, onUpdate, timeoutMs } = options;
    let unsubUpdate;
    if (onUpdate) {
      unsubUpdate = this.subscribeSessionUpdates(sessionId, onUpdate);
    }
    const onAbort = () => {
      this.cancel(sessionId).catch(() => {});
    };
    if (signal) {
      if (signal.aborted) {
        unsubUpdate?.();
        throw new AcpTransportError(`Prompt for session "${sessionId}" was aborted`);
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const params = {
      sessionId,
      prompt: blocks
    };
    try {
      return await this.request("session/prompt", params, { signal, timeoutMs });
    } catch (err) {
      throw this.wrapError(err, "session/prompt");
    } finally {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      unsubUpdate?.();
    }
  }
  async cancel(sessionId) {
    if (!this.isConnected()) {
      return;
    }
    this.sendNotification("session/cancel", { sessionId });
  }
  async getUsage() {
    await this.ensureConnected();
    try {
      const result = await this.request("_kiro/account/getUsage", {});
      return result ?? null;
    } catch (err) {
      if (err instanceof JsonRpcResponseError && err.code === JSON_RPC_METHOD_NOT_FOUND) {
        return null;
      }
      throw this.wrapError(err, "_kiro/account/getUsage");
    }
  }
  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.connected = false;
    this.initializeResult = null;
    this.connectPromise = null;
    this.dispatcher.rejectAll(new AcpTransportError("AcpClient disposed"));
    this.sessionUpdateListeners.clear();
    this.metadataListeners.clear();
    this.parseErrorListeners.clear();
    for (const unsub of this.supervisorUnsubs) {
      unsub();
    }
    this.supervisorUnsubs.length = 0;
    this.lineBuffer.reset();
    await this.supervisor.stop();
  }
  attachSupervisorListeners() {
    this.supervisorUnsubs.push(this.supervisor.onStdout((chunk) => {
      this.lineBuffer.push(chunk);
    }), this.supervisor.onError((err) => {
      this.connected = false;
      this.initializeResult = null;
      this.dispatcher.rejectAll(new AcpTransportError(`Kiro ACP process error: ${err.message}`, {
        stderr: this.supervisor.getStderrTail(),
        cause: err
      }));
    }), this.supervisor.onExit(({ code, signal }) => {
      this.lineBuffer.flush();
      this.connected = false;
      this.initializeResult = null;
      if (!this.disposed) {
        this.dispatcher.rejectAll(new AcpTransportError(`Kiro ACP process exited unexpectedly (code=${String(code)}, signal=${String(signal)})`, { stderr: this.supervisor.getStderrTail() }));
      }
    }));
  }
  async performConnect() {
    this.lineBuffer.reset();
    this.supervisor.start();
    const params = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      clientInfo: {
        name: PLUGIN_ID,
        version: "1.0.0"
      }
    };
    try {
      const result = await this.request("initialize", params);
      if (this.disposed) {
        await this.supervisor.stop();
        throw new AcpTransportError("AcpClient disposed during connect");
      }
      this.initializeResult = result;
      this.connected = true;
      return result;
    } catch (err) {
      this.connected = false;
      this.initializeResult = null;
      await this.supervisor.stop();
      throw this.wrapError(err, "initialize");
    }
  }
  async ensureConnected() {
    if (!this.isConnected()) {
      await this.connect();
    }
  }
  request(method, params, options) {
    return this.dispatcher.sendRequest((req) => this.writeMessage(req), method, params, options);
  }
  sendNotification(method, params) {
    const notification = params !== undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method };
    this.writeMessage(notification);
  }
  sendResponse(response) {
    if (!this.supervisor.isRunning()) {
      return;
    }
    this.writeMessage(response);
  }
  writeMessage(msg) {
    const frame = serializeJsonRpc(msg);
    try {
      this.supervisor.write(frame);
    } catch (err) {
      throw new AcpTransportError(`Failed to write JSON-RPC frame: ${err instanceof Error ? err.message : String(err)}`, {
        stderr: this.supervisor.getStderrTail(),
        cause: err
      });
    }
  }
  handleMessage(msg) {
    if (isJsonRpcResponse(msg)) {
      this.dispatcher.handleResponse(msg);
      return;
    }
    if (isJsonRpcRequest(msg)) {
      this.handleInboundRequest(msg);
      return;
    }
    if (isJsonRpcNotification(msg)) {
      this.handleInboundNotification(msg);
    }
  }
  handleInboundNotification(notification) {
    const { method, params } = notification;
    if (method === "session/update" && isRecord2(params)) {
      const sessionId = params["sessionId"];
      const update = params["update"];
      if (typeof sessionId === "string" && isRecord2(update)) {
        const updateParams = params;
        const listeners = this.sessionUpdateListeners.get(sessionId);
        if (listeners) {
          for (const listener of listeners) {
            try {
              listener(updateParams);
            } catch {}
          }
        }
      }
      return;
    }
    if (method === "_kiro.dev/metadata" && isRecord2(params)) {
      for (const listener of this.metadataListeners) {
        try {
          listener(params);
        } catch {}
      }
    }
  }
  async handleInboundRequest(request) {
    if (request.method === "session/request_permission") {
      const params = isRecord2(request.params) ? request.params : {};
      try {
        const policy = this.options.permissionPolicy ?? "deny_by_default";
        const outcome = this.options.onPermissionRequest ? await this.options.onPermissionRequest(params) : evaluatePermissionPolicy(policy, params);
        this.safeSendResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: outcome
        });
      } catch (err) {
        this.safeSendResponse({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: JSON_RPC_INTERNAL_ERROR,
            message: err instanceof Error ? err.message : "Permission handler failed"
          }
        });
      }
      return;
    }
    this.safeSendResponse({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: JSON_RPC_METHOD_NOT_FOUND,
        message: `Unsupported client method: ${request.method}`
      }
    });
  }
  safeSendResponse(response) {
    try {
      this.sendResponse(response);
    } catch {}
  }
  subscribeSessionUpdates(sessionId, listener) {
    let set = this.sessionUpdateListeners.get(sessionId);
    if (!set) {
      set = new Set;
      this.sessionUpdateListeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      const current = this.sessionUpdateListeners.get(sessionId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.sessionUpdateListeners.delete(sessionId);
      }
    };
  }
  wrapError(err, method) {
    if (err instanceof AcpTransportError) {
      return err;
    }
    if (err instanceof JsonRpcResponseError) {
      return new AcpTransportError(`ACP "${method}" failed (${err.code}): ${err.message}`, {
        code: err.code,
        data: err.data,
        stderr: this.supervisor.getStderrTail(),
        cause: err
      });
    }
    if (err instanceof Error) {
      return new AcpTransportError(err.message, {
        stderr: this.supervisor.getStderrTail(),
        cause: err
      });
    }
    return new AcpTransportError(`ACP "${method}" failed: ${String(err)}`, {
      stderr: this.supervisor.getStderrTail()
    });
  }
}
// src/auth/kiro-auth.ts
import { spawn as spawn2 } from "node:child_process";
var DEFAULT_CLI_PATH = "kiro-cli";
var DEFAULT_WHOAMI_TIMEOUT_MS = 15000;
var DEFAULT_LOGIN_TIMEOUT_MS = 120000;
var SIGKILL_GRACE_MS = 500;
var MAX_OUTPUT_BYTES = 1024 * 1024;
var ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
var CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;
function validateCliPath(cliPath) {
  if (typeof cliPath !== "string" || cliPath.trim().length === 0) {
    throw new Error("Invalid kiro-cli path: path must be a non-empty string.");
  }
  if (CONTROL_CHAR_RE.test(cliPath)) {
    throw new Error("Invalid kiro-cli path: path must not contain null bytes or control characters.");
  }
  if (cliPath.trim().startsWith("-")) {
    throw new Error("Invalid kiro-cli path: path must not start with '-' (flag injection rejected).");
  }
  return cliPath;
}
function spawnKiroCli(cliPath, args, opts = {}) {
  const validatedPath = validateCliPath(cliPath);
  const isScriptFixture = validatedPath.endsWith(".ts") || validatedPath.endsWith(".js");
  const command = isScriptFixture ? process.execPath : validatedPath;
  const spawnArgs = isScriptFixture ? [validatedPath, ...args] : [...args];
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let timer;
    let killTimer;
    const finish = (result) => {
      if (settled)
        return;
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
      child = spawn2(command, spawnArgs, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      finish({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnFailed: true,
        error: err instanceof Error ? err.message : String(err)
      });
      return;
    }
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {}
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, SIGKILL_GRACE_MS);
      }, opts.timeoutMs);
    }
    child.stdout?.on("data", (chunk) => {
      if (stdoutBytes >= MAX_OUTPUT_BYTES)
        return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      stdout += slice.toString("utf8");
      stdoutBytes += slice.length;
    });
    child.stderr?.on("data", (chunk) => {
      if (stderrBytes >= MAX_OUTPUT_BYTES)
        return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const remaining = MAX_OUTPUT_BYTES - stderrBytes;
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      stderr += slice.toString("utf8");
      stderrBytes += slice.length;
    });
    child.on("error", (err) => {
      finish({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        spawnFailed: true,
        error: err.message
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
        error: timedOut ? `kiro-cli command timed out after ${opts.timeoutMs}ms` : undefined
      });
    });
  });
}
function assertNoCredentialLeak(providerId) {
  if (providerId !== KIRO_PROVIDER_ID) {
    throw new Error(`Kiro credential isolation violation: Kiro auth cannot be loaded for provider "${providerId}". ` + `Kiro authentication is strictly restricted to provider "${KIRO_PROVIDER_ID}".`);
  }
}
function stripAnsi(input) {
  return input.replace(ANSI_ESCAPE_RE, "");
}
function parseWhoamiOutput(raw) {
  const cleaned = stripAnsi(raw).trim();
  if (!cleaned) {
    return { authenticated: true, accountLabel: null, authMethod: null };
  }
  if (cleaned.startsWith("{")) {
    try {
      const parsed = JSON.parse(cleaned);
      const explicitAuth = typeof parsed.authenticated === "boolean" ? parsed.authenticated : typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : true;
      const labelCandidate = parsed.accountLabel ?? parsed.email ?? parsed.username ?? parsed.user ?? parsed.account ?? parsed.profile;
      const methodCandidate = parsed.authMethod ?? parsed.identityProvider ?? parsed.method ?? parsed.provider ?? parsed.type;
      return {
        authenticated: explicitAuth,
        accountLabel: typeof labelCandidate === "string" && labelCandidate.trim().length > 0 ? labelCandidate.trim() : null,
        authMethod: typeof methodCandidate === "string" && methodCandidate.trim().length > 0 ? methodCandidate.trim() : null
      };
    } catch {}
  }
  const lower = cleaned.toLowerCase();
  if (lower.includes("not logged in") || lower.includes("not authenticated") || lower.includes("unauthenticated")) {
    return { authenticated: false, accountLabel: null, authMethod: null };
  }
  const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  let accountLabel = null;
  let authMethod = null;
  for (const line of lines) {
    const loggedInMatch = line.match(/^(?:logged\s+in\s+as\s+|(?:username|user|account|email)\s*[:\-]\s*)(.+)$/i);
    if (loggedInMatch && loggedInMatch[1]) {
      accountLabel = loggedInMatch[1].trim();
      continue;
    }
    const methodMatch = line.match(/^(?:auth\s*method|identity\s*provider|method|provider)\s*[:\-]\s*(.+)$/i);
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
    authMethod
  };
}

class KiroAuthManager {
  cliPath;
  cwd;
  requestTimeoutMs;
  constructor(options = {}) {
    this.cliPath = validateCliPath(options.cliPath ?? DEFAULT_CLI_PATH);
    this.cwd = options.cwd;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_WHOAMI_TIMEOUT_MS;
  }
  getCliPath() {
    return this.cliPath;
  }
  async getStatus(acpClient) {
    const checkedAt = new Date().toISOString();
    const acpInit = acpClient?.getInitializeResult() ?? null;
    const acpAuthMethod = acpInit?.authMethods?.[0]?.id ?? acpInit?.authMethods?.[0]?.name ?? null;
    let result = await spawnKiroCli(this.cliPath, ["whoami", "--format", "json"], {
      cwd: this.cwd,
      timeoutMs: this.requestTimeoutMs
    });
    if (!result.spawnFailed && !result.timedOut && result.exitCode !== 0 && /unexpected\s+argument|unknown\s+option|unrecognized|invalid\s+(?:option|flag).*format/i.test(result.stderr)) {
      result = await spawnKiroCli(this.cliPath, ["whoami"], {
        cwd: this.cwd,
        timeoutMs: this.requestTimeoutMs
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
        error: result.error ?? `Failed to execute ${this.cliPath}`
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
        error: result.error
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
        checkedAt
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
      error: errorOutput || "Not authenticated with Kiro CLI. Run `kiro-cli login` to sign in."
    };
  }
  async login(options) {
    const result = await spawnKiroCli(this.cliPath, ["login"], {
      cwd: this.cwd,
      timeoutMs: options?.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS
    });
    const output = stripAnsi([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join(`
`)).trim();
    if (result.spawnFailed || result.timedOut) {
      const status2 = {
        authenticated: false,
        managedBy: "kiro-cli",
        accountLabel: null,
        authMethod: null,
        cliAvailable: !result.spawnFailed,
        cliPath: this.cliPath,
        checkedAt: new Date().toISOString(),
        error: result.error ?? (result.spawnFailed ? `Failed to execute ${this.cliPath}` : "kiro-cli login timed out")
      };
      return {
        ok: false,
        status: status2,
        output: output || status2.error || ""
      };
    }
    const status = await this.getStatus();
    const ok = result.exitCode === 0 && status.authenticated;
    return {
      ok,
      status,
      output: output || result.error || ""
    };
  }
  createOpenCodeAuthHook(onAuthenticated) {
    return {
      provider: KIRO_PROVIDER_ID,
      loader: async (_auth, provider) => {
        assertNoCredentialLeak(provider);
        return {
          managedBy: "kiro-cli",
          provider: KIRO_PROVIDER_ID,
          protocol: "acp"
        };
      },
      methods: [
        {
          type: "cli",
          label: "Kiro CLI Login (kiro-cli login)",
          description: "Authenticate natively using kiro-cli login without credential scraping",
          authorize: async () => {
            return {
              method: "cli",
              instructions: "Authenticate via `kiro-cli login`. Credentials remain managed exclusively by kiro-cli.",
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
                  authMethod: loginResult.status.authMethod
                };
              }
            };
          }
        }
      ]
    };
  }
}
// src/credits/store.ts
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toNonNegativeNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed)
      return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}
function toNonEmptyString(value) {
  if (typeof value !== "string")
    return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
function clampPercent(value) {
  if (!Number.isFinite(value))
    return 0;
  if (value <= 0)
    return 0;
  if (value >= 100)
    return 100;
  return Math.round(value * 100) / 100;
}
function pickNumber(sources, keys) {
  for (const src of sources) {
    for (const key of keys) {
      if (Object.hasOwn(src, key)) {
        const parsed = toNonNegativeNumber(src[key]);
        if (parsed !== null) {
          return parsed;
        }
      }
    }
  }
  return null;
}
function hasAnyKey(sources, keys) {
  for (const src of sources) {
    for (const key of keys) {
      if (Object.hasOwn(src, key) && src[key] !== undefined) {
        return true;
      }
    }
  }
  return false;
}
function pickString(sources, keys) {
  for (const src of sources) {
    for (const key of keys) {
      if (Object.hasOwn(src, key)) {
        const parsed = toNonEmptyString(src[key]);
        if (parsed !== null) {
          return parsed;
        }
      }
    }
  }
  return null;
}
function collectSources(payload) {
  const sources = [payload];
  for (const nestedKey of ["credits", "usage", "subscription", "plan", "account", "metadata"]) {
    const nested = payload[nestedKey];
    if (isRecord3(nested)) {
      sources.push(nested);
    }
  }
  return sources;
}
function createInitialSnapshot() {
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

class KiroCreditsStore {
  snapshot;
  listeners = new Set;
  constructor(initial) {
    const base = createInitialSnapshot();
    if (!initial) {
      this.snapshot = base;
      return;
    }
    const used = toNonNegativeNumber(initial.used) ?? base.used;
    const rawLimit = toNonNegativeNumber(initial.limit);
    const limit = rawLimit !== null && rawLimit > 0 ? rawLimit : null;
    const remaining = toNonNegativeNumber(initial.remaining);
    const addonRemaining = toNonNegativeNumber(initial.addonRemaining);
    const rawPercent = toNonNegativeNumber(initial.percentUsed);
    const percentUsed = rawPercent !== null ? clampPercent(rawPercent) : limit !== null ? clampPercent(used / limit * 100) : null;
    const rawContext = toNonNegativeNumber(initial.contextUsagePercent);
    const contextUsagePercent = rawContext !== null ? clampPercent(rawContext) : null;
    const lastTurnCredits = toNonNegativeNumber(initial.lastTurnCredits);
    this.snapshot = {
      used,
      limit,
      remaining,
      addonRemaining,
      percentUsed,
      contextUsagePercent,
      lastTurnCredits,
      planName: toNonEmptyString(initial.planName),
      resetAt: toNonEmptyString(initial.resetAt),
      activeModel: toNonEmptyString(initial.activeModel),
      updatedAt: toNonEmptyString(initial.updatedAt) ?? base.updatedAt,
      source: initial.source ?? base.source
    };
  }
  getSnapshot() {
    return { ...this.snapshot };
  }
  updateFromMetadata(payload) {
    return this.applyUpdate(payload, "acp_metadata");
  }
  updateFromUsage(payload) {
    return this.applyUpdate(payload, "acp_usage");
  }
  setActiveModel(modelId) {
    const normalized = modelId ? toNonEmptyString(modelId) : null;
    this.snapshot = {
      ...this.snapshot,
      activeModel: normalized,
      updatedAt: new Date().toISOString()
    };
    this.emit();
    return this.getSnapshot();
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  clearListeners() {
    this.listeners.clear();
  }
  applyUpdate(payload, source) {
    const sources = isRecord3(payload) ? collectSources(payload) : [];
    const prev = this.snapshot;
    const rawLimitKeys = ["creditsLimit", "creditLimit", "limit", "monthlyLimit", "quota", "total"];
    const rawUsedKeys = ["creditsUsed", "creditUsed", "used", "consumed"];
    const rawRemainingKeys = ["creditsRemaining", "creditRemaining", "remaining", "available"];
    const rawAddonKeys = ["addonCreditsRemaining", "addonRemaining", "overageRemaining", "bonusRemaining"];
    const rawContextKeys = ["contextUsagePercentage", "contextUsagePercent", "contextPercent"];
    const rawLastTurnKeys = ["lastTurnCredits", "turnCredits", "deltaCredits"];
    const rawPlanKeys = ["planName", "tier", "subscriptionTier", "plan"];
    const rawResetKeys = ["resetAt", "billingResetAt", "renewsAt", "nextResetAt"];
    const rawModelKeys = ["activeModel", "currentModelId", "modelId", "model"];
    const limitProvided = hasAnyKey(sources, rawLimitKeys);
    const parsedLimit = pickNumber(sources, rawLimitKeys);
    let nextLimit;
    if (limitProvided) {
      nextLimit = parsedLimit !== null && parsedLimit > 0 ? parsedLimit : null;
    } else {
      nextLimit = prev.limit;
    }
    const parsedUsed = pickNumber(sources, rawUsedKeys);
    const parsedRemaining = pickNumber(sources, rawRemainingKeys);
    let meteredTurnCredits = null;
    for (const src of sources) {
      if (Object.hasOwn(src, "meteringUsage") && Array.isArray(src.meteringUsage)) {
        let turnSum = 0;
        let foundCreditEntry = false;
        for (const item of src.meteringUsage) {
          if (!isRecord3(item))
            continue;
          const unit = typeof item.unit === "string" ? item.unit.toLowerCase() : "";
          const unitPlural = typeof item.unitPlural === "string" ? item.unitPlural.toLowerCase() : "";
          if (unit === "credit" || unit === "credits" || unitPlural === "credits") {
            const val = toNonNegativeNumber(item.value);
            if (val !== null) {
              turnSum += val;
              foundCreditEntry = true;
            }
          }
        }
        if (foundCreditEntry) {
          meteredTurnCredits = Math.round(turnSum * 1e4) / 1e4;
          break;
        }
      }
    }
    let nextUsed = prev.used;
    if (parsedUsed !== null) {
      nextUsed = parsedUsed;
    } else if (nextLimit !== null && parsedRemaining !== null) {
      nextUsed = Math.max(0, Math.round((nextLimit - parsedRemaining) * 1e4) / 1e4);
    } else if (meteredTurnCredits !== null) {
      nextUsed = Math.round((prev.used + meteredTurnCredits) * 1e4) / 1e4;
    }
    let nextRemaining;
    if (parsedRemaining !== null) {
      nextRemaining = parsedRemaining;
    } else if (nextLimit !== null && nextLimit > 0) {
      nextRemaining = Math.max(0, Math.round((nextLimit - nextUsed) * 1e4) / 1e4);
    } else if (limitProvided) {
      nextRemaining = null;
    } else {
      nextRemaining = prev.remaining;
    }
    const parsedAddon = pickNumber(sources, rawAddonKeys);
    const nextAddon = parsedAddon !== null ? parsedAddon : hasAnyKey(sources, rawAddonKeys) ? null : prev.addonRemaining ?? null;
    const rawPercentKeys = ["percentUsed", "usagePercent"];
    let nextPercentUsed = null;
    if (nextLimit !== null && nextLimit > 0) {
      nextPercentUsed = clampPercent(nextUsed / nextLimit * 100);
    } else {
      const percentProvided = hasAnyKey(sources, rawPercentKeys);
      const explicitPercent = pickNumber(sources, rawPercentKeys);
      if (explicitPercent !== null) {
        nextPercentUsed = clampPercent(explicitPercent);
      } else if (!limitProvided && !percentProvided) {
        nextPercentUsed = prev.percentUsed;
      }
    }
    const parsedContext = pickNumber(sources, rawContextKeys);
    const nextContext = parsedContext !== null ? clampPercent(parsedContext) : prev.contextUsagePercent;
    const parsedLastTurn = pickNumber(sources, rawLastTurnKeys) ?? meteredTurnCredits;
    const nextLastTurn = parsedLastTurn !== null ? parsedLastTurn : prev.lastTurnCredits;
    const parsedPlan = pickString(sources, rawPlanKeys);
    const nextPlan = parsedPlan ?? prev.planName;
    const parsedReset = pickString(sources, rawResetKeys);
    const nextReset = parsedReset ?? prev.resetAt;
    const parsedModel = pickString(sources, rawModelKeys);
    const nextModel = parsedModel ?? prev.activeModel;
    this.snapshot = {
      used: nextUsed,
      limit: nextLimit,
      remaining: nextRemaining,
      addonRemaining: nextAddon,
      percentUsed: nextPercentUsed,
      contextUsagePercent: nextContext,
      lastTurnCredits: nextLastTurn,
      planName: nextPlan,
      resetAt: nextReset,
      activeModel: nextModel,
      updatedAt: new Date().toISOString(),
      source
    };
    this.emit();
    return this.getSnapshot();
  }
  emit() {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch {}
    }
  }
}

// src/discovery/model-discovery.ts
var DEFAULT_CLI_PATH2 = "kiro-cli";
var DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
var DEFAULT_REQUEST_TIMEOUT_MS = 15000;
var DEFAULT_CONTEXT_LIMIT = 200000;
var DEFAULT_OUTPUT_LIMIT = 8192;
var ANSI_ESCAPE_RE2 = /\x1B\[[0-?]*[ -/]*[@-~]/g;
var KIRO_PREFIX = `${KIRO_PROVIDER_ID}/`;
var HEADER_LABELS = new Set([
  "id",
  "model",
  "model id",
  "model_id",
  "models",
  "name",
  "available models",
  "available models:"
]);
var PROSE_PREFIX_WORDS = new Set([
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
  "tip"
]);
var FALLBACK_MODELS = [
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
    source: "fallback"
  }
];
function stripAnsi2(input) {
  return input.replace(ANSI_ESCAPE_RE2, "");
}
function normalizeModelId(rawId) {
  if (typeof rawId !== "string")
    return "";
  const trimmed = rawId.trim();
  if (trimmed.startsWith(KIRO_PREFIX)) {
    return trimmed.slice(KIRO_PREFIX.length).trim();
  }
  return trimmed;
}
function parsePositiveInt(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return;
}
function toOptionalPositiveNumber(value) {
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
  return;
}
function normalizeDescriptor(raw, source, currentModelId) {
  if (!raw || typeof raw !== "object")
    return null;
  const desc = raw;
  const id = normalizeModelId(desc.id ?? desc.modelId ?? desc.model_id);
  if (!id)
    return null;
  const normalizedCurrent = typeof currentModelId === "string" ? normalizeModelId(currentModelId) : undefined;
  const explicitContext = parsePositiveInt(desc.contextWindow ?? desc.context_window_tokens);
  const explicitOutput = parsePositiveInt(desc.maxOutputTokens);
  const creditMultiplier = toOptionalPositiveNumber(desc.creditMultiplier ?? desc.rate_multiplier);
  const rawName = desc.name ?? desc.model_name;
  return {
    model: {
      id,
      qualifiedId: `${KIRO_PROVIDER_ID}/${id}`,
      name: typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : id,
      ...typeof desc.description === "string" && desc.description.trim().length > 0 ? { description: desc.description.trim() } : {},
      contextLimit: explicitContext ?? DEFAULT_CONTEXT_LIMIT,
      outputLimit: explicitOutput ?? DEFAULT_OUTPUT_LIMIT,
      ...creditMultiplier !== undefined ? { creditMultiplier } : {},
      reasoning: Boolean(desc.reasoning),
      toolCall: desc.supportsTools ?? true,
      vision: desc.supportsVision ?? false,
      isDefault: Boolean(desc.isDefault) || normalizedCurrent !== undefined && normalizedCurrent.length > 0 && id === normalizedCurrent,
      source
    },
    hasExplicitContext: explicitContext !== undefined,
    hasExplicitOutput: explicitOutput !== undefined
  };
}
function deduplicateEntries(entries) {
  const byId = new Map;
  for (const entry of entries) {
    const existing = byId.get(entry.model.id);
    if (!existing) {
      byId.set(entry.model.id, {
        model: { ...entry.model },
        hasExplicitContext: entry.hasExplicitContext,
        hasExplicitOutput: entry.hasExplicitOutput
      });
    } else {
      const useNewContext = !existing.hasExplicitContext && entry.hasExplicitContext;
      const useNewOutput = !existing.hasExplicitOutput && entry.hasExplicitOutput;
      byId.set(entry.model.id, {
        model: {
          ...existing.model,
          name: existing.model.name !== existing.model.id ? existing.model.name : entry.model.name,
          description: existing.model.description ?? entry.model.description,
          contextLimit: useNewContext ? entry.model.contextLimit : existing.model.contextLimit,
          outputLimit: useNewOutput ? entry.model.outputLimit : existing.model.outputLimit,
          creditMultiplier: existing.model.creditMultiplier ?? entry.model.creditMultiplier,
          reasoning: existing.model.reasoning || entry.model.reasoning,
          toolCall: existing.model.toolCall || entry.model.toolCall,
          vision: existing.model.vision || entry.model.vision,
          isDefault: existing.model.isDefault || entry.model.isDefault
        },
        hasExplicitContext: existing.hasExplicitContext || entry.hasExplicitContext,
        hasExplicitOutput: existing.hasExplicitOutput || entry.hasExplicitOutput
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
function extractModelsFromConfigOptions(configOptions) {
  if (!Array.isArray(configOptions))
    return [];
  const entries = [];
  for (const option of configOptions) {
    if (!option || typeof option !== "object")
      continue;
    if (option.category !== "model" && option.id !== "model") {
      continue;
    }
    if (!Array.isArray(option.options)) {
      continue;
    }
    const currentValue = typeof option.currentValue === "string" ? normalizeModelId(option.currentValue) : undefined;
    for (const choice of option.options) {
      if (!choice || typeof choice !== "object")
        continue;
      if (typeof choice.value !== "string")
        continue;
      const normalized = normalizeDescriptor({
        id: choice.value,
        name: typeof choice.name === "string" ? choice.name : choice.value,
        description: typeof choice.description === "string" ? choice.description : undefined,
        isDefault: currentValue !== undefined && currentValue.length > 0 && normalizeModelId(choice.value) === currentValue
      }, "acp", currentValue);
      if (normalized) {
        entries.push(normalized);
      }
    }
  }
  return entries;
}
function normalizeJsonModelEntry(entry) {
  if (typeof entry === "string") {
    return normalizeDescriptor({ id: entry }, "cli");
  }
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const obj = entry;
  const rawId = obj.id ?? obj.modelId ?? obj.model_id ?? obj.model ?? obj.value ?? obj.slug;
  if (typeof rawId !== "string" || rawId.trim().length === 0) {
    return null;
  }
  const rawName = obj.name ?? obj.model_name ?? obj.displayName ?? obj.label;
  const rawDesc = obj.description;
  const rawContext = obj.contextLimit ?? obj.contextWindow ?? obj.context_window_tokens ?? obj.context_window ?? obj.context_length ?? obj.maxContextTokens;
  const rawOutput = obj.outputLimit ?? obj.maxOutputTokens ?? obj.max_output_tokens ?? obj.output_limit;
  const rawMultiplier = obj.creditMultiplier ?? obj.credit_multiplier ?? obj.rate_multiplier ?? obj.multiplier ?? obj.credits;
  return normalizeDescriptor({
    id: rawId,
    name: typeof rawName === "string" ? rawName : undefined,
    description: typeof rawDesc === "string" ? rawDesc : undefined,
    contextWindow: parsePositiveInt(rawContext),
    maxOutputTokens: parsePositiveInt(rawOutput),
    creditMultiplier: toOptionalPositiveNumber(rawMultiplier),
    reasoning: typeof obj.reasoning === "boolean" ? obj.reasoning : typeof obj.supportsReasoning === "boolean" ? obj.supportsReasoning : false,
    supportsTools: typeof obj.toolCall === "boolean" ? obj.toolCall : typeof obj.supportsTools === "boolean" ? obj.supportsTools : typeof obj.tool_call === "boolean" ? obj.tool_call : true,
    supportsVision: typeof obj.vision === "boolean" ? obj.vision : typeof obj.supportsVision === "boolean" ? obj.supportsVision : false,
    isDefault: Boolean(obj.isDefault ?? obj.default)
  }, "cli");
}
function parsePlainTextModels(cleaned) {
  const entries = [];
  const lines = cleaned.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed)
      continue;
    if (/^[|\s\-=+─═:]+$/.test(trimmed))
      continue;
    let isDefault = false;
    let line = trimmed;
    if (line.startsWith("|")) {
      line = line.replace(/^\|+/, "").replace(/\|+$/, "").trim();
      if (!line)
        continue;
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
    const columns = line.split(/\t+|\s{2,}|\s*\|\s*/).map((col) => col.trim()).filter((col) => col.length > 0);
    const firstCol = columns[0];
    if (!firstCol)
      continue;
    const firstColLower = firstCol.toLowerCase();
    if (HEADER_LABELS.has(firstColLower)) {
      continue;
    }
    if (firstCol.endsWith(":")) {
      continue;
    }
    const firstColWords = firstCol.split(/\s+/);
    const idToken = firstColWords[0];
    if (!idToken)
      continue;
    if (idToken.endsWith(":")) {
      continue;
    }
    if (PROSE_PREFIX_WORDS.has(idToken.toLowerCase())) {
      continue;
    }
    if (columns.length === 1 && firstColWords.length > 1) {
      const rest = firstColWords.slice(1).join(" ");
      if (!/^\d+(?:\.\d+)?x(?:\s+credits?)?$/i.test(rest)) {
        continue;
      }
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(idToken)) {
      continue;
    }
    let name;
    let creditMultiplier;
    for (let i = 1;i < columns.length; i++) {
      const col = columns[i];
      if (!col)
        continue;
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
    const normalized = normalizeDescriptor({
      id: idToken,
      name: name ?? idToken,
      creditMultiplier,
      isDefault
    }, "cli");
    if (normalized) {
      entries.push(normalized);
    }
  }
  return deduplicateEntries(entries);
}

class KiroModelDiscovery {
  cliPath;
  cwd;
  requestTimeoutMs;
  cacheTtlMs;
  cachedModels = [];
  cacheExpiresAt = 0;
  constructor(options = {}) {
    this.cliPath = validateCliPath(options.cliPath ?? DEFAULT_CLI_PATH2);
    this.cwd = options.cwd;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.cacheTtlMs = options.modelCacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }
  async discover(options = {}) {
    const now = Date.now();
    const isFallbackOnly = this.cachedModels.length > 0 && this.cachedModels.every((m) => m.source === "fallback");
    const hasFreshAcpInput = Boolean(options.acpInit || options.acpSession);
    if (!options.forceRefresh && this.cachedModels.length > 0 && now < this.cacheExpiresAt && !(isFallbackOnly && hasFreshAcpInput)) {
      return this.cloneModels(this.cachedModels);
    }
    const acpModels = this.extractFromAcp(options.acpInit, options.acpSession);
    if (acpModels.length > 0) {
      return this.storeCache(acpModels);
    }
    const cliModels = await this.discoverFromCli();
    if (cliModels.length > 0) {
      return this.storeCache(cliModels);
    }
    return this.storeCache(FALLBACK_MODELS.map((m) => ({ ...m })));
  }
  parseCliModelsOutput(raw) {
    const cleaned = stripAnsi2(raw).trim();
    if (!cleaned)
      return [];
    try {
      const parsed = JSON.parse(cleaned);
      let entries = [];
      if (Array.isArray(parsed)) {
        entries = parsed;
      } else if (parsed && typeof parsed === "object") {
        const record = parsed;
        if (Array.isArray(record.models)) {
          entries = record.models;
        } else if (Array.isArray(record.availableModels)) {
          entries = record.availableModels;
        } else if (Array.isArray(record.data)) {
          entries = record.data;
        }
      }
      const normalized = entries.map(normalizeJsonModelEntry).filter((m) => m !== null);
      if (normalized.length > 0) {
        return deduplicateEntries(normalized);
      }
    } catch {}
    return parsePlainTextModels(cleaned);
  }
  getCachedModels() {
    return this.cloneModels(this.cachedModels);
  }
  invalidateCache() {
    this.cachedModels = [];
    this.cacheExpiresAt = 0;
  }
  extractFromAcp(acpInit, acpSession) {
    const collected = [];
    const currentModelId = acpSession?.models?.currentModelId;
    if (Array.isArray(acpSession?.models?.availableModels)) {
      for (const desc of acpSession.models.availableModels) {
        const normalized = normalizeDescriptor(desc, "acp", currentModelId);
        if (normalized) {
          collected.push(normalized);
        }
      }
    }
    const fromConfig = extractModelsFromConfigOptions(acpSession?.configOptions);
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
  async discoverFromCli() {
    const jsonResult = await spawnKiroCli(this.cliPath, ["chat", "--list-models", "--format", "json"], {
      cwd: this.cwd,
      timeoutMs: this.requestTimeoutMs
    });
    if (jsonResult.spawnFailed) {
      return [];
    }
    if (jsonResult.exitCode === 0 && jsonResult.stdout.trim().length > 0) {
      const parsed = this.parseCliModelsOutput(jsonResult.stdout);
      if (parsed.length > 0) {
        return parsed;
      }
    }
    if (jsonResult.exitCode !== 0 && !jsonResult.timedOut) {
      const textResult = await spawnKiroCli(this.cliPath, ["chat", "--list-models"], {
        cwd: this.cwd,
        timeoutMs: this.requestTimeoutMs
      });
      if (!textResult.spawnFailed && textResult.exitCode === 0 && textResult.stdout.trim().length > 0) {
        return this.parseCliModelsOutput(textResult.stdout);
      }
    }
    return [];
  }
  cloneModels(models) {
    return models.map((m) => ({ ...m }));
  }
  storeCache(models) {
    this.cachedModels = this.cloneModels(models);
    this.cacheExpiresAt = Date.now() + this.cacheTtlMs;
    return this.cloneModels(this.cachedModels);
  }
}
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
function createKiroRpcHandlerMap(impl) {
  return {
    [KIRO_RPC_METHODS.getCredits]: () => impl.getCredits(),
    [KIRO_RPC_METHODS.refreshCredits]: () => impl.refreshCredits(),
    [KIRO_RPC_METHODS.getAuthStatus]: () => impl.getAuthStatus(),
    [KIRO_RPC_METHODS.login]: () => impl.login(),
    [KIRO_RPC_METHODS.listModels]: (forceRefresh) => impl.listModels(Boolean(forceRefresh)),
    [KIRO_RPC_METHODS.getActiveModel]: () => impl.getActiveModel(),
    [KIRO_RPC_METHODS.setActiveModel]: (modelId) => {
      if (typeof modelId !== "string" || !modelId.trim()) {
        return Promise.reject(new Error("modelId must be a non-empty string"));
      }
      return impl.setActiveModel(modelId);
    }
  };
}

// src/opencode-v2.ts
var KIRO_PACKAGE_TAG = "aisdk:opencode-kiro";
function isOpenCodeV2Context(ctx) {
  if (!ctx || typeof ctx !== "object")
    return false;
  const candidate = ctx;
  const provider = candidate.provider;
  const aisdk = candidate.aisdk;
  return typeof provider?.transform === "function" && typeof aisdk?.hook === "function";
}
function mapFinishReasonV3(reason) {
  switch (reason) {
    case "stop":
    case "end_turn":
      return { unified: "stop", raw: reason };
    case "length":
    case "max_tokens":
      return { unified: "length", raw: reason };
    case "tool-calls":
      return { unified: "tool-calls", raw: reason };
    case "content-filter":
    case "refusal":
      return { unified: "content-filter", raw: reason };
    default:
      return { unified: "other", raw: reason };
  }
}
function toV3Usage(usage) {
  const inputTotal = usage?.promptTokens ?? 0;
  const outputTotal = usage?.completionTokens ?? 0;
  return {
    inputTokens: {
      total: inputTotal,
      noCache: inputTotal,
      cacheRead: 0,
      cacheWrite: 0
    },
    outputTokens: {
      total: outputTotal,
      text: outputTotal,
      reasoning: 0
    }
  };
}
function createLanguageModelV3Adapter(model) {
  return {
    specificationVersion: "v3",
    provider: KIRO_PROVIDER_ID,
    modelId: model.modelId,
    supportedUrls: {},
    async doGenerate(options) {
      const result = await model.doGenerate({
        prompt: options.prompt,
        abortSignal: options.abortSignal
      });
      const content = [];
      if (result.reasoning) {
        content.push({ type: "reasoning", text: result.reasoning });
      }
      if (result.text) {
        content.push({ type: "text", text: result.text });
      }
      for (const tc of result.toolCalls) {
        content.push({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args ?? {})
        });
      }
      return {
        content,
        finishReason: mapFinishReasonV3(result.finishReason),
        usage: toV3Usage(result.usage),
        warnings: []
      };
    },
    async doStream(options) {
      const { stream: v2Stream } = await model.doStream({
        prompt: options.prompt,
        abortSignal: options.abortSignal
      });
      const textId = `kiro-text-${Date.now()}`;
      const reasoningId = `kiro-reasoning-${Date.now()}`;
      let textStarted = false;
      let reasoningStarted = false;
      const v3Stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          const reader = v2Stream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done)
                break;
              if (value.type === "reasoning-delta") {
                if (!reasoningStarted) {
                  reasoningStarted = true;
                  controller.enqueue({ type: "reasoning-start", id: reasoningId });
                }
                controller.enqueue({
                  type: "reasoning-delta",
                  id: reasoningId,
                  delta: value.textDelta
                });
              } else if (value.type === "text-delta") {
                if (reasoningStarted) {
                  reasoningStarted = false;
                  controller.enqueue({ type: "reasoning-end", id: reasoningId });
                }
                if (!textStarted) {
                  textStarted = true;
                  controller.enqueue({ type: "text-start", id: textId });
                }
                controller.enqueue({
                  type: "text-delta",
                  id: textId,
                  delta: value.textDelta
                });
              } else if (value.type === "tool-call") {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: value.toolCallId,
                  toolName: value.toolName,
                  input: JSON.stringify(value.args ?? {})
                });
              } else if (value.type === "error") {
                controller.enqueue({ type: "error", error: value.error });
              } else if (value.type === "finish") {
                if (reasoningStarted) {
                  reasoningStarted = false;
                  controller.enqueue({ type: "reasoning-end", id: reasoningId });
                }
                if (textStarted) {
                  textStarted = false;
                  controller.enqueue({ type: "text-end", id: textId });
                }
                controller.enqueue({
                  type: "finish",
                  finishReason: mapFinishReasonV3(value.finishReason),
                  usage: toV3Usage(value.usage)
                });
              }
            }
          } finally {
            reader.releaseLock();
            controller.close();
          }
        },
        cancel() {
          return v2Stream.cancel();
        }
      });
      return { stream: v3Stream };
    }
  };
}
async function setupOpenCodeV2(ctx, options = {}) {
  const cliPath = typeof ctx.options?.cliPath === "string" && ctx.options.cliPath.trim() || options.cliPath || "kiro-cli";
  const cwd = options.cwd ?? ctx.location?.directory ?? process.cwd();
  const effectiveOptions = {
    ...options,
    cliPath,
    cwd
  };
  const acpClient = new AcpClient(effectiveOptions);
  const authManager = new KiroAuthManager(effectiveOptions);
  const modelDiscovery = new KiroModelDiscovery(effectiveOptions);
  const creditsStore = new KiroCreditsStore;
  const unsubscribeMetadata = acpClient.onMetadata((payload) => {
    creditsStore.updateFromMetadata(payload);
  });
  const providerInstance = createKiroProvider({
    acpClient,
    cwd,
    getKnownModels: () => modelDiscovery.getCachedModels(),
    onModelActive: (modelId) => {
      creditsStore.setActiveModel(modelId);
    }
  });
  const [authStatus, discoveredModels] = await Promise.all([
    authManager.getStatus().catch(() => ({
      authenticated: false,
      managedBy: "kiro-cli",
      accountLabel: null,
      authMethod: null,
      cliAvailable: false,
      cliPath,
      checkedAt: new Date().toISOString()
    })),
    modelDiscovery.discover({ forceRefresh: false }).catch(() => [])
  ]);
  const registrations = [];
  if (ctx.integration && typeof ctx.integration.transform === "function") {
    registrations.push(await ctx.integration.transform((editor) => {
      editor.update(KIRO_PROVIDER_ID, (integration) => {
        integration.name = "Kiro";
      });
      editor.method.update({
        integrationID: KIRO_PROVIDER_ID,
        method: {
          id: "kiro-cli-login",
          type: "command",
          label: "Kiro CLI Login (kiro-cli login)",
          command: [cliPath, "login"]
        }
      });
    }));
  }
  registrations.push(await ctx.provider.transform((editor) => {
    if (!editor.get(KIRO_PROVIDER_ID)) {
      editor.add({
        info: {
          id: KIRO_PROVIDER_ID,
          name: "Kiro",
          package: KIRO_PACKAGE_TAG,
          activation: authStatus.authenticated ? "enabled" : "auto"
        },
        models: []
      });
    }
    editor.update(KIRO_PROVIDER_ID, (provider) => {
      provider.name = "Kiro";
      provider.package = KIRO_PACKAGE_TAG;
      if (authStatus.authenticated && provider.activation === "auto") {
        provider.activation = "enabled";
      }
    });
    for (const model of discoveredModels) {
      editor.models.update(KIRO_PROVIDER_ID, model.id, (target) => {
        target.name = model.name;
        target.package = KIRO_PACKAGE_TAG;
        target.limit = {
          context: model.contextLimit,
          output: model.outputLimit
        };
        target.capabilities = {
          tools: model.toolCall,
          input: model.vision ? ["text", "image"] : ["text"],
          output: ["text"]
        };
        target.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }];
        target.variants = [];
      });
    }
  }));
  registrations.push(await ctx.aisdk.hook("sdk", async (event) => {
    event.sdk = {
      languageModel: (id) => createLanguageModelV3Adapter(providerInstance.languageModel(id))
    };
  }, { providerID: KIRO_PROVIDER_ID }));
  registrations.push(await ctx.aisdk.hook("language", async (event) => {
    const modelInfo = event.model;
    const modelId = typeof modelInfo?.id === "string" ? modelInfo.id : "auto";
    event.language = createLanguageModelV3Adapter(providerInstance.languageModel(modelId));
  }, { providerID: KIRO_PROVIDER_ID }));
  return async () => {
    unsubscribeMetadata();
    creditsStore.clearListeners();
    for (const reg of registrations) {
      try {
        await reg?.dispose?.();
      } catch {}
    }
    await acpClient.dispose();
  };
}

// src/index.ts
async function createKiroServerPlugin(ctx, options = {}) {
  const effectiveOptions = {
    ...options,
    cwd: options.cwd ?? ctx.directory
  };
  const acpClient = new AcpClient(effectiveOptions);
  const authManager = new KiroAuthManager(effectiveOptions);
  const modelDiscovery = new KiroModelDiscovery(effectiveOptions);
  const creditsStore = new KiroCreditsStore;
  let activeModel = null;
  const unsubscribeMetadata = acpClient.onMetadata((payload) => {
    const snap = creditsStore.updateFromMetadata(payload);
    if (snap.activeModel) {
      activeModel = snap.activeModel;
    }
  });
  const providerInstance = createKiroProvider({
    acpClient,
    cwd: effectiveOptions.cwd,
    getKnownModels: () => modelDiscovery.getCachedModels(),
    onModelActive: (modelId) => {
      activeModel = modelId;
      creditsStore.setActiveModel(modelId);
    }
  });
  const discoverModels = async (forceRefresh = false) => {
    const models = await modelDiscovery.discover({
      forceRefresh,
      acpInit: acpClient.getInitializeResult()
    });
    if (!activeModel) {
      const defaultModel = models.find((m) => m.isDefault) ?? models[0];
      if (defaultModel) {
        activeModel = defaultModel.id;
      }
    }
    return models;
  };
  const rpcImpl = {
    async getCredits() {
      return creditsStore.getSnapshot();
    },
    async refreshCredits() {
      try {
        if (!acpClient.isConnected()) {
          await acpClient.connect();
        }
        const usage = await acpClient.getUsage();
        if (usage && typeof usage === "object") {
          return creditsStore.updateFromUsage(usage);
        }
      } catch {}
      return creditsStore.getSnapshot();
    },
    async getAuthStatus() {
      return authManager.getStatus(acpClient);
    },
    async login() {
      const result = await authManager.login();
      if (result.ok) {
        modelDiscovery.invalidateCache();
      }
      return {
        ok: result.ok,
        status: result.status,
        message: result.output || (result.ok ? "Authenticated with Kiro CLI" : result.status.error ?? "Kiro CLI authentication failed")
      };
    },
    async listModels(forceRefresh = false) {
      return discoverModels(forceRefresh);
    },
    async getActiveModel() {
      return activeModel ?? creditsStore.getSnapshot().activeModel;
    },
    async setActiveModel(modelId) {
      if (!providerInstance.ownsModel(modelId)) {
        throw new KiroProviderOwnershipError(`Model "${String(modelId)}" is not owned by provider "${KIRO_PROVIDER_ID}".`, { modelId: String(modelId) });
      }
      const bareId = stripKiroPrefix(modelId);
      activeModel = bareId;
      creditsStore.setActiveModel(bareId);
      return { ok: true, modelId: bareId };
    }
  };
  const rpcHandlers = createKiroRpcHandlerMap(rpcImpl);
  if (typeof ctx.rpc?.register === "function") {
    ctx.rpc.register(KIRO_RPC_NAMESPACE, rpcHandlers);
  }
  const authHook = authManager.createOpenCodeAuthHook(async () => {
    modelDiscovery.invalidateCache();
  });
  const hooks = {
    auth: authHook,
    async config(config) {
      const models = await discoverModels(false);
      return applyKiroProviderConfig(config, models);
    },
    provider: {
      id: KIRO_PROVIDER_ID,
      ownsModel: (modelId) => providerInstance.ownsModel(modelId),
      getLanguageModel: (modelId) => providerInstance.languageModel(modelId),
      listModels: () => discoverModels(false)
    },
    rpc: rpcHandlers,
    async event(payload) {
      const evt = payload?.event;
      if (!evt)
        return;
      if (evt.type === "kiro.metadata" && evt.properties) {
        creditsStore.updateFromMetadata(evt.properties);
      } else if (evt.type === "model.changed" && typeof evt.properties?.modelId === "string") {
        const candidate = evt.properties.modelId;
        if (providerInstance.ownsModel(candidate)) {
          const bareId = stripKiroPrefix(candidate);
          activeModel = bareId;
          creditsStore.setActiveModel(bareId);
        }
      }
    },
    async dispose() {
      unsubscribeMetadata();
      creditsStore.clearListeners();
      await acpClient.dispose();
    }
  };
  return hooks;
}
async function setupPlugin(ctx, options = {}) {
  if (isOpenCodeV2Context(ctx)) {
    return setupOpenCodeV2(ctx, options);
  }
  return createKiroServerPlugin(ctx, options);
}
var plugin = {
  id: PLUGIN_ID,
  server: setupPlugin,
  setup: setupPlugin
};
var src_default = plugin;
export {
  KIRO_PROVIDER_ID,
  KIRO_RPC_METHODS,
  KIRO_RPC_NAMESPACE,
  KiroAcpLanguageModel,
  KiroCreditsStore,
  KiroProviderOwnershipError,
  PLUGIN_ID,
  applyKiroProviderConfig,
  assertKiroProviderOwnership,
  createKiroProvider,
  createKiroRpcClient,
  createKiroRpcHandlerMap,
  createKiroServerPlugin,
  src_default as default,
  isKiroModelId,
  stripKiroPrefix
};
