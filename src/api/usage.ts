// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The documented usage endpoint.
 *
 * `GET https://api.nan.builders/v1/usage?start_date=…&end_date=…&limit=…`
 * reports consumption per (date, model) for a window of UTC days (max 90
 * days, 30 req/min, cursor-paginated) plus, since NaN moved to the shared
 * credit pool, the account's credit balance for the billing period — the real
 * budget, regardless of the window requested.
 *
 * The extension asks for the widest window it ever needs (the billing period
 * or the last 30 days, see {@link usageWindow}) with `limit=500` and follows
 * `next_cursor` so the daily rows arrive complete.
 */

import { canonicalModelId } from "../models.ts";
import { FetchError, type CreditBalance, type DailyCredits, type ModelTotals, type UsageReport } from "../types.ts";
import { assertOk, requestHeaders } from "./http.ts";

export const USAGE_URL = "https://api.nan.builders/v1/usage";

/**
 * First UTC day whose rows carry credits (the pool went live on 2026-11-09;
 * rows are billed from the 10th). Windows never start before it: earlier days
 * would report zero credits and skew the pace projection.
 */
export const CREDITS_BILLED_SINCE = "2026-11-10";

/** Page size: the documented maximum, so pagination is the exception. */
const PAGE_LIMIT = 500;
/** Pages followed per read; a guard against a runaway cursor, not a quota. */
const MAX_PAGES = 4;

const DAY_MS = 24 * 60 * 60_000;

const schemaError = (detail: string) => new FetchError("schema", `usage: ${detail}`);

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw schemaError(`${path} is not an object`);
  }
  return value as Record<string, unknown>;
}

function optionalNumber(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `YYYY-MM-DD` for an epoch timestamp, in UTC. */
export function utcDate(ms: number): string {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** `YYYY-MM-DD` part of a date or ISO timestamp string. */
function dayOf(value: string): string {
  return value.slice(0, 10);
}

function addDays(date: string, days: number): string {
  return utcDate(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
}

export interface UsageWindow {
  startDate: string;
  endDate: string;
}

/**
 * The window to request, as a pure function of the clock.
 *
 * End is always today (UTC). Start is the billing period's first day when it
 * is known and still running — the balance covers the period, so the rows
 * should too — clamped to {@link CREDITS_BILLED_SINCE}; otherwise the last
 * 30 days (inclusive), again clamped; when the response reveals a longer
 * period, the loader re-requests with the period's own window. The
 * clamp keeps every window ≤ 90 days (the API's maximum) and free of
 * credit-less days.
 */
export function usageWindow(now: number, knownPeriodStart?: string): UsageWindow {
  const end = utcDate(now);
  let start: string;
  const known = knownPeriodStart?.trim();
  if (known !== undefined && known !== "") {
    start = maxDay(dayOf(known), CREDITS_BILLED_SINCE);
  } else {
    start = maxDay(addDays(end, -29), CREDITS_BILLED_SINCE);
  }
  // A clock barely past the epoch of credit billing must not ask for a
  // negative window.
  if (start > end) start = end;
  return { startDate: start, endDate: end };
}

function maxDay(a: string, b: string): string {
  return a >= b ? a : b;
}

/** Request URL for a window (and page). */
export function usageUrl(startDate: string, endDate: string, cursor?: string): string {
  const params = new URLSearchParams({ start_date: startDate, end_date: endDate, limit: `${PAGE_LIMIT}` });
  if (cursor !== undefined && cursor !== "") params.set("cursor", cursor);
  return `${USAGE_URL}?${params.toString()}`;
}

/**
 * Validate the `credits` object: finite allowance/used/remaining and parsable
 * ISO period bounds, else null (an account not billed in credits answers
 * `null`, and a malformed object is treated the same way rather than trusted).
 */
function parseCredits(value: unknown): CreditBalance | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowance = optionalNumber(record, "allowance");
  const used = optionalNumber(record, "used");
  const remaining = optionalNumber(record, "remaining");
  if (allowance === undefined || used === undefined || remaining === undefined) return null;
  const periodStart = record["period_start"];
  const periodEnd = record["period_end"];
  if (typeof periodStart !== "string" || Number.isNaN(Date.parse(periodStart))) return null;
  if (typeof periodEnd !== "string" || Number.isNaN(Date.parse(periodEnd))) return null;
  const balance: CreditBalance = {
    periodStart,
    periodEnd,
    allowance,
    used,
    remaining,
    packCredits: optionalNumber(record, "pack_credits") ?? 0,
    frozen: record["frozen"] === true,
  };
  const packExpiresAt = record["pack_expires_at"];
  if (typeof packExpiresAt === "string" && packExpiresAt.trim() !== "") balance.packExpiresAt = packExpiresAt;
  return balance;
}

interface Page {
  report: UsageReport;
  hasMore: boolean;
  nextCursor?: string;
}

/**
 * Validate a `/v1/usage` payload into the domain report. Strict only where a
 * missing number would lie (`totals.total_tokens`); everything else is
 * optional with sane defaults, because the endpoint legitimately omits
 * credits on days and accounts that predate the pool.
 */
function parsePage(payload: unknown): Page {
  const root = asRecord(payload, "usage");
  const totals = asRecord(root["totals"], "usage.totals");
  const totalTokens = optionalNumber(totals, "total_tokens");
  if (totalTokens === undefined) throw schemaError("totals.total_tokens is not a number");

  // `totals` covers the full window, not the page, so page 1's copy is
  // already complete; later pages only contribute daily rows.
  const byModel: Record<string, ModelTotals> = {};
  const rawByModel = totals["by_model"];
  if (Array.isArray(rawByModel)) {
    for (const [index, raw] of rawByModel.entries()) {
      const entry = asRecord(raw, `usage.totals.by_model[${index}]`);
      const model = entry["model"];
      if (typeof model !== "string" || model.trim() === "") continue;
      const id = canonicalModelId(model);
      const row: ModelTotals = {
        credits: optionalNumber(entry, "credits") ?? 0,
        tokens: optionalNumber(entry, "total_tokens") ?? 0,
        promptTokens: optionalNumber(entry, "prompt_tokens") ?? 0,
        cachedTokens: optionalNumber(entry, "cached_tokens") ?? 0,
        completionTokens: optionalNumber(entry, "completion_tokens") ?? 0,
        requests: optionalNumber(entry, "api_requests") ?? 0,
      };
      const previous = byModel[id];
      if (previous === undefined) {
        // All-zero rows are never stored: the table only lists models that
        // drew something in the window.
        if (row.credits > 0 || row.tokens > 0 || row.requests > 0) byModel[id] = row;
      } else {
        previous.credits += row.credits;
        previous.tokens += row.tokens;
        previous.promptTokens += row.promptTokens;
        previous.cachedTokens += row.cachedTokens;
        previous.completionTokens += row.completionTokens;
        previous.requests += row.requests;
      }
    }
  }

  const dailyByDate = new Map<string, number>();
  const rawData = root["data"];
  if (Array.isArray(rawData)) {
    for (const [index, raw] of rawData.entries()) {
      const row = asRecord(raw, `usage.data[${index}]`);
      const date = row["date"];
      const credits = optionalNumber(row, "credits");
      if (typeof date !== "string" || credits === undefined) continue;
      dailyByDate.set(date, (dailyByDate.get(date) ?? 0) + credits);
    }
  }
  const daily: DailyCredits[] = [...dailyByDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, credits]) => ({ date, credits }));

  const report: UsageReport = {
    startDate: typeof root["start_date"] === "string" ? root["start_date"] : "",
    endDate: typeof root["end_date"] === "string" ? root["end_date"] : "",
    totalTokens,
    totalCredits: optionalNumber(totals, "credits") ?? 0,
    requests: optionalNumber(totals, "api_requests") ?? 0,
    byModel,
    daily,
    credits: parseCredits(root["credits"]),
  };

  const allTime = root["all_time"];
  if (typeof allTime === "object" && allTime !== null && !Array.isArray(allTime)) {
    const record = allTime as Record<string, unknown>;
    const tokens = optionalNumber(record, "total_tokens");
    if (tokens !== undefined) report.allTimeTokens = tokens;
    const cachedAt = record["cached_at"];
    if (typeof cachedAt === "string") report.cachedAt = cachedAt;
  }

  return {
    report,
    hasMore: root["has_more"] === true,
    nextCursor: typeof root["next_cursor"] === "string" && root["next_cursor"] !== "" ? root["next_cursor"] : undefined,
  };
}

