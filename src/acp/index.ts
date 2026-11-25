/**
 * Barrel exports for the ACP JSON-RPC 2.0 stdio transport layer.
 */

export {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  JsonRpcAbortedError,
  JsonRpcDispatcher,
  JsonRpcLineBuffer,
  JsonRpcResponseError,
  JsonRpcTimeoutError,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  serializeJsonRpc,
  type JsonRpcDispatcherOptions,
  type JsonRpcLineBufferOptions,
  type JsonRpcRequestOptions,
} from "./jsonrpc";

export {
  KiroProcessSupervisor,
  type KiroSupervisorOptions,
  type ProcessExitEvent,
} from "./supervisor";

export {
  AcpAuthRequiredError,
  AcpClient,
  AcpTransportError,
  type AcpPromptOptions,
} from "./client";
