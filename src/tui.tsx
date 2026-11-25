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
  tui: TuiPlugin;
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

  return {
    id: PLUGIN_ID,
    tui,
  };
}

const kiroTuiPlugin: TuiPluginModule = createKiroTuiPlugin();

export const tui: TuiPlugin = kiroTuiPlugin.tui;

export default kiroTuiPlugin;
