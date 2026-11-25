/**
 * Full ACP (Agent Client Protocol) Client communicating with `kiro-cli acp`
 * over newline-delimited JSON-RPC 2.0 stdio.
 */

import {
  ACP_PROTOCOL_VERSION,
  PLUGIN_ID,
  type AcpAuthMethod,
  type AcpContentBlock,
  type AcpInitializeParams,
  type AcpInitializeResult,
  type AcpPermissionOption,
  type AcpPermissionRequestParams,
  type AcpPermissionResponse,
  type AcpPromptParams,
  type AcpPromptResult,
  type AcpSessionNewParams,
  type AcpSessionNewResult,
  type AcpSessionUpdateParams,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type KiroPluginOptions,
} from "../types";
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_METHOD_NOT_FOUND,
  JsonRpcDispatcher,
  JsonRpcLineBuffer,
  JsonRpcResponseError,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  serializeJsonRpc,
} from "./jsonrpc";
import { KiroProcessSupervisor } from "./supervisor";

// ---------------------------------------------------------------------------
// Error Classes
// ---------------------------------------------------------------------------

export class AcpTransportError extends Error {
  readonly code?: number;
  readonly data?: unknown;
  readonly stderr?: string;

  constructor(
    message: string,
    options?: {
      code?: number;
      data?: unknown;
      stderr?: string;
      cause?: unknown;
    }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AcpTransportError";
    this.code = options?.code;
    this.data = options?.data;
    this.stderr = options?.stderr;
  }
}

export class AcpAuthRequiredError extends AcpTransportError {
  readonly authMethods: AcpAuthMethod[];

