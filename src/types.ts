// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Domain types shared by the fetchers, the cache, the renderer and the command.
 *
 * Everything here is deliberately plain data: a `Snapshot` is a value that can
 * be rendered without touching the network, which is what keeps the TUI
 * responsive when the quota API is slow or down.
 */

/** Where a snapshot's numbers came from. */
export type QuotaSource = "quota" | "usage";

/** One model's quota for the current period. */
export interface ModelQuota {
  /** Canonical NaN model id (`glm5.3-flash`), never a pi provider/model string. */
  model: string;
  /** Human label from the caps table; falls back to the id. */
  label: string;
  /** Monthly token cap. `0` means the model has no cap. */
  cap: number;
  tokensUsed: number;
  remaining: number;
  periodStart?: string;
  /** Server-reported reset for this model. */
  periodEnd?: string;
  /**
   * Tokens left in a purchased extra-usage pool. The server reports what is
   * left, never the pool's original size, and the pool has its own expiry.
   */
  extraTokens?: number;
  /** `false` when the pool is paused (NaN pauses it without an active membership). */
  extraUsable?: boolean;
  /** Absolute expiry of the extra pool, independent of the billing period. */
  extraExpiresAt?: string;
  /** Rolling window size, in hours and tokens (the premium glm5.3 today). */
  windowHours?: number;
  fullWindowTokens?: number;
  /**
   * Consumption inside the rolling window. The captured payload only exposes
   * the monthly counter, so this stays undefined unless the server grows a
   * field for it; the window is then shown as capacity only.
   */
  windowTokensUsed?: number;
  updatedAt?: string;
}

/** The documented `/v1/usage` report. */
export interface UsageReport {
  startDate: string;
  endDate: string;
  totalTokens: number;
  requests: number;
  /** Canonical model id -> tokens in the window. */
  byModel: Record<string, number>;
  allTimeTokens?: number;
  allTimeRequests?: number;
  cachedAt?: string;
}

/** A complete, renderable view of the account's quota. */
export interface Snapshot {
  source: QuotaSource;
  /** True when caps came from the dated docs table instead of the server. */
  estimated: boolean;
  periodStart?: string;
  periodEnd?: string;
  /** Epoch ms of the read that produced this snapshot. */
  fetchedAt: number;
  models: ModelQuota[];
  usage?: UsageReport;
  /** Newest `updatedAt` reported by the quota endpoint. */
  updatedAt?: string;
  /**
   * Canonical ids this API key can call, from the documented `GET /v1/models`.
   * NaN filters that list by plan, so it is what separates "premium model you
   * do not have" and "retired model" from "model you can use". Undefined when
   * the list could not be read; consumers then fail open.
   */
  served?: string[];
  /** True when the user turned the undocumented quota endpoint off. */
  quotaEndpointDisabled?: boolean;
}

/** Failure taxonomy that drives backoff, notifications and user advice. */
export type FailureKind = "auth" | "rate-limit" | "network" | "server" | "schema" | "http";

/** Every fetch failure is normalised into this shape. Never carries the key. */
export class FetchError extends Error {
  readonly kind: FailureKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(kind: FailureKind, message: string, extra: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "FetchError";
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

/** Coerce anything thrown by a fetcher into a `FetchError`. */
export function toFetchError(error: unknown): FetchError {
  if (error instanceof FetchError) return error;
  if (error instanceof Error) return new FetchError("network", error.message);
  return new FetchError("network", String(error));
}
