/**
 * OpenCode 2.x Server Plugin entrypoint for `opencode-kiro`.
 *
 * Wires:
 * - ACP stdio JSON-RPC client (`kiro-cli acp`)
 * - Native `kiro-cli login` / `kiro-cli whoami` auth hook (zero credential scraping)
 * - Dynamic Kiro model discovery (ACP + CLI + safe fallback)
 * - Strict `"kiro"` provider ownership guard & AI SDK v2/v3 LanguageModel adapter
 * - Reactive Kiro credits store (`_kiro.dev/metadata` + `_kiro/account/getUsage`)
 * - Typed RPC handlers for the companion `./tui` plugin
 */

import { AcpClient } from "./acp/index.ts";
import { KiroAuthManager } from "./auth/index.ts";
import { KiroCreditsStore } from "./credits/store.ts";
import { KiroModelDiscovery } from "./discovery/index.ts";
import {
  KiroProviderOwnershipError,
  applyKiroProviderConfig,
  createKiroProvider,
  stripKiroPrefix,
} from "./provider/index.ts";
import {
  KIRO_RPC_NAMESPACE,
  createKiroRpcHandlerMap,
  type KiroLoginRpcResult,
  type KiroRpcContract,
} from "./rpc.ts";
import {
  KIRO_PROVIDER_ID,
  PLUGIN_ID,
  type KiroModelInfo,
  type KiroPluginOptions,
  type OpenCodeConfig,
  type OpenCodePluginContext,
  type OpenCodeServerHooks,
  type OpenCodeServerPluginModule,
} from "./types.ts";

export {
  KIRO_PROVIDER_ID,
  PLUGIN_ID,
  type KiroAuthStatus,
  type KiroCreditsSnapshot,
  type KiroModelInfo,
  type KiroPluginOptions,
  type OpenCodeConfig,
  type OpenCodePluginContext,
  type OpenCodeServerHooks,
  type OpenCodeServerPluginModule,
} from "./types.ts";
export { KiroCreditsStore } from "./credits/store.ts";
export {
  KiroAcpLanguageModel,
  KiroProviderOwnershipError,
  applyKiroProviderConfig,
  assertKiroProviderOwnership,
  createKiroProvider,
  isKiroModelId,
  stripKiroPrefix,
} from "./provider/index.ts";
export {
  KIRO_RPC_METHODS,
  KIRO_RPC_NAMESPACE,
  createKiroRpcClient,
  createKiroRpcHandlerMap,
  type KiroLoginRpcResult,
  type KiroRpcContract,
} from "./rpc.ts";

/**
 * OpenCode 2.x server plugin initializer.
 */
export async function createKiroServerPlugin(
  ctx: OpenCodePluginContext,
  options: KiroPluginOptions = {}
): Promise<OpenCodeServerHooks> {
  const effectiveOptions: KiroPluginOptions = {
    ...options,
    cwd: options.cwd ?? ctx.directory,
  };

  const acpClient = new AcpClient(effectiveOptions);
  const authManager = new KiroAuthManager(effectiveOptions);
  const modelDiscovery = new KiroModelDiscovery(effectiveOptions);
  const creditsStore = new KiroCreditsStore();

  let activeModel: string | null = null;

  // Hook ACP `_kiro.dev/metadata` notifications directly into the credits store
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
    },
  });

  const discoverModels = async (forceRefresh = false): Promise<KiroModelInfo[]> => {
    const models = await modelDiscovery.discover({
      forceRefresh,
      acpInit: acpClient.getInitializeResult(),
    });
    if (!activeModel) {
      const defaultModel = models.find((m) => m.isDefault) ?? models[0];
      if (defaultModel) {
        activeModel = defaultModel.id;
      }
    }
    return models;
  };

  const rpcImpl: KiroRpcContract = {
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
      } catch {
        // Fall back gracefully to last known snapshot if ACP/CLI is unavailable
      }
      return creditsStore.getSnapshot();
    },

    async getAuthStatus() {
      return authManager.getStatus(acpClient);
    },

    async login(): Promise<KiroLoginRpcResult> {
      const result = await authManager.login();
      if (result.ok) {
        modelDiscovery.invalidateCache();
      }
      return {
        ok: result.ok,
        status: result.status,
        message:
          result.output ||
          (result.ok
            ? "Authenticated with Kiro CLI"
            : (result.status.error ?? "Kiro CLI authentication failed")),
      };
    },

    async listModels(forceRefresh = false) {
      return discoverModels(forceRefresh);
    },

    async getActiveModel() {
      return activeModel ?? creditsStore.getSnapshot().activeModel;
    },

    async setActiveModel(modelId: string) {
      if (!providerInstance.ownsModel(modelId)) {
        throw new KiroProviderOwnershipError(
          `Model "${String(modelId)}" is not owned by provider "${KIRO_PROVIDER_ID}".`,
          { modelId: String(modelId) }
        );
      }
      const bareId = stripKiroPrefix(modelId);
      activeModel = bareId;
      creditsStore.setActiveModel(bareId);
      return { ok: true, modelId: bareId };
    },
  };

  const rpcHandlers = createKiroRpcHandlerMap(rpcImpl);

  if (typeof ctx.rpc?.register === "function") {
    ctx.rpc.register(KIRO_RPC_NAMESPACE, rpcHandlers);
  }

  const authHook = authManager.createOpenCodeAuthHook(async () => {
    modelDiscovery.invalidateCache();
  });

  const hooks: OpenCodeServerHooks = {
    auth: authHook,

    async config(config: OpenCodeConfig): Promise<OpenCodeConfig> {
      const models = await discoverModels(false);
      return applyKiroProviderConfig(config, models);
    },

    provider: {
      id: KIRO_PROVIDER_ID,
      ownsModel: (modelId: string) => providerInstance.ownsModel(modelId),
      getLanguageModel: (modelId: string) => providerInstance.languageModel(modelId),
      listModels: () => discoverModels(false),
    },

    rpc: rpcHandlers,

    async event(payload) {
      const evt = payload?.event;
      if (!evt) return;

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
    },
  };

  return hooks;
}

const plugin: OpenCodeServerPluginModule = {
  id: PLUGIN_ID,
  server: createKiroServerPlugin,
  setup: createKiroServerPlugin,
};

export default plugin;