  constructor(
    message: string,
    options?: {
      code?: number;
      data?: unknown;
      stderr?: string;
      authMethods?: AcpAuthMethod[];
      cause?: unknown;
    }
  ) {
    super(message, options);
    this.name = "AcpAuthRequiredError";
    this.authMethods = options?.authMethods ?? [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_ERROR_CODES = new Set([-32001, -32002, 401]);
const AUTH_ERROR_PATTERN =
  /\b(auth|unauthenticated|unauthorized|not logged in|login required|authentication required|credentials?)\b/i;

const READ_ONLY_TOOL_KINDS = new Set([
  "read",
  "search",
  "fetch",
  "list",
  "grep",
  "glob",
  "web_search",
  "view",
  "find",
  "think",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthError(error: JsonRpcResponseError): boolean {
  return AUTH_ERROR_CODES.has(error.code) || AUTH_ERROR_PATTERN.test(error.message);
}

function selectOptionByKind(
  options: AcpPermissionOption[],
  kinds: readonly string[]
): AcpPermissionResponse | null {
  for (const kind of kinds) {
    const match = options.find(
      (opt) =>
        opt !== null &&
        typeof opt === "object" &&
        opt.kind === kind &&
        typeof opt.optionId === "string" &&
        opt.optionId.length > 0
    );
    if (match) {
      return { outcome: { outcome: "selected", optionId: match.optionId } };
    }
  }
  return null;
}

function evaluatePermissionPolicy(
  policy: NonNullable<KiroPluginOptions["permissionPolicy"]>,
  params: AcpPermissionRequestParams
): AcpPermissionResponse {
  const options = Array.isArray(params.options) ? params.options : [];

  if (policy === "allow_once") {
    const allow = selectOptionByKind(options, ["allow_once"]);
    if (allow) {
      return allow;
    }
  } else if (policy === "allow_read_only") {
    const rawKind: unknown = params.toolCall?.kind;
    const kind =
      typeof rawKind === "string" ? rawKind.toLowerCase().trim() : undefined;
    if (kind && READ_ONLY_TOOL_KINDS.has(kind)) {
      const allow = selectOptionByKind(options, ["allow_once"]);
      if (allow) {
        return allow;
      }
    }
  }

  // Default / deny_by_default fallback: prefer explicit reject option, else cancel
  const deny = selectOptionByKind(options, ["reject_once", "reject_always"]);
  return deny ?? { outcome: { outcome: "cancelled" } };
}

// ---------------------------------------------------------------------------
// ACP Client
// ---------------------------------------------------------------------------

export interface AcpPromptOptions {
  signal?: AbortSignal;
  onUpdate?: (params: AcpSessionUpdateParams) => void;
  timeoutMs?: number;
}

export class AcpClient {
  private readonly options: KiroPluginOptions;
  private readonly supervisor: KiroProcessSupervisor;
  private readonly dispatcher: JsonRpcDispatcher;
  private readonly lineBuffer: JsonRpcLineBuffer;

  private initializeResult: AcpInitializeResult | null = null;
  private connected = false;
  private disposed = false;
  private connectPromise: Promise<AcpInitializeResult> | null = null;

  private readonly supervisorUnsubs: Array<() => void> = [];
  private readonly sessionUpdateListeners = new Map<
    string,
    Set<(params: AcpSessionUpdateParams) => void>
  >();
  private readonly metadataListeners = new Set<
    (payload: Record<string, unknown>) => void
  >();
  private readonly parseErrorListeners = new Set<
    (error: Error, rawLine: string) => void
  >();

  private readonly toolCallKinds = new Map<string, string>();

  constructor(options: KiroPluginOptions = {}) {
    this.options = options;
    this.supervisor = new KiroProcessSupervisor({
      cliPath: options.cliPath,
      acpArgs: options.acpArgs,
      cwd: options.cwd,
    });
    this.dispatcher = new JsonRpcDispatcher({
      defaultTimeoutMs: options.requestTimeoutMs ?? 60_000,
    });
    this.lineBuffer = new JsonRpcLineBuffer({
      onMessage: (msg) => this.handleMessage(msg),
      onParseError: (err, rawLine) => {
        for (const listener of this.parseErrorListeners) {
          listener(err, rawLine);
        }
      },
    });

    this.attachSupervisorListeners();
  }

  /**
   * Starts `kiro-cli acp` and performs the ACP `initialize` handshake.
   * Deduplicates concurrent connection attempts and returns cached result if
   * already connected.
   */
  async connect(): Promise<AcpInitializeResult> {
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

  isConnected(): boolean {
    return this.connected && this.supervisor.isRunning();
  }

  getInitializeResult(): AcpInitializeResult | null {
    return this.initializeResult;
  }

  getStderrTail(lines = 20): string {
    return this.supervisor.getStderrTail(lines);
  }

  /**
   * Subscribes to `_kiro.dev/metadata` notifications from Kiro CLI.
   */
  onMetadata(listener: (payload: Record<string, unknown>) => void): () => void {
    this.metadataListeners.add(listener);
    return () => {
      this.metadataListeners.delete(listener);
    };
  }

  /**
   * Subscribes to malformed JSON-RPC frame parse errors for diagnostics.
   */
  onParseError(listener: (error: Error, rawLine: string) => void): () => void {
    this.parseErrorListeners.add(listener);
    return () => {
      this.parseErrorListeners.delete(listener);
    };
  }

  /**
   * Sends ACP `authenticate` request.
   */
  async authenticate(methodId?: string): Promise<unknown> {
    await this.ensureConnected();
    const params: Record<string, unknown> = methodId ? { methodId } : {};
    try {
      return await this.request("authenticate", params);
    } catch (err) {
      if (err instanceof JsonRpcResponseError && isAuthError(err)) {
        throw new AcpAuthRequiredError(err.message, {
          code: err.code,
          data: err.data,
          stderr: this.supervisor.getStderrTail(),
          authMethods: this.initializeResult?.authMethods,
          cause: err,
        });
      }
      throw this.wrapError(err, "authenticate");
    }
  }

  /**
   * Creates a new ACP session via `session/new`.
   * Throws `AcpAuthRequiredError` if the agent reports an authentication error.
   */
  async newSession(
    cwd?: string,
    mcpServers?: Array<Record<string, unknown>>
  ): Promise<AcpSessionNewResult> {
    await this.ensureConnected();
    const params: AcpSessionNewParams = {
      cwd: cwd ?? this.options.cwd ?? process.cwd(),
      mcpServers: mcpServers ?? [],
    };
    try {
      return await this.request<AcpSessionNewResult>(
        "session/new",
        params as unknown as Record<string, unknown>
      );
    } catch (err) {
      if (err instanceof JsonRpcResponseError && isAuthError(err)) {
        throw new AcpAuthRequiredError(err.message, {
          code: err.code,
          data: err.data,
          stderr: this.supervisor.getStderrTail(),
          authMethods: this.initializeResult?.authMethods,
          cause: err,
        });
      }
      throw this.wrapError(err, "session/new");
    }
  }

  /**
   * Sets the active model for a session via `session/set_model`.
   * If the agent returns `-32601` (Method not found, as in Kiro CLI v3),
   * transparently falls back to `session/set_config_option`.
   */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.ensureConnected();
    try {
      await this.request("session/set_model", { sessionId, modelId });
    } catch (err) {
      if (
        err instanceof JsonRpcResponseError &&
        err.code === JSON_RPC_METHOD_NOT_FOUND
      ) {
        try {
          await this.request("session/set_config_option", {
            sessionId,
            configId: "model",
            value: modelId,
          });
          return;
        } catch (fallbackErr) {
          throw this.wrapError(fallbackErr, "session/set_config_option");
        }
      }
      throw this.wrapError(err, "session/set_model");
    }
  }

  /**
   * Sends a prompt turn via `session/prompt`, routing `session/update`
   * notifications for `sessionId` to `options.onUpdate` and sending
   * `session/cancel` if `options.signal` aborts.
   */
  async prompt(
    sessionId: string,
    blocks: AcpContentBlock[],
    options: AcpPromptOptions = {}
  ): Promise<AcpPromptResult> {
    await this.ensureConnected();

    const { signal, onUpdate, timeoutMs } = options;

    let unsubUpdate: (() => void) | undefined;
    if (onUpdate) {
      unsubUpdate = this.subscribeSessionUpdates(sessionId, onUpdate);
    }

    const onAbort = (): void => {
      void this.cancel(sessionId).catch(() => {
        // Ignore cancel failures if the process already exited
      });
    };

    if (signal) {
      if (signal.aborted) {
        unsubUpdate?.();
        throw new AcpTransportError(`Prompt for session "${sessionId}" was aborted`);
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const params: AcpPromptParams = {
      sessionId,
      prompt: blocks,
    };

    try {
      return await this.request<AcpPromptResult>(
        "session/prompt",
        params as unknown as Record<string, unknown>,
        { signal, timeoutMs }
      );
    } catch (err) {
      throw this.wrapError(err, "session/prompt");
    } finally {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      unsubUpdate?.();
    }
  }

  /**
   * Sends `session/cancel` notification for an active session.
   */
  async cancel(sessionId: string): Promise<void> {
    if (!this.isConnected()) {
      return;
    }
    this.sendNotification("session/cancel", { sessionId });
  }

  /**
   * Queries Kiro account usage via `_kiro/account/getUsage`.
   * Returns `null` if the agent does not implement this extension (`-32601`).
   */
  async getUsage(): Promise<Record<string, unknown> | null> {
    await this.ensureConnected();
    try {
      const result = await this.request<Record<string, unknown> | null>(
        "_kiro/account/getUsage",
        {}
      );
      return result ?? null;
    } catch (err) {
      if (
        err instanceof JsonRpcResponseError &&
        err.code === JSON_RPC_METHOD_NOT_FOUND
      ) {
        return null;
      }
      throw this.wrapError(err, "_kiro/account/getUsage");
    }
  }

  /**
   * Rejects all pending requests, clears listeners, and terminates the
   * underlying `kiro-cli acp` subprocess cleanly.
   */
  async dispose(): Promise<void> {
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

  // -------------------------------------------------------------------------
  // Internal Transport Mechanics
  // -------------------------------------------------------------------------

  private attachSupervisorListeners(): void {
    this.supervisorUnsubs.push(
      this.supervisor.onStdout((chunk) => {
        this.lineBuffer.push(chunk);
      }),
      this.supervisor.onError((err) => {
        this.connected = false;
        this.initializeResult = null;
        this.dispatcher.rejectAll(
          new AcpTransportError(`Kiro ACP process error: ${err.message}`, {
            stderr: this.supervisor.getStderrTail(),
            cause: err,
          })
        );
      }),
      this.supervisor.onExit(({ code, signal }) => {
        this.lineBuffer.flush();
        this.connected = false;
        this.initializeResult = null;
        if (!this.disposed) {
          this.dispatcher.rejectAll(
            new AcpTransportError(
              `Kiro ACP process exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
              { stderr: this.supervisor.getStderrTail() }
            )
          );
        }
      })
    );
  }

  private async performConnect(): Promise<AcpInitializeResult> {
    this.lineBuffer.reset();
    this.supervisor.start();

    const params: AcpInitializeParams = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: PLUGIN_ID,
        version: "1.0.0",
      },
    };

    try {
      const result = await this.request<AcpInitializeResult>(
        "initialize",
        params as unknown as Record<string, unknown>
      );
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

  private async ensureConnected(): Promise<void> {
    if (!this.isConnected()) {
      await this.connect();
    }
  }

  private request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<T> {
    return this.dispatcher.sendRequest<T>(
      (req) => this.writeMessage(req),
      method,
      params,
      options
    );
  }

  private sendNotification(
    method: string,
    params?: Record<string, unknown>
  ): void {
    const notification: JsonRpcNotification =
      params !== undefined
        ? { jsonrpc: "2.0", method, params }
        : { jsonrpc: "2.0", method };
    this.writeMessage(notification);
  }

  private sendResponse(response: JsonRpcResponse): void {
    if (!this.supervisor.isRunning()) {
      return;
    }
    this.writeMessage(response);
  }

  private writeMessage(msg: JsonRpcMessage): void {
    const frame = serializeJsonRpc(msg);
    try {
      this.supervisor.write(frame);
    } catch (err) {
      throw new AcpTransportError(
        `Failed to write JSON-RPC frame: ${err instanceof Error ? err.message : String(err)}`,
        {
          stderr: this.supervisor.getStderrTail(),
          cause: err,
        }
      );
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (isJsonRpcResponse(msg)) {
      this.dispatcher.handleResponse(msg);
      return;
    }

    if (isJsonRpcRequest(msg)) {
      void this.handleInboundRequest(msg);
      return;
    }

    if (isJsonRpcNotification(msg)) {
      this.handleInboundNotification(msg);
    }
  }

  private handleInboundNotification(notification: JsonRpcNotification): void {
    const { method, params } = notification;

    if (method === "session/update" && isRecord(params)) {
      const sessionId = params["sessionId"];
      const update = params["update"];
      if (typeof sessionId === "string" && isRecord(update)) {
        // Remember toolCallId -> kind / _meta.kiro.toolName from `tool_call` updates
        // because kiro-cli 3.6+ omits `kind` on the subsequent `session/request_permission`.
        const tcId = update["toolCallId"];
        if (typeof tcId === "string" && tcId.length > 0) {
          const meta = update["_meta"];
          const kiroMeta = isRecord(meta) ? meta["kiro"] : undefined;
          const kiroToolName =
            isRecord(kiroMeta) && typeof kiroMeta["toolName"] === "string"
              ? kiroMeta["toolName"]
              : undefined;
          const recordedKind =
            typeof update["kind"] === "string" && update["kind"].trim().length > 0
              ? update["kind"]
              : kiroToolName;
          if (recordedKind) {
            if (this.toolCallKinds.size >= 256) {
              const oldest = this.toolCallKinds.keys().next().value;
              if (oldest !== undefined) this.toolCallKinds.delete(oldest);
            }
            this.toolCallKinds.set(tcId, recordedKind);
          }
        }

        const updateParams = params as unknown as AcpSessionUpdateParams;
        const listeners = this.sessionUpdateListeners.get(sessionId);
        if (listeners) {
          for (const listener of listeners) {
            try {
              listener(updateParams);
            } catch {
              // Isolate listener exceptions so remaining listeners & frames are unaffected
            }
          }
        }
      }
      return;
    }

    if (method === "_kiro.dev/metadata" && isRecord(params)) {
      for (const listener of this.metadataListeners) {
        try {
          listener(params);
        } catch {
          // Isolate listener exceptions so remaining listeners & frames are unaffected
        }
      }
    }
  }

  private async handleInboundRequest(request: JsonRpcRequest): Promise<void> {
    if (request.method === "session/request_permission") {
      const rawParams = (
        isRecord(request.params) ? request.params : {}
      ) as unknown as AcpPermissionRequestParams;
      // Enrich missing `toolCall.kind` from the preceding `tool_call` notification
      const tcId = rawParams.toolCall?.toolCallId;
      const inferredKind =
        rawParams.toolCall?.kind === undefined && typeof tcId === "string"
          ? this.toolCallKinds.get(tcId)
          : undefined;
      const params: AcpPermissionRequestParams =
        inferredKind && rawParams.toolCall
          ? {
              ...rawParams,
              toolCall: { ...rawParams.toolCall, kind: inferredKind },
            }
          : rawParams;
      try {
        const policy = this.options.permissionPolicy ?? "deny_by_default";
        const outcome: AcpPermissionResponse = this.options.onPermissionRequest
          ? await this.options.onPermissionRequest(params)
          : evaluatePermissionPolicy(policy, params);

        this.safeSendResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: outcome,
        });
      } catch (err) {
        this.safeSendResponse({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: JSON_RPC_INTERNAL_ERROR,
            message:
              err instanceof Error
                ? err.message
                : "Permission handler failed",
          },
        });
      }
      return;
    }

    this.safeSendResponse({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: JSON_RPC_METHOD_NOT_FOUND,
        message: `Unsupported client method: ${request.method}`,
      },
    });
  }

  private safeSendResponse(response: JsonRpcResponse): void {
    try {
      this.sendResponse(response);
    } catch {
      // Ignore write failures if the subprocess exited while handling an inbound request
    }
  }

  private subscribeSessionUpdates(
    sessionId: string,
    listener: (params: AcpSessionUpdateParams) => void
  ): () => void {
    let set = this.sessionUpdateListeners.get(sessionId);
    if (!set) {
      set = new Set();
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

  private wrapError(err: unknown, method: string): Error {
    if (err instanceof AcpTransportError) {
      return err;
    }
    if (err instanceof JsonRpcResponseError) {
      return new AcpTransportError(
        `ACP "${method}" failed (${err.code}): ${err.message}`,
        {
          code: err.code,
          data: err.data,
          stderr: this.supervisor.getStderrTail(),
          cause: err,
        }
      );
    }
    if (err instanceof Error) {
      return new AcpTransportError(err.message, {
        stderr: this.supervisor.getStderrTail(),
        cause: err,
      });
    }
    return new AcpTransportError(`ACP "${method}" failed: ${String(err)}`, {
      stderr: this.supervisor.getStderrTail(),
    });
  }
}
