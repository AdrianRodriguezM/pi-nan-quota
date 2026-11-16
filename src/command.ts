// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `/nan-quota`.
 *
 * `renderQuotaReport()` is pure: it turns a snapshot into the text the command
 * appends to the transcript. Keeping it out of the handler is what makes the
 * table testable against the captured fixtures.
 *
 * The table leads with the account's credit balance (the real budget, from
 * the documented `/v1/usage`), then breaks it down per model at each model's
 * price per token. Accounts not billed in credits get the token table only.
 */

import { labelFor } from "./caps.ts";
import { formatCredits, formatResetLong, formatTokens, shortMonthDate } from "./format.ts";
import { renderBar } from "./render/bar.ts";
import type { FetchError, ModelTotals, Snapshot } from "./types.ts";

export const HELP_TEXT = [
  "/nan-quota          credit balance and per-model consumption",
  "/nan-quota refresh  ignore the cache and read the API now",
  "/nan-quota help     this text",
  "",
  "NaN bills one shared pool of credits per billing period, drawn at each",
  "model's price per token; the balance comes from the documented /v1/usage.",
  "",
  "Settings: ~/.pi/agent/nan-quota.json (optional) — alwaysShow, providerId,",
  "glyphs, models, refreshSeconds.",
].join("\n");

/** Where an API key comes from, for the advice lines. */
const KEY_ORIGIN =
  "keys need a plan with credits (nan_member or Premium) or a credit pack; the Community plan includes none";

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
  now: number;
  /** Last failed request, shown as advice instead of being swallowed. */
  error?: FetchError;
  /** Provider whose key reads the data, for the advice lines. */
  provider?: string;
  /** Epoch ms when the last assistant run died on a spent credit pool. */
  creditRunOutAt?: number;
  /** Credits burned since this pi session started (omitted until two readings exist). */
  sessionCredits?: number;
}

/** Sparkline blocks, low to high. */
const SPARK_LEVELS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"] as const;

/** Days shown in the sparkline row. */
const SPARK_DAYS = 7;

/** `▂▅▇▇▃▁▇`: scaled to the max of the shown days; all-zero reads flat-low. */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max <= 0) return SPARK_LEVELS[0].repeat(values.length);
  return values
    .map(
      (value) =>
        SPARK_LEVELS[
          Math.max(0, Math.min(SPARK_LEVELS.length - 1, Math.round((value / max) * (SPARK_LEVELS.length - 1))))
        ],
    )
    .join("");
}

