/**
 * Pure formatting and sanitization utilities for the Kiro TUI credits display.
 *
 * Security invariant: All display strings pass through `sanitizeDisplayText`
 * to strip terminal escape sequences and redact any accidental token-like strings.
 */

import type { KiroAuthStatus, KiroCreditsSnapshot } from "../types";

export type CreditSeverity = "normal" | "warning" | "critical" | "unknown";

const ANSI_OSC_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_CSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_C1_CSI_REGEX = /\x9b[0-9;?]*[ -/]*[@-~]/g;
const ANSI_ESC_REGEX = /\x1b[@-Z\\-_]/g;
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g;

const BEARER_TOKEN_REGEX = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT_REGEX =
  /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const PREFIXED_KEY_REGEX =
  /\b(?:sk|pk|kiro)-[A-Za-z0-9_-]{8,}\b/gi;
const AWS_KEY_REGEX = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const GITHUB_TOKEN_REGEX = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g;
const SECRET_KV_REGEX =
  /((?:["']?[A-Za-z0-9_]*?(?:access_?token|refresh_?token|id_?token|api_?key|secret(?:_?(?:access_?)?key)?))["']?\s*[:=]\s*)(["']?)[A-Za-z0-9._~+/=-]{8,}\2/gi;

/**
 * Strips ANSI escape sequences (7-bit & 8-bit C1) and control characters,
 * and redacts any token-like substrings so secrets can never be rendered in the TUI.
 */
export function sanitizeDisplayText(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }

  return text
    .replace(/\r\n?/g, "\n")
    .replace(ANSI_OSC_REGEX, "")
    .replace(ANSI_CSI_REGEX, "")
    .replace(ANSI_C1_CSI_REGEX, "")
    .replace(ANSI_ESC_REGEX, "")
    .replace(CONTROL_CHARS_REGEX, "")
    .replace(BEARER_TOKEN_REGEX, "Bearer [REDACTED]")
    .replace(JWT_REGEX, "[REDACTED_JWT]")
    .replace(PREFIXED_KEY_REGEX, "[REDACTED]")
    .replace(AWS_KEY_REGEX, "[REDACTED]")
    .replace(GITHUB_TOKEN_REGEX, "[REDACTED]")
    .replace(SECRET_KV_REGEX, "$1$2[REDACTED]$2");
}

function sanitizeSingleLine(text: string): string {
  return sanitizeDisplayText(text).replace(/\s*\n\s*/g, " ").trim();
}

/**
 * Computes the visual severity level for a Kiro credits snapshot.
 */
export function computeCreditSeverity(
  snapshot: KiroCreditsSnapshot
): CreditSeverity {
  const hasValidLimit =
    snapshot.limit != null &&
    Number.isFinite(snapshot.limit) &&
    snapshot.limit > 0;

  const exhausted =
    hasValidLimit &&
    ((snapshot.remaining != null &&
      Number.isFinite(snapshot.remaining) &&
      snapshot.remaining <= 0) ||
      (Number.isFinite(snapshot.used) && snapshot.used >= snapshot.limit!));

  if (snapshot.percentUsed == null || !Number.isFinite(snapshot.percentUsed)) {
    return exhausted ? "critical" : "unknown";
  }

  if (snapshot.percentUsed >= 95 || exhausted) {
    return "critical";
  }

  if (snapshot.percentUsed >= 80) {
    return "warning";
  }

  return "normal";
}

/**
 * Safely formats a numeric credit value:
 * - NaN / Infinity / overflowing values -> "--"
 * - Integers without trailing `.0`
 * - Decimals rounded to 1 decimal place
 * - Thousands separated with commas
 */
export function formatCreditsNumber(val: number): string {
  if (
    typeof val !== "number" ||
    !Number.isFinite(val) ||
    Math.abs(val) >= 1e15
  ) {
    return "--";
  }

  if (val > 0 && val < 0.1) {
    const subRounded = Math.round(val * 10000) / 10000;
    const subNormalized = Object.is(subRounded, -0) ? 0 : subRounded;
    if (subNormalized === 0) return "0";
    return subNormalized.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }

  const scaled = val * 10;
  if (!Number.isFinite(scaled)) {
    return "--";
  }

  const rounded = Math.round(scaled) / 10;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  const negative = normalized < 0;
  const abs = Math.abs(normalized);
  const isInt = Math.abs(abs - Math.round(abs)) < 1e-9;
  const fixed = isInt ? String(Math.round(abs)) : abs.toFixed(1);
  const parts = fixed.split(".");
  const intPart = parts[0] ?? "0";
  const decPart = parts[1];
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return `${negative ? "-" : ""}${decPart !== undefined ? `${withCommas}.${decPart}` : withCommas}`;
}

/**
 * Renders a Unicode block progress bar safely clamped to [0, 100].
 * Never throws or produces negative repeat counts on NaN/Infinity/null inputs.
 */
