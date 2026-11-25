/**
 * Strict newline-delimited JSON-RPC 2.0 framing, serialization, and request
 * correlation for ACP (Agent Client Protocol) over stdio.
 */

import type {
  JsonRpcError,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../types";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 Standard Error Codes
// ---------------------------------------------------------------------------

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export class JsonRpcResponseError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: JsonRpcError) {
    super(error.message);
    this.name = "JsonRpcResponseError";
    this.code = error.code;
    this.data = error.data;
  }
}

export class JsonRpcTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`JSON-RPC request "${method}" timed out after ${timeoutMs}ms`);
    this.name = "JsonRpcTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class JsonRpcAbortedError extends Error {
  readonly method: string;

  constructor(method: string, reason?: unknown) {
    const detail =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : "aborted";
    super(`JSON-RPC request "${method}" was aborted: ${detail}`);
    this.name = "JsonRpcAbortedError";
    this.method = method;
  }
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return (
    "method" in msg &&
    typeof msg.method === "string" &&
    "id" in msg &&
    (typeof msg.id === "string" || typeof msg.id === "number")
  );
}

export function isJsonRpcNotification(
  msg: JsonRpcMessage
): msg is JsonRpcNotification {
  return (
    "method" in msg &&
    typeof msg.method === "string" &&
    !("id" in msg && msg.id !== undefined)
  );
}

export function isJsonRpcResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return !("method" in msg) && "id" in msg && ("result" in msg || "error" in msg);
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Serializes a JSON-RPC 2.0 message to a single newline-delimited frame.
 */
export function serializeJsonRpc(msg: JsonRpcMessage): string {
  return `${JSON.stringify(msg)}\n`;
}

// ---------------------------------------------------------------------------
// Newline-Delimited Frame Parser
// ---------------------------------------------------------------------------

export interface JsonRpcLineBufferOptions {
  onMessage: (message: JsonRpcMessage) => void;
  onParseError?: (error: Error, rawLine: string) => void;
  /** Maximum characters/bytes buffered for a single JSON-RPC line (default: 16 MiB) */
  maxLineBytes?: number;
}

const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Stateful newline-delimited JSON-RPC 2.0 frame parser.
 *
 * Handles arbitrary chunk boundaries, multi-byte UTF-8 sequences split across
 * chunks, empty/whitespace lines, CRLF/LF endings, oversized lines, and
 * malformed JSON or throwing listeners without crashing or stranding frames.
 */
export class JsonRpcLineBuffer {
  private readonly decoder = new TextDecoder("utf-8");
  private readonly onMessage: (message: JsonRpcMessage) => void;
  private readonly onParseError?: (error: Error, rawLine: string) => void;
  private readonly maxLineBytes: number;
  private remainder = "";
  private discardingOversizedLine = false;

  constructor(options: JsonRpcLineBufferOptions) {
    this.onMessage = options.onMessage;
    this.onParseError = options.onParseError;
    this.maxLineBytes = Math.max(1024, options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);
  }

  /**
   * Push a raw chunk of bytes or string data from stdout.
   */
  push(chunk: Uint8Array | Buffer | string): void {
    const text =
      typeof chunk === "string"
        ? chunk
        : this.decoder.decode(chunk, { stream: true });

    if (text.length === 0) {
      return;
    }

    if (this.discardingOversizedLine) {
      const newlineIdx = text.indexOf("\n");
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
      this.safeParseError(
        new Error(`JSON-RPC line exceeded maximum size of ${this.maxLineBytes} bytes`),
        preview
      );
    }
  }