/** Whole days a window spans, inclusive (`Nov 10 → Nov 16` is 7). */
function windowDayCount(snapshot: Snapshot): number {
  const from = Date.parse(`${snapshot.window.startDate}T00:00:00Z`);
  const to = Date.parse(`${snapshot.window.endDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 1;
  return Math.round((to - from) / 86_400_000) + 1;
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

  const credits = snapshot.credits ?? null;
  const modelEntries = Object.entries(snapshot.byModel).sort(([aName, a], [bName, b]) => {
    if (b.credits !== a.credits) return b.credits - a.credits;
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    return aName.localeCompare(bName);
  });
  const noCredits = modelEntries
    .filter(([model, totals]) => totals.credits <= 0 && totals.tokens > 0)
    .map(([model]) => model)
    .sort((a, b) => a.localeCompare(b));

  if (credits === null) {
    // Not billed in credits: tokens are everything the API reports.
    lines.push(`NaN \u00b7 usage, last ${windowDayCount(snapshot)} days (UTC)`);
    lines.push("");
    lines.push(...formatTokenTable(modelEntries));
    lines.push("");
    lines.push("this account is not billed in credits; caps per model are shown in the dashboard");
    lines.push("");
    lines.push(`source: /v1/usage ${snapshot.window.startDate} \u2192 ${snapshot.window.endDate} (UTC days)`);
    if (input.error) lines.push(`last error: ${describeFailure(input.error, input.provider)}`);
    return lines.join("\n");
  }

  const periodEndMs = Date.parse(credits.periodEnd);
  const resetDate = Number.isNaN(periodEndMs) ? credits.periodEnd : shortMonthDate(credits.periodEnd);
  const fix = `buy a credit pack at cloud.nan.builders, or wait for the reset on ${resetDate}`;

  lines.push(
    `NaN \u00b7 billing period ${shortMonthDate(credits.periodStart)} \u2192 ${shortMonthDate(credits.periodEnd)} \u00b7 resets in ${formatResetLong(periodEndMs - now)}`,
  );
  lines.push("");

  const spent = input.creditRunOutAt !== undefined || credits.remaining + credits.packCredits < 1;
  if (credits.frozen) {
    lines.push(`  subscription inactive \u2014 credit requests are refused \u00b7 ${fix}`);
    lines.push("");
  } else if (spent) {
    lines.push(`  credits spent \u2014 ${fix}`);
    lines.push("");
  }

  const percent =
    credits.allowance > 0 ? Math.min(100, Math.max(0, Math.round((credits.remaining / credits.allowance) * 100))) : 0;
  lines.push(
    `  credits  ${renderBar(percent)}  ${formatCredits(credits.remaining)} left of ${formatCredits(credits.allowance)} \u00b7 ${formatCredits(credits.used)} used`,
  );
  lines.push(
    credits.packCredits > 0
      ? `  packs    ${credits.packCredits.toFixed(1)} left \u00b7 expire ${credits.packExpiresAt?.slice(0, 10) ?? "unknown"}`
      : "  packs    none",
  );

  const pace = snapshot.pace;
  if (pace === undefined) {
    lines.push("  pace     too early in the period to project");
  } else if (pace.runsOutAt !== undefined && pace.runsOutBeforeReset) {
    const daysBefore = Math.floor((periodEndMs - pace.runsOutAt) / 86_400_000);
    lines.push(
      `  pace     ~${Math.round(pace.creditsPerDay)} cr/day over the last ${pace.basisDays.toFixed(1)} days \u2192 runs out ~${shortMonthDate(new Date(pace.runsOutAt).toISOString())}, ${daysBefore} days before the reset`,
    );
  } else {
    lines.push(
      `  pace     ~${Math.round(pace.creditsPerDay)} cr/day over the last ${pace.basisDays.toFixed(1)} days \u2192 on pace to last until the reset`,
    );
  }

  if (input.sessionCredits !== undefined) {
    lines.push(`  session  +${input.sessionCredits.toFixed(1)} cr since this pi session started (account-wide, every key)`);
  }

  lines.push("");
  lines.push(...formatModelTable(modelEntries, snapshot.totalCredits));
  if (noCredits.length > 0) lines.push(`  no credits drawn: ${noCredits.join(", ")}`);

  const days = snapshot.daily.slice(-SPARK_DAYS);
  if (days.length > 0) {
    lines.push("");
    // Kept short enough for a 100-column terminal: values only, the span once.
    const values = days.map((day) => Math.round(day.credits)).join(" ");
    const span = `${shortMonthDate(days[0]!.date)} \u2192 ${shortMonthDate(days.at(-1)!.date)}, UTC`;
    lines.push(`  last ${SPARK_DAYS} days  ${sparkline(days.map((day) => day.credits))}  ${values} cr  (${span})`);
  }

  lines.push("");
  lines.push(
    // Rows are whole UTC days while the period starts mid-day, so the first
    // day can carry the previous period's tail: the balance is the reference.
    `source: /v1/usage ${snapshot.window.startDate} \u2192 ${snapshot.window.endDate} (whole UTC days) \u00b7 the balance is authoritative`,
  );
  if (input.error) lines.push(`last error: ${describeFailure(input.error, input.provider)}`);
  return lines.join("\n");
}

interface TableRow {
  name: string;
  credits: string;
  share: string;
  crPerMtok: string;
  cached: string;
  tokens: string;
  req: string;
}

/** The credits breakdown table; empty cells drop their column. */
function formatModelTable(
  entries: readonly (readonly [string, ModelTotals])[],
  totalCredits: number,
): string[] {
  const rows: TableRow[] = entries
    .filter(([, totals]) => totals.credits > 0)
    .map(([model, totals]) => ({
      name: `${model} (${labelFor(model)})`,
      // Fixed one decimal so the column aligns on the point (`2.0`, not `2`).
      credits: totals.credits.toFixed(1),
      share: totalCredits > 0 ? `${Math.round((totals.credits / totalCredits) * 100)}%` : "0%",
      // Below 100k tokens the price per million is noise (a handful of
      // credits over a handful of tokens).
      crPerMtok: totals.tokens >= 1e5 ? (totals.credits / totals.tokens * 1e6).toFixed(2) : "\u2014",
      cached: totals.promptTokens > 0 ? `${Math.round((totals.cachedTokens / totals.promptTokens) * 100)}%` : "\u2014",
      tokens: formatTokens(totals.tokens),
      req: formatTokens(totals.requests),
    }));
  if (rows.length === 0) return ["  no credits drawn in the window"];

  const header: TableRow = {
    name: "model",
    credits: "credits",
    share: "share",
    crPerMtok: "cr/Mtok",
    cached: "cached",
    tokens: "tokens",
    req: "req",
  };
  return padTable([header, ...rows]);
}

/** The tokens-only table for accounts not billed in credits. */
function formatTokenTable(entries: readonly (readonly [string, ModelTotals])[]): string[] {
  const empty = { credits: "", share: "", crPerMtok: "" };
  const rows: TableRow[] = entries.map(([model, totals]) => ({
    name: `${model} (${labelFor(model)})`,
    ...empty,
    cached: totals.promptTokens > 0 ? `${Math.round((totals.cachedTokens / totals.promptTokens) * 100)}%` : "\u2014",
    tokens: formatTokens(totals.tokens),
    req: formatTokens(totals.requests),
  }));
  if (rows.length === 0) return ["  no token consumption in the window"];

  const header: TableRow = {
    name: "model",
    ...empty,
    cached: "cached",
    tokens: "tokens",
    req: "req",
  };
  return padTable([header, ...rows]);
}

/** Align the columns so the table can be read vertically. */
function padTable(rows: readonly TableRow[]): string[] {
  const width = (pick: (row: TableRow) => string) => rows.reduce((max, row) => Math.max(max, pick(row).length), 0);
  const nameW = width((row) => row.name);
  const creditsW = width((row) => row.credits);
  const shareW = width((row) => row.share);
  const crW = width((row) => row.crPerMtok);
  const cachedW = width((row) => row.cached);
  const tokensW = width((row) => row.tokens);
  const reqW = width((row) => row.req);

  return rows.map((row) => {
    const cells = [
      row.name.padEnd(nameW),
      row.credits.padStart(creditsW),
      row.share.padStart(shareW),
      row.crPerMtok.padStart(crW),
      row.cached.padStart(cachedW),
      row.tokens.padStart(tokensW),
      row.req.padStart(reqW),
    ];
    return `  ${cells.filter((cell) => cell !== "").join("  ")}`.trimEnd();
  });
}