/** Validate a `/v1/usage` payload into the domain report (single page). */
export function parseUsagePayload(payload: unknown): UsageReport {
  return parsePage(payload).report;
}

/** Fold one page's daily rows into the first page's report. */
function mergePages(first: UsageReport, page: UsageReport): UsageReport {
  if (page.daily.length === 0) return first;
  const byDate = new Map(first.daily.map((day) => [day.date, day.credits]));
  for (const day of page.daily) byDate.set(day.date, (byDate.get(day.date) ?? 0) + day.credits);
  const daily: DailyCredits[] = [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, credits]) => ({ date, credits }));
  return { ...first, daily };
}

export interface UsageApiDeps {
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
}

/** Fetch and validate a usage report for a window, following the cursor. */
export async function fetchUsage(apiKey: string, window: UsageWindow, deps: UsageApiDeps = {}): Promise<UsageReport> {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  const at = now();

  const fetchPage = async (cursor?: string): Promise<Page> => {
    let response: Response;
    try {
      response = await doFetch(usageUrl(window.startDate, window.endDate, cursor), {
        headers: requestHeaders(apiKey),
      });
    } catch (error) {
      throw new FetchError("network", `usage: ${error instanceof Error ? error.message : String(error)}`);
    }
    assertOk(response, "usage", at);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw schemaError("response is not valid JSON");
    }
    return parsePage(payload);
  };

  let page = await fetchPage();
  let report = page.report;
  const seenCursors = new Set<string>();
  while (page.hasMore && page.nextCursor !== undefined && seenCursors.size < MAX_PAGES - 1) {
    // A cursor the API already handed back means it is looping; stop rather
    // than re-requesting the same page forever.
    if (seenCursors.has(page.nextCursor)) break;
    seenCursors.add(page.nextCursor);
    page = await fetchPage(page.nextCursor);
    report = mergePages(report, page.report);
  }
  return report;
}
