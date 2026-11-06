// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `/nan-quota`.
 *
 * `renderQuotaReport()` is pure: it turns a snapshot plus an optional usage
 * report into the text the command appends to the transcript. Keeping it out of
 * the handler is what makes the table testable against the captured fixtures.
 */

import { CAPS, CAPS_AS_OF } from "./caps.ts";
import { formatPercent, formatResetLong, formatTokens } from "./format.ts";
import { canonicalModelId } from "./models.ts";
import { renderBar } from "./render/bar.ts";
import type { FetchError, ModelQuota, Snapshot, UsageReport } from "./types.ts";

export const HELP_TEXT = [
  "/nan-quota          quota table for the current billing period",
  "/nan-quota refresh  ignore the cache and read the API now",
  "/nan-quota help     this text",
  "",
  "Settings: ~/.pi/agent/nan-quota.json (optional) — warnAt, criticalAt, maxAlerts,",
  "alwaysShow, providerId, glyphs, quotaEndpoint, models, refreshSeconds.",
].join("\n");

/** Where an API key comes from, for the advice lines. */
const KEY_ORIGIN =
  "keys come with a NaN inference plan (member or GLM 5.3 premium); the Community plan has no API access";

/**
 * Word a failure for the user, with the fix when there is one. The key itself
 * never reaches this function's output.
 */
export function describeFailure(failure: FetchError, provider = "nan"): string {
  if (failure.kind === "auth") {
    if (failure.status === undefined) {
      return `no API key for provider "${provider}": run /login ${provider} or set NAN_API_KEY (${KEY_ORIGIN})`;
    }
    return `${failure.message}. Check it at cloud.nan.builders → Settings → API Keys (${KEY_ORIGIN})`;
  }
  if (failure.kind === "rate-limit") return `${failure.message}; retrying later`;
  return failure.message;
}

export interface QuotaCommandInput {
  snapshot?: Snapshot;
  usage?: UsageReport;
  now: number;
  /** Date of the fallback caps table, for the estimated footer. */
  capsAsOf?: string;
  /** Last failed request, shown as advice instead of being swallowed. */
  error?: FetchError;
  /** Provider whose key reads the quota, for the advice lines. */
  provider?: string;
}

interface Row {
  name: string;
  bar: string;
  percent: string;
  used: string;
  cap: string;
  free: string;
  extra: string;
}

/** Render the whole command output. Never throws on partial data. */
export function renderQuotaReport(input: QuotaCommandInput): string {
  const { snapshot, now } = input;
  const lines: string[] = [];

  if (!snapshot) {
    lines.push("NaN \u00b7 no data yet");
    if (input.error) {
      lines.push("");
      lines.push(describeFailure(input.error, input.provider));
    }
    return lines.join("\n");
  }

  const estimated = snapshot.estimated || snapshot.source === "usage";
  const periodStart = snapshot.periodStart ?? "\u2026";
  const periodEnd = snapshot.periodEnd;
  const resetAt = periodEnd ? Date.parse(periodEnd) : Number.NaN;
  const period = `NaN \u00b7 period ${periodStart} \u2192 ${periodEndDay(periodEnd)}`;
  lines.push(Number.isNaN(resetAt) ? period : `${period} (resets in ${formatResetLong(resetAt - now)})`);
  lines.push("");

  const capped = snapshot.models.filter((model) => model.cap > 0);
  const rows = orderModels(capped).map((model) => buildRow(model, estimated));
  if (rows.length > 0) lines.push(...formatRows(rows));
  else lines.push("  no capped model on this key");

  const usage = input.usage ?? snapshot.usage;
  const others = describeOtherModels(snapshot, usage);
  if (others) {
    lines.push("");
    lines.push(others);
  }

  const usageLine = describeUsage(usage);
  if (usageLine) {
    lines.push("");
    lines.push(usageLine);
  }

  lines.push("");
  lines.push(describeSource(snapshot, estimated, input.capsAsOf ?? CAPS_AS_OF));
  if (input.error) lines.push(`last error: ${describeFailure(input.error, input.provider)}`);
  return lines.join("\n");
}

/** Table order follows the docs table; models it does not list go last. */
function orderModels(models: readonly ModelQuota[]): ModelQuota[] {
  const rank = new Map(CAPS.map((entry, index) => [entry.model, index]));
  return [...models].sort((a, b) => {
    const left = rank.get(canonicalModelId(a.model)) ?? Number.MAX_SAFE_INTEGER;
    const right = rank.get(canonicalModelId(b.model)) ?? Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    return a.model.localeCompare(b.model);
  });
}

function buildRow(model: ModelQuota, estimated: boolean): Row {
  const percent = formatPercent(model.tokensUsed, model.cap);
  return {
    name: model.model,
    bar: renderBar(model.tokensUsed / model.cap),
    percent: `${estimated ? "~" : ""}${percent}%`,
    used: formatTokens(model.tokensUsed),
    cap: formatTokens(model.cap),
    free: formatTokens(Math.max(0, model.remaining)),
    extra: [describeExtra(model), describeWindow(model)].filter(Boolean).join("   "),
  };
}

