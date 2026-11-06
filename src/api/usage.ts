// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The documented usage endpoint.
 *
 * `GET https://api.nan.builders/v1/usage?start_date=…&end_date=…&limit=1`
 * reports consumption for a window (max 90 days, 30 req/min) but not caps, so
 * it serves two purposes: the monthly consumption line in `/nan-quota`, and the
 * fallback source when the undocumented quota endpoint fails.
 */

import { canonicalModelId } from "../models.ts";
import { FetchError, type UsageReport } from "../types.ts";
import { assertOk, requestHeaders } from "./quota.ts";

export const USAGE_URL = "https://api.nan.builders/v1/usage";

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

/** Current UTC month: first day to today (inclusive). */
export function utcMonthWindow(now: number): { startDate: string; endDate: string } {
  return { startDate: `${utcDate(now).slice(0, 7)}-01`, endDate: utcDate(now) };
}

/** Request URL for a window. `limit=1` is enough: only totals are used. */
export function usageUrl(startDate: string, endDate: string): string {
  const params = new URLSearchParams({ start_date: startDate, end_date: endDate, limit: "1" });
  return `${USAGE_URL}?${params.toString()}`;
}

/** Validate a `/v1/usage` payload into the domain report. */
export function parseUsagePayload(payload: unknown): UsageReport {
  const root = asRecord(payload, "usage");
  const totals = asRecord(root["totals"], "usage.totals");
  const totalTokens = optionalNumber(totals, "total_tokens");
  if (totalTokens === undefined) throw schemaError("totals.total_tokens is not a number");

  const byModel: Record<string, number> = {};
  const rawByModel = totals["by_model"];
  if (Array.isArray(rawByModel)) {
    for (const [index, raw] of rawByModel.entries()) {
      const entry = asRecord(raw, `usage.totals.by_model[${index}]`);
      const model = entry["model"];
      const tokens = optionalNumber(entry, "total_tokens");
      if (typeof model !== "string" || tokens === undefined) continue;
      const id = canonicalModelId(model);
      byModel[id] = (byModel[id] ?? 0) + tokens;
    }
  }

  const report: UsageReport = {
    startDate: typeof root["start_date"] === "string" ? root["start_date"] : "",
    endDate: typeof root["end_date"] === "string" ? root["end_date"] : "",
    totalTokens,
    requests: optionalNumber(totals, "api_requests") ?? 0,
    byModel,
  };

  const allTime = root["all_time"];
  if (typeof allTime === "object" && allTime !== null && !Array.isArray(allTime)) {
    const record = allTime as Record<string, unknown>;
    const tokens = optionalNumber(record, "total_tokens");
    if (tokens !== undefined) report.allTimeTokens = tokens;
    const requests = optionalNumber(record, "api_requests");
    if (requests !== undefined) report.allTimeRequests = requests;
    const cachedAt = record["cached_at"];
    if (typeof cachedAt === "string") report.cachedAt = cachedAt;
  }
  return report;
}

export interface UsageApiDeps {
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
}

/** Fetch and validate the current UTC month's usage report. */
export async function fetchUsage(apiKey: string, deps: UsageApiDeps = {}): Promise<UsageReport> {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  const at = now();
  const { startDate, endDate } = utcMonthWindow(at);
  let response: Response;
  try {
    response = await doFetch(usageUrl(startDate, endDate), { headers: requestHeaders(apiKey) });
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
  return parseUsagePayload(payload);
}