  /**
   * Flush any buffered multi-byte UTF-8 state and trailing partial line
   * (e.g. on stream EOF).
   */
  flush(): void {
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

  /**
   * Clear any buffered partial data.
   */
  reset(): void {
    this.remainder = "";
    this.discardingOversizedLine = false;
    // Reset decoder internal state by flushing without streaming
    this.decoder.decode();
  }

  private drainLines(): void {
    let newlineIdx = this.remainder.indexOf("\n");
    while (newlineIdx !== -1) {
      const rawLine = this.remainder.slice(0, newlineIdx);
      this.remainder = this.remainder.slice(newlineIdx + 1);
      if (this.discardingOversizedLine) {
        this.discardingOversizedLine = false;
      } else {
        this.processLine(rawLine);
      }
      newlineIdx = this.remainder.indexOf("\n");
    }
  }

  private processLine(rawLine: string): void {
    if (rawLine.length > this.maxLineBytes) {
      this.safeParseError(
        new Error(`JSON-RPC line exceeded maximum size of ${this.maxLineBytes} bytes`),
        rawLine.slice(0, 256)
      );
      return;
    }

    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const parseErr =
        err instanceof Error ? err : new Error(`Failed to parse JSON: ${String(err)}`);
      this.safeParseError(parseErr, trimmed);
      return;
    }

    if (!isRecord(parsed) || parsed["jsonrpc"] !== "2.0") {
      this.safeParseError(
        new Error('Invalid JSON-RPC 2.0 frame: expected object with jsonrpc="2.0"'),
        trimmed
      );
      return;
    }

    const hasMethod = typeof parsed["method"] === "string";
    const hasId = "id" in parsed;
    const hasResultOrError = "result" in parsed || "error" in parsed;

    if (!hasMethod && !(hasId && hasResultOrError)) {
      this.safeParseError(
        new Error("Invalid JSON-RPC 2.0 frame: missing method or response payload"),
        trimmed
      );
      return;
    }

    try {
      this.onMessage(parsed as unknown as JsonRpcMessage);
    } catch (err) {
      const handlerErr =
        err instanceof Error ? err : new Error(`Message handler threw: ${String(err)}`);
      this.safeParseError(handlerErr, trimmed);
    }
  }

  private safeParseError(error: Error, rawLine: string): void {
    try {
      this.onParseError?.(error, rawLine);
    } catch {
      // Never allow parse error callbacks to break stream framing
    }
  }
}

// ---------------------------------------------------------------------------
// Request Correlation Dispatcher
// ---------------------------------------------------------------------------

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  cleanupAbort?: () => void;
}

export interface JsonRpcDispatcherOptions {
  defaultTimeoutMs?: number;
}

export interface JsonRpcRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Manages outbound JSON-RPC 2.0 request correlation, per-request timeouts,
 * AbortSignal cancellation, and bulk rejection on disconnect/crash.
 */
export class JsonRpcDispatcher {
  private nextRequestId = 1;
  private readonly defaultTimeoutMs: number;
  private readonly pending = new Map<number | string, PendingRequest>();

  constructor(options: JsonRpcDispatcherOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  nextId(): number {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return id;
  }

  /**
   * Registers a pending request, invokes `send` with the constructed
   * JsonRpcRequest, and returns a promise settled by `handleResponse`,
   * timeout, AbortSignal, or `rejectAll`.
   */
  sendRequest<T = unknown>(
    send: (request: JsonRpcRequest) => void,
    method: string,
    params?: Record<string, unknown>,
    options: JsonRpcRequestOptions = {}
  ): Promise<T> {
    const { signal } = options;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    if (signal?.aborted) {
      return Promise.reject(new JsonRpcAbortedError(method, signal.reason));
    }

    const id = this.nextId();
    const request: JsonRpcRequest =
      params !== undefined
        ? { jsonrpc: "2.0", id, method, params }
        : { jsonrpc: "2.0", id, method };

    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
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
        const onAbort = (): void => {
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
          current.reject(
            err instanceof Error ? err : new Error(String(err))
          );
        }
      }
    });
  }

  /**
   * Resolves or rejects the pending request matching `response.id`.
   * Returns true if a matching pending request was found.
   */
  handleResponse(response: JsonRpcResponse): boolean {
    if (response.id === null || response.id === undefined) {
      return false;
    }

    const entry = this.takePending(response.id);
    if (!entry) {
      return false;
    }

    if ("error" in response && response.error !== undefined && response.error !== null) {
      const rawErr: unknown = response.error;
      if (
        isRecord(rawErr) &&
        typeof rawErr["code"] === "number" &&
        typeof rawErr["message"] === "string"
      ) {
        entry.reject(
          new JsonRpcResponseError({
            code: rawErr["code"],
            message: rawErr["message"],
            data: rawErr["data"],
          })
        );
      } else {
        entry.reject(
          new JsonRpcResponseError({
            code: JSON_RPC_INTERNAL_ERROR,
            message: `Malformed JSON-RPC error payload: ${String(rawErr)}`,
            data: rawErr,
          })
        );
      }
    } else {
      entry.resolve(response.result);
    }

    return true;
  }

  /**
   * Rejects all in-flight requests (e.g. on process exit or disposal).
   */
  rejectAll(error: Error): void {
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

  private takePending(id: number | string): PendingRequest | undefined {
    const entry = this.pending.get(id);
    if (!entry) {
      return undefined;
    }
    this.pending.delete(id);
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    entry.cleanupAbort?.();
    return entry;
  }
}
