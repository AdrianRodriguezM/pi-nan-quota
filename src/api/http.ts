// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * HTTP plumbing shared by every NaN API call.
 *
 * `assertOk`, `parseRetryAfter` and `requestHeaders` encode the one contract
 * all endpoints share (error mapping, rate-limit hints, headers), so a fix
 * here applies everywhere at once.
 */

import { FetchError } from "../types.ts";

/** Keep in sync with package.json `version` (a test enforces it). */
export const VERSION = "0.3.0";

/** User-Agent header value; the API is friendlier when it can identify callers. */
export const USER_AGENT = `pi-nan-quota/${VERSION}`;

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
