// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The quota endpoint (primary source).
 *
 * `GET https://cloud-api.nan.builders/api/usage/quota` is undocumented: it is
 * what the NaN dashboard reads, and the error it returns to a bad key states
 * that `sk-` API keys are accepted here. It reports per-model caps, the real
 * reset time and purchased extra pools.
 *
 * The server is authoritative: every row with valid counters is kept, including
 * models this extension has never heard of. Which of them the key can actually
 * call is decided later against `GET /v1/models` (see `filterServed`).
 *
 * Validation is strict on shape — a missing or non-numeric counter is a
 * contract change and surfaces as a schema failure, which switches the
 * extension to the documented fallback instead of rendering wrong numbers.
 */

import { labelFor } from "../caps.ts";
import { canonicalModelId } from "../models.ts";
import { FetchError, type ModelQuota } from "../types.ts";

export const QUOTA_URL = "https://cloud-api.nan.builders/api/usage/quota";

/** Keep in sync with package.json `version` (a test enforces it). */
export const VERSION = "0.1.1";

/** User-Agent header value; the API is friendlier when it can identify callers. */
export const USER_AGENT = `pi-nan-quota/${VERSION}`;

export interface ParsedQuota {
  periodStart?: string;
  /** Newest `updatedAt` in the payload, for the table footer. */
  updatedAt?: string;
  /** Every row the server reported, ids canonicalised. */
  models: ModelQuota[];
}

export interface QuotaApiDeps {
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
}

const schemaError = (detail: string) => new FetchError("schema", `quota: ${detail}`);

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw schemaError(`${path} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requiredNumber(record: Record<string, unknown>, field: string, path: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw schemaError(`${path}.${field} is not a number`);
  }
  return value;
}

function optionalNumber(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Validate a quota payload.
 *
 * Throws `FetchError("schema", ...)` on anything unexpected: a root that is not
 * an object, `models` that is not an array, or a row whose id or counters are
 * missing or non-numeric (a numeric string is a contract change, not a value to
 * coerce). An empty list is valid: it means the server has nothing capped to
 * report for this key.
 */
export function parseQuotaPayload(payload: unknown): ParsedQuota {
  const root = asRecord(payload, "quota");
  const rawModels = root["models"];
  if (!Array.isArray(rawModels)) throw schemaError("models is not an array");

  const models: ModelQuota[] = [];
  const seen = new Set<string>();
  let updatedAt: string | undefined;

  for (const [index, raw] of rawModels.entries()) {
    const path = `models[${index}]`;
    const item = asRecord(raw, path);
    const id = item["model"];
    if (typeof id !== "string" || id.trim() === "") throw schemaError(`${path}.model is not a string`);

    const model = canonicalModelId(id);
    const cap = requiredNumber(item, "cap", path);
    const tokensUsed = requiredNumber(item, "tokensUsed", path);
    if (cap < 0 || tokensUsed < 0) throw schemaError(`${path} has a negative counter`);
    // Two rows for one model would make every later lookup ambiguous.
    if (seen.has(model)) continue;
    seen.add(model);

    const entry: ModelQuota = {
      model,
      label: labelFor(model),
      cap,
      tokensUsed,
      remaining: optionalNumber(item, "remaining") ?? Math.max(0, cap - tokensUsed),
    };

    const periodEnd = optionalString(item, "periodEnd");
    if (periodEnd !== undefined) entry.periodEnd = periodEnd;
    const periodStart = optionalString(item, "periodStart") ?? optionalString(root, "periodStart");
    if (periodStart !== undefined) entry.periodStart = periodStart;
    const tokenUpdatedAt = optionalString(item, "updatedAt");
    if (tokenUpdatedAt !== undefined) {
      entry.updatedAt = tokenUpdatedAt;
      if (updatedAt === undefined || tokenUpdatedAt > updatedAt) updatedAt = tokenUpdatedAt;
    }
    const extraTokens = optionalNumber(item, "extraTokens");
    if (extraTokens !== undefined && extraTokens >= 0) entry.extraTokens = extraTokens;
    // NaN pauses a pool without an active membership; absent means usable.
    if (typeof item["extraUsable"] === "boolean") entry.extraUsable = item["extraUsable"];
    const extraExpiresAt = optionalString(item, "extraExpiresAt");
    if (extraExpiresAt !== undefined) entry.extraExpiresAt = extraExpiresAt;
    const windowHours = optionalNumber(item, "windowHours");
    if (windowHours !== undefined && windowHours > 0) entry.windowHours = windowHours;
    const fullWindowTokens = optionalNumber(item, "fullWindowTokens");
    if (fullWindowTokens !== undefined && fullWindowTokens > 0) entry.fullWindowTokens = fullWindowTokens;
    const windowTokensUsed = optionalNumber(item, "windowTokensUsed");
    if (windowTokensUsed !== undefined) entry.windowTokensUsed = windowTokensUsed;

    // `cap: 0` is legal and means "no cap"; it is kept so the table lists it.
    models.push(entry);
  }

  const parsed: ParsedQuota = { models };
  const periodStart = optionalString(root, "periodStart");
  if (periodStart !== undefined) parsed.periodStart = periodStart;
  if (updatedAt !== undefined) parsed.updatedAt = updatedAt;
  return parsed;
}

/** Headers every NaN API call carries. Never includes anything but the key. */
export function requestHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    // pi proxies requests through undici, which mis-handles gzip here.
    "Accept-Encoding": "identity",
    "User-Agent": USER_AGENT,
  };
}

/** `Retry-After` as milliseconds (seconds or HTTP date), if present. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** Map a non-2xx response onto a `FetchError` without echoing the body. */
export function assertOk(response: Response, label: string, now: number = Date.now()): void {
  if (response.ok) return;
  const status = response.status;
  if (status === 401 || status === 403) {
    // NaN answers the same 401 to a mistyped key and to an account without
    // API access, so the message names both causes instead of guessing.
    throw new FetchError("auth", `${label}: HTTP ${status}, the API key was rejected`, { status });
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now);
    const extra: { status: number; retryAfterMs?: number } = { status };
    if (retryAfterMs !== undefined) extra.retryAfterMs = retryAfterMs;
    throw new FetchError("rate-limit", `${label}: HTTP 429 (rate limited)`, extra);
  }
  if (status >= 500) throw new FetchError("server", `${label}: HTTP ${status}`, { status });
  throw new FetchError("http", `${label}: HTTP ${status}`, { status });
}

/** Fetch and validate the quota payload. Throws `FetchError` only. */
export async function fetchQuota(apiKey: string, deps: QuotaApiDeps = {}): Promise<ParsedQuota> {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  let response: Response;
  try {
    response = await doFetch(QUOTA_URL, { headers: requestHeaders(apiKey) });
  } catch (error) {
    throw new FetchError("network", `quota: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertOk(response, "quota", now());
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw schemaError("response is not valid JSON");
  }
  return parseQuotaPayload(payload);
}