export function renderProgressBar(
  percent: number | null,
  width = 16
): string {
  const safeWidth =
    typeof width === "number" && Number.isFinite(width)
      ? Math.max(1, Math.min(64, Math.floor(width)))
      : 16;

  if (percent == null || typeof percent !== "number" || !Number.isFinite(percent)) {
    return `[${"░".repeat(safeWidth)}]`;
  }

  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.max(
    0,
    Math.min(safeWidth, Math.round((clamped / 100) * safeWidth))
  );
  const empty = Math.max(0, safeWidth - filled);

  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

/**
 * Safely formats an ISO-8601 reset date string, including a relative countdown
 * when the reset date is in the near future. Returns "" for null or invalid dates.
 */
export function formatResetDate(
  resetAt: string | null,
  nowMs: number = Date.now()
): string {
  if (!resetAt || typeof resetAt !== "string") {
    return "";
  }

  const trimmed = resetAt.trim();
  if (!trimmed) {
    return "";
  }

  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const date = new Date(timestamp);
  const isoDate = date.toISOString().slice(0, 10);

  if (Number.isFinite(nowMs)) {
    const diffMs = timestamp - nowMs;
    if (diffMs > 0) {
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      if (hours < 24) {
        return `in ${Math.max(1, hours)}h (${isoDate})`;
      }
      const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      if (days <= 60) {
        return `in ${days}d (${isoDate})`;
      }
    }
  }

  return isoDate;
}

/**
 * Formats a compact single-line badge suitable for `sidebar_footer` or `app_bottom`.
 */
export function formatCreditsCompact(
  snapshot: KiroCreditsSnapshot,
  auth?: KiroAuthStatus | null
): string {
  if (auth) {
    if (!auth.cliAvailable) {
      return "Kiro: CLI not found";
    }
    if (!auth.authenticated) {
      return "Kiro: Not logged in (run /kiro-login)";
    }
  }

  if (
    snapshot.limit != null &&
    Number.isFinite(snapshot.limit) &&
    snapshot.limit > 0
  ) {
    const usedStr = formatCreditsNumber(snapshot.used);
    const limitStr = formatCreditsNumber(snapshot.limit);
    const pctStr =
      snapshot.percentUsed != null && Number.isFinite(snapshot.percentUsed)
        ? ` (${Math.round(Math.max(0, Math.min(100, snapshot.percentUsed)))}%)`
        : "";
    return sanitizeDisplayText(`Kiro: ${usedStr}/${limitStr} cr${pctStr}`);
  }

  if (snapshot.source !== "initial" && Number.isFinite(snapshot.used)) {
    return sanitizeDisplayText(
      `Kiro: ${formatCreditsNumber(snapshot.used)} cr used`
    );
  }

  return "Kiro: -- cr";
}

/**
 * Formats a multi-line detail view for `sidebar_content` and `/kiro-credits`.
 */
export function formatCreditsPanelLines(
  snapshot: KiroCreditsSnapshot,
  auth?: KiroAuthStatus | null
): string[] {
  const lines: string[] = [];

  const planLabel = snapshot.planName ? sanitizeSingleLine(snapshot.planName) : "";
  const planSuffix = planLabel ? ` (${planLabel})` : "";
  lines.push(`Kiro Credits${planSuffix}`);

  if (auth) {
    if (!auth.cliAvailable) {
      lines.push("Status: kiro-cli not found");
      lines.push("Install kiro-cli and ensure it is available on PATH.");
      return lines.map(sanitizeDisplayText);
    }
    if (!auth.authenticated) {
      lines.push("Status: Not logged in");
      lines.push("Run /kiro-login or 'kiro-cli login' to authenticate.");
      return lines.map(sanitizeDisplayText);
    }
  }

  const pctText =
    snapshot.percentUsed != null && Number.isFinite(snapshot.percentUsed)
      ? `${Math.round(Math.max(0, Math.min(100, snapshot.percentUsed)))}%`
      : "--%";

  lines.push(`Usage: ${renderProgressBar(snapshot.percentUsed, 16)} ${pctText}`);

  if (
    snapshot.limit != null &&
    Number.isFinite(snapshot.limit) &&
    snapshot.limit > 0
  ) {
    const rawRemaining =
      snapshot.remaining != null && Number.isFinite(snapshot.remaining)
        ? snapshot.remaining
        : snapshot.limit - snapshot.used;
    const remaining = Number.isFinite(rawRemaining)
      ? Math.max(0, rawRemaining)
      : 0;
    lines.push(
      `Credits: ${formatCreditsNumber(snapshot.used)} / ${formatCreditsNumber(snapshot.limit)} (${formatCreditsNumber(remaining)} remaining)`
    );
  } else if (snapshot.source !== "initial" && Number.isFinite(snapshot.used)) {
    lines.push(`Credits: ${formatCreditsNumber(snapshot.used)} used`);
  } else {
    lines.push("Credits: --");
  }

  if (
    snapshot.addonRemaining != null &&
    Number.isFinite(snapshot.addonRemaining)
  ) {
    lines.push(
      `Add-on Pool: ${formatCreditsNumber(Math.max(0, snapshot.addonRemaining))} remaining`
    );
  }

  if (
    snapshot.lastTurnCredits != null &&
    Number.isFinite(snapshot.lastTurnCredits)
  ) {
    lines.push(`Last Turn: ${formatCreditsNumber(snapshot.lastTurnCredits)} cr`);
  }

  if (
    snapshot.contextUsagePercent != null &&
    Number.isFinite(snapshot.contextUsagePercent)
  ) {
    const ctxPct = Math.round(
      Math.max(0, Math.min(100, snapshot.contextUsagePercent))
    );
    lines.push(`Context: ${ctxPct}%`);
  }

  if (snapshot.activeModel) {
    const modelLabel = sanitizeSingleLine(snapshot.activeModel);
    if (modelLabel) {
      lines.push(`Model: ${modelLabel}`);
    }
  }

  const resetFormatted = formatResetDate(snapshot.resetAt);
  if (resetFormatted) {
    lines.push(`Resets: ${resetFormatted}`);
  }

  if (auth?.accountLabel) {
    const accountLabel = sanitizeSingleLine(auth.accountLabel);
    if (accountLabel) {
      lines.push(`Account: ${accountLabel}`);
    }
  }

  return lines.map(sanitizeDisplayText);
}

/**
 * Creates a clean initial credits snapshot before RPC data arrives.
 */
export function createInitialCreditsSnapshot(): KiroCreditsSnapshot {
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
