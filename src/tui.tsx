/**
 * OpenCode 2.x TUI plugin entrypoint (`opencode-kiro/tui`).
 *
 * Registers Kiro credits display slots (`sidebar_footer`, `sidebar_content`,
 * `app_bottom`) and slash commands (`/kiro-credits`, `/kiro-login`,
 * `/kiro-models`, `/kiro-status`), backed by the typed `./rpc` contract.
 *
 * Uses structured OpenTUI-compatible render descriptors so typechecking passes
 * cleanly even when `@opentui/solid` is not installed locally.
 */

import { createKiroRpcClient } from "./rpc";
import { PLUGIN_ID } from "./types";
import {
  KiroTuiController,
  createKiroTuiCommands,
  type KiroTuiState,
  type KiroTuiStateListener,
  type TuiCommandDefinition,
  type TuiPluginApi,
  type TuiPluginOptions,
  type TuiRenderNode,
  type TuiSlotName,
  type TuiSlotRegistration,
  type TuiToastOptions,
  type TuiToastVariant,
} from "./tui/widget";

export {
  computeCreditSeverity,
  createInitialCreditsSnapshot,
  formatCreditsCompact,
  formatCreditsNumber,
  formatCreditsPanelLines,
  formatResetDate,
  renderProgressBar,
  sanitizeDisplayText,
  type CreditSeverity,
} from "./tui/format";

export {
  KiroTuiController,
  createKiroTuiCommands,
  type KiroTuiState,
  type KiroTuiStateListener,
  type TuiCommandDefinition,
  type TuiPluginApi,
  type TuiPluginOptions,
  type TuiRenderNode,
  type TuiSlotName,
  type TuiSlotRegistration,
  type TuiToastOptions,
  type TuiToastVariant,
};

export interface TuiPluginHandle {
  controller: KiroTuiController;
  dispose: () => void;
}

export type TuiPlugin = (
  api: TuiPluginApi,
  options?: TuiPluginOptions
) => TuiPluginHandle;

export interface TuiPluginModule {
  id: string;
  setup: (ctx: unknown, options?: TuiPluginOptions) => Promise<(() => void) | void> | (() => void) | void;
  tui: TuiPlugin;
}

interface OpenCodeV2TuiContext {
  options?: Readonly<Record<string, unknown>>;
  ui?: {
    toast?: {
      show?: (opts: {
        title?: string;
        message: string;
        variant?: "info" | "success" | "warning" | "error";
      }) => void;
    };
    model?: {
      current?: () => { providerID: string; modelID: string } | undefined;
    };
    slot?: (claim: Record<string, unknown>) => () => void;
  };
  data?: {
    on?: (type: string, handler: (event: unknown) => void) => () => void;
  };
  keymap?: {
    layer?: (factory: () => Record<string, unknown>) => void;
  };
}

function isOpenCodeV2TuiContext(ctx: unknown): ctx is OpenCodeV2TuiContext {
  if (!ctx || typeof ctx !== "object") return false;
  const candidate = ctx as OpenCodeV2TuiContext;
  return (
    typeof candidate.ui?.slot === "function" ||
    typeof candidate.ui?.toast?.show === "function" ||
    typeof candidate.data?.on === "function"
  );
}

/**
 * Native OpenCode 2.3+ V2 TUI plugin setup (`@opencode/plugin/tui` `Definition`).
 */
function setupOpenCodeV2Tui(ctx: OpenCodeV2TuiContext): () => void {
  const disposers: Array<() => void> = [];
  let activeModel: string | null = null;

  const updateActiveModel = () => {
    try {
      const current = ctx.ui?.model?.current?.();
      if (current?.providerID === "kiro") {
        activeModel = current.modelID;
      }
    } catch {
      // Ignore reactive read errors outside Solid tracking scopes.
    }
  };

  updateActiveModel();

  if (typeof ctx.data?.on === "function") {
    try {
      const unsub = ctx.data.on("session.status", () => {
        updateActiveModel();
      });
      if (typeof unsub === "function") {
        disposers.push(unsub);
      }
    } catch {
      // Ignore if event type is unavailable in host build.
    }
  }

  if (typeof ctx.keymap?.layer === "function") {
    try {
      ctx.keymap.layer(() => ({
        commands: [
          {
            id: "opencode-kiro.status",
            title: "Kiro: Show Status & Credits",
            category: "Kiro",
            onSelect: () => {
              updateActiveModel();
              ctx.ui?.toast?.show?.({
                title: "Kiro (ACP)",
                message: activeModel
                  ? `Active model: kiro/${activeModel} (auth managed by kiro-cli)`
                  : "Kiro provider ready via kiro-cli ACP. Select any kiro/* model.",
                variant: "info",
              });
            },
          },
        ],
      }));
    } catch {
      // Ignore if host keymap schema differs.
    }
  }

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // Ignore cleanup errors on teardown.
      }
    }
  };
}

/**
 * Factory creating an OpenCode 2.x TUI plugin module for `opencode-kiro`.
 */
export function createKiroTuiPlugin(
  defaultOptions?: TuiPluginOptions
): TuiPluginModule {
  const tui: TuiPlugin = (api, options) => {
    const mergedOptions: TuiPluginOptions = {
      ...defaultOptions,
      ...options,
    };

    const rpc = api?.rpc ? createKiroRpcClient(api.rpc) : null;
    const controller = new KiroTuiController(rpc, {
      pollIntervalMs: mergedOptions.pollIntervalMs,
    });

    const cleanups: Array<() => void> = [];

    if (api?.slots?.register) {
      for (const registration of controller.createSlotRegistrations()) {
        const unregister = api.slots.register(registration);
        if (typeof unregister === "function") {
          cleanups.push(unregister);
        }
      }
    }

    if (api?.command?.register) {
      for (const command of createKiroTuiCommands(controller, api)) {
        const unregister = api.command.register(command);
        if (typeof unregister === "function") {
          cleanups.push(unregister);
        }
      }
    }

    if (api?.events?.on) {
      const refreshOnEvent = () => {
        if (!controller.isDisposed) {
          void controller.refreshCredits(false);
        }
      };

      const unsubCredits = api.events.on(
        "kiro.credits.updated",
        refreshOnEvent
      );
      if (typeof unsubCredits === "function") {
        cleanups.push(unsubCredits);
      }

      const unsubIdle = api.events.on("session.idle", refreshOnEvent);
      if (typeof unsubIdle === "function") {
        cleanups.push(unsubIdle);
      }
    }

    if (mergedOptions.autoRefresh !== false && rpc) {
      void controller.refreshAll();
    }

    if (rpc && mergedOptions.pollIntervalMs !== 0) {
      controller.startPolling(mergedOptions.pollIntervalMs);
    }

    let disposed = false;
    const dispose = (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch {
          // Ignore individual unregister errors during teardown.
        }
      }
      controller.dispose();
    };

    return {
      controller,
      dispose,
    };
  };

  const setup: TuiPluginModule["setup"] = (ctx, options) => {
    if (isOpenCodeV2TuiContext(ctx)) {
      return setupOpenCodeV2Tui(ctx);
    }
    const handle = tui(ctx as TuiPluginApi, options);
    return handle.dispose;
  };

  return {
    id: PLUGIN_ID,
    setup,
    tui,
  };
}

const kiroTuiPlugin: TuiPluginModule = createKiroTuiPlugin();

export const setup: TuiPluginModule["setup"] = kiroTuiPlugin.setup;
export const tui: TuiPlugin = kiroTuiPlugin.tui;

export default kiroTuiPlugin;
