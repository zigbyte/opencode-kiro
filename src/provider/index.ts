/**
 * Barrel exports for the `opencode-kiro/provider` entrypoint.
 */

export {
  KiroProviderOwnershipError,
  assertKiroProviderOwnership,
  isKiroModelId,
  stripKiroPrefix,
  applyKiroProviderConfig,
} from "./ownership.ts";

export {
  KiroAcpLanguageModel,
  createKiroProvider,
  convertPromptToAcpBlocks,
  mapAcpStopReason,
  type KiroPromptPart,
  type KiroPromptMessage,
  type KiroCallOptions,
  type KiroFinishReason,
  type KiroUsage,
  type KiroToolCall,
  type KiroGenerateResult,
  type KiroStreamPart,
  type KiroStreamResult,
  type KiroAcpClientLike,
  type KiroProviderDeps,
  type KiroProviderInstance,
} from "./language-model.ts";
