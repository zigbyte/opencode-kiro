/**
 * Typed RPC contract shared between the OpenCode 2.x Server plugin (`.`)
 * and the TUI plugin (`./tui`).
 *
 * Security invariant: RPC methods NEVER return raw credentials, tokens, or secrets.
 */

import type {
  KiroAuthStatus,
  KiroCreditsSnapshot,
  KiroModelInfo,
} from "./types.ts";

export const KIRO_RPC_NAMESPACE = "opencode-kiro" as const;

export const KIRO_RPC_METHODS = {
  getCredits: `${KIRO_RPC_NAMESPACE}.getCredits`,
  refreshCredits: `${KIRO_RPC_NAMESPACE}.refreshCredits`,
  getAuthStatus: `${KIRO_RPC_NAMESPACE}.getAuthStatus`,
  login: `${KIRO_RPC_NAMESPACE}.login`,
  listModels: `${KIRO_RPC_NAMESPACE}.listModels`,
  getActiveModel: `${KIRO_RPC_NAMESPACE}.getActiveModel`,
  setActiveModel: `${KIRO_RPC_NAMESPACE}.setActiveModel`,
} as const;

export interface KiroLoginRpcResult {
  ok: boolean;
  status: KiroAuthStatus;
  message: string;
}

export interface KiroRpcContract {
  getCredits(): Promise<KiroCreditsSnapshot>;
  refreshCredits(): Promise<KiroCreditsSnapshot>;
  getAuthStatus(): Promise<KiroAuthStatus>;
  login(): Promise<KiroLoginRpcResult>;
  listModels(forceRefresh?: boolean): Promise<KiroModelInfo[]>;
  getActiveModel(): Promise<string | null>;
  setActiveModel(modelId: string): Promise<{ ok: boolean; modelId: string }>;
}

export interface RpcCaller {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
}

export function createKiroRpcClient(caller: RpcCaller): KiroRpcContract {
  return {
    getCredits: () => caller.call<KiroCreditsSnapshot>(KIRO_RPC_METHODS.getCredits),
    refreshCredits: () => caller.call<KiroCreditsSnapshot>(KIRO_RPC_METHODS.refreshCredits),
    getAuthStatus: () => caller.call<KiroAuthStatus>(KIRO_RPC_METHODS.getAuthStatus),
    login: () => caller.call<KiroLoginRpcResult>(KIRO_RPC_METHODS.login),
    listModels: (forceRefresh?: boolean) =>
      caller.call<KiroModelInfo[]>(KIRO_RPC_METHODS.listModels, forceRefresh ?? false),
    getActiveModel: () => caller.call<string | null>(KIRO_RPC_METHODS.getActiveModel),
    setActiveModel: (modelId: string) =>
      caller.call<{ ok: boolean; modelId: string }>(KIRO_RPC_METHODS.setActiveModel, modelId),
  };
}

export function createKiroRpcHandlerMap(
  impl: KiroRpcContract
): Record<string, (...args: unknown[]) => Promise<unknown>> {
  return {
    [KIRO_RPC_METHODS.getCredits]: () => impl.getCredits(),
    [KIRO_RPC_METHODS.refreshCredits]: () => impl.refreshCredits(),
    [KIRO_RPC_METHODS.getAuthStatus]: () => impl.getAuthStatus(),
    [KIRO_RPC_METHODS.login]: () => impl.login(),
    [KIRO_RPC_METHODS.listModels]: (forceRefresh?: unknown) =>
      impl.listModels(Boolean(forceRefresh)),
    [KIRO_RPC_METHODS.getActiveModel]: () => impl.getActiveModel(),
    [KIRO_RPC_METHODS.setActiveModel]: (modelId?: unknown) => {
      if (typeof modelId !== "string" || !modelId.trim()) {
        return Promise.reject(new Error("modelId must be a non-empty string"));
      }
      return impl.setActiveModel(modelId);
    },
  };
}
