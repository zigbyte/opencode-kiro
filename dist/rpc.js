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
export {
  KIRO_RPC_METHODS,
  KIRO_RPC_NAMESPACE,
  createKiroRpcClient,
  createKiroRpcHandlerMap
};