/** `+125M extra until 2027-04-29`, or why the pool cannot be used. */
function describeExtra(model: ModelQuota): string {
  if (!model.extraTokens || model.extraTokens <= 0) return "";
  const amount = `+${formatTokens(model.extraTokens)} extra`;
  if (model.extraUsable === false) return `${amount} (paused: needs an active membership)`;
  const expiry = model.extraExpiresAt?.slice(0, 10);
  return expiry ? `${amount} until ${expiry}` : amount;
}

/** `4h window: 400M`, plus its use when the server reports it. */
function describeWindow(model: ModelQuota): string {
  if (!model.windowHours || !model.fullWindowTokens) return "";
  const size = `${model.windowHours}h window: ${formatTokens(model.fullWindowTokens)}`;
  if (model.windowTokensUsed === undefined) return size;
  return `${size} (${formatPercent(model.windowTokensUsed, model.fullWindowTokens)}% used)`;
}

/** Align the numeric columns so the table can be read vertically. */
function formatRows(rows: readonly Row[]): string[] {
  const width = (values: readonly string[]) => values.reduce((max, value) => Math.max(max, value.length), 0);
  const nameWidth = width(rows.map((row) => row.name));
  const percentWidth = width(rows.map((row) => row.percent));
  const usedWidth = width(rows.map((row) => row.used));
  const capWidth = width(rows.map((row) => row.cap));
  const freeWidth = width(rows.map((row) => row.free));

  return rows.map((row) => {
    const head = `  ${row.name.padEnd(nameWidth)}  ${row.bar}  ${row.percent.padStart(percentWidth)}`;
    const usage = `${row.used.padStart(usedWidth)} / ${row.cap.padEnd(capWidth)}`;
    const rest = `  ${row.free.padStart(freeWidth)} free`;
    const extra = row.extra ? `   ${row.extra}` : "";
    return `${head}   ${usage}${rest}${extra}`.trimEnd();
  });
}

/**
 * `other models this month: qwen3.6 427 · gemma4 135` — models with traffic
 * and no cap on this key (no quota row, or `cap: 0`). Wording stays neutral:
 * the usage report counts tokens, and some endpoints (images) are limited by
 * requests in pools the quota report does not expose.
 */
function describeOtherModels(snapshot: Snapshot, usage: UsageReport | undefined): string | undefined {
  const capped = new Set(snapshot.models.filter((model) => model.cap > 0).map((model) => canonicalModelId(model.model)));
  const amounts = new Map<string, number>();
  for (const model of snapshot.models) {
    if (model.cap <= 0 && model.tokensUsed > 0) amounts.set(canonicalModelId(model.model), model.tokensUsed);
  }
  for (const [model, tokens] of Object.entries(usage?.byModel ?? {})) {
    const id = canonicalModelId(model);
    if (!capped.has(id) && tokens > 0) amounts.set(id, tokens);
  }
  if (amounts.size === 0) return undefined;
  const parts = [...amounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([model, tokens]) => `${model} ${formatTokens(tokens)}`);
  return `other models this month: ${parts.join(" \u00b7 ")}`;
}

/** `2026-12-01T00:00:00Z` -> `2026-12-01`. */
function periodEndDay(periodEnd: string | undefined): string {
  if (!periodEnd) return "\u2026";
  return periodEnd.slice(0, 10);
}

function describeUsage(usage: UsageReport | undefined): string | undefined {
  if (!usage) return undefined;
  const parts = [`month: ${formatTokens(usage.totalTokens)}`];
  if (usage.allTimeTokens !== undefined) parts.push(`total: ${formatTokens(usage.allTimeTokens)}`);
  if (usage.requests > 0) parts.push(`${formatTokens(usage.requests)} requests`);
  return parts.join(" \u00b7 ");
}

function describeSource(snapshot: Snapshot, estimated: boolean, capsAsOf: string): string {
  if (estimated) {
    const off = snapshot.quotaEndpointDisabled ? " \u00b7 quota endpoint off" : "";
    return `source: /v1/usage + the docs caps (${capsAsOf}, estimated ~)${off}`;
  }
  const updated = snapshot.updatedAt ? utcClock(snapshot.updatedAt) : undefined;
  return updated ? `source: quota (server) \u00b7 updated ${updated} UTC` : "source: quota (server)";
}

/** `2026-11-06T20:48:17Z` -> `20:48`. */
function utcClock(iso: string): string | undefined {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  const date = new Date(at);
  return `${`${date.getUTCHours()}`.padStart(2, "0")}:${`${date.getUTCMinutes()}`.padStart(2, "0")}`;
}
