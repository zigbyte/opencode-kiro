/**
 * Reactive Kiro credits state store.
 *
 * Updated from ACP `_kiro.dev/metadata` notifications and `_kiro/account/getUsage`
 * responses. All numeric calculations are NaN/Infinity/negative-safe and clamp
 * percentages cleanly to [0, 100].
 */

import type { KiroCreditsSnapshot } from "../types.ts";

export type KiroCreditsListener = (snapshot: KiroCreditsSnapshot) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNonNegativeNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  return Math.round(value * 100) / 100;
}

function pickNumber(
  sources: Array<Record<string, unknown>>,
  keys: string[]
): number | null {
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

function hasAnyKey(
  sources: Array<Record<string, unknown>>,
  keys: string[]
): boolean {
  for (const src of sources) {
    for (const key of keys) {
      if (Object.hasOwn(src, key) && src[key] !== undefined) {
        return true;
      }
    }
  }
  return false;
}

function pickString(
  sources: Array<Record<string, unknown>>,
  keys: string[]
): string | null {
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

function collectSources(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const sources: Array<Record<string, unknown>> = [payload];
  for (const nestedKey of ["credits", "usage", "subscription", "plan", "account", "metadata"]) {
    const nested = payload[nestedKey];
    if (isRecord(nested)) {
      sources.push(nested);
    }
  }
  return sources;
}

function createInitialSnapshot(): KiroCreditsSnapshot {
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
    source: "initial",
  };
}

export class KiroCreditsStore {
  private snapshot: KiroCreditsSnapshot;
  private readonly listeners = new Set<KiroCreditsListener>();

  constructor(initial?: Partial<KiroCreditsSnapshot>) {
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
    const percentUsed =
      rawPercent !== null
        ? clampPercent(rawPercent)
        : limit !== null
          ? clampPercent((used / limit) * 100)
          : null;
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
      source: initial.source ?? base.source,
    };
  }

  getSnapshot(): KiroCreditsSnapshot {
    return { ...this.snapshot };
  }

  updateFromMetadata(payload: Record<string, unknown>): KiroCreditsSnapshot {
    return this.applyUpdate(payload, "acp_metadata");
  }

  updateFromUsage(payload: Record<string, unknown>): KiroCreditsSnapshot {
    return this.applyUpdate(payload, "acp_usage");
  }

  setActiveModel(modelId: string | null): KiroCreditsSnapshot {
    const normalized = modelId ? toNonEmptyString(modelId) : null;
    this.snapshot = {
      ...this.snapshot,
      activeModel: normalized,
      updatedAt: new Date().toISOString(),
    };
    this.emit();
    return this.getSnapshot();
  }

  subscribe(listener: KiroCreditsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clearListeners(): void {
    this.listeners.clear();
  }

  private applyUpdate(
    payload: Record<string, unknown>,
    source: "acp_metadata" | "acp_usage"
  ): KiroCreditsSnapshot {
    const sources = isRecord(payload) ? collectSources(payload) : [];
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
    let nextLimit: number | null;
    if (limitProvided) {
      // Treat 0, negative, NaN, or null as unlimited/unknown (null)
      nextLimit = parsedLimit !== null && parsedLimit > 0 ? parsedLimit : null;
    } else {
      nextLimit = prev.limit;
    }

    const parsedUsed = pickNumber(sources, rawUsedKeys);
    const parsedRemaining = pickNumber(sources, rawRemainingKeys);

    // kiro-cli 3.6+ emits per-turn credit metering in `_kiro.dev/metadata`:
    // `meteringUsage: [{ value: 0.0315, unit: "credit", unitPlural: "credits" }]`
    let meteredTurnCredits: number | null = null;
    for (const src of sources) {
      if (Object.hasOwn(src, "meteringUsage") && Array.isArray(src.meteringUsage)) {
        let turnSum = 0;
        let foundCreditEntry = false;
        for (const item of src.meteringUsage) {
          if (!isRecord(item)) continue;
          const unit = typeof item.unit === "string" ? item.unit.toLowerCase() : "";
          const unitPlural =
            typeof item.unitPlural === "string" ? item.unitPlural.toLowerCase() : "";
          if (unit === "credit" || unit === "credits" || unitPlural === "credits") {
            const val = toNonNegativeNumber(item.value);
            if (val !== null) {
              turnSum += val;
              foundCreditEntry = true;
            }
          }
        }
        if (foundCreditEntry) {
          meteredTurnCredits = Math.round(turnSum * 10000) / 10000;
          break;
        }
      }
    }

    let nextUsed = prev.used;
    if (parsedUsed !== null) {
      nextUsed = parsedUsed;
    } else if (nextLimit !== null && parsedRemaining !== null) {
      nextUsed = Math.max(0, Math.round((nextLimit - parsedRemaining) * 10000) / 10000);
    } else if (meteredTurnCredits !== null) {
      nextUsed = Math.round((prev.used + meteredTurnCredits) * 10000) / 10000;
    }

    let nextRemaining: number | null;
    if (parsedRemaining !== null) {
      nextRemaining = parsedRemaining;
    } else if (nextLimit !== null && nextLimit > 0) {
      nextRemaining = Math.max(0, Math.round((nextLimit - nextUsed) * 10000) / 10000);
    } else if (limitProvided) {
      nextRemaining = null;
    } else {
      nextRemaining = prev.remaining;
    }

    const parsedAddon = pickNumber(sources, rawAddonKeys);
    const nextAddon =
      parsedAddon !== null
        ? parsedAddon
        : hasAnyKey(sources, rawAddonKeys)
          ? null
          : (prev.addonRemaining ?? null);

    const rawPercentKeys = ["percentUsed", "usagePercent"];
    let nextPercentUsed: number | null = null;
    if (nextLimit !== null && nextLimit > 0) {
      nextPercentUsed = clampPercent((nextUsed / nextLimit) * 100);
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
    const nextContext =
      parsedContext !== null ? clampPercent(parsedContext) : prev.contextUsagePercent;

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
      source,
    };

    this.emit();
    return this.getSnapshot();
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch {
        // Isolate subscriber failures so store updates never break ACP event flow
      }
    }
  }
}
