// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Domain types shared by the fetchers, the cache, the renderer and the command.
 *
 * Everything here is deliberately plain data: a `Snapshot` is a value that can
 * be rendered without touching the network, which is what keeps the TUI
 * responsive when the API is slow or down.
 *
 * The accounting model (NaN, since 2026-11-09): ONE shared pool of credits per
 * billing period (7,000 Inference / 20,000 Premium), drawn at each model's
 * per-token price. There are no per-model allowances; the documented
 * `GET /v1/usage` reports the balance, so what this extension shows is the
 * real budget. `credits: null` means the account is not billed in credits at
 * all (e.g. the Gentle plan with per-model caps) and the extension falls back
 * to showing tokens.
 */

/** Canonical NaN model id (`glm5.3-flash`), never a pi provider/model string. */
export type ModelId = string;

/** The account's credit balance, from the documented `/v1/usage`. */
export interface CreditBalance {
  /** ISO timestamp; the billing period renews at `periodEnd`. */
  periodStart: string;
  periodEnd: string;
  /** Subscription allowance for the period (packs excluded). */
  allowance: number;
  used: number;
  /** Allowance minus used; excludes pack credits. */
  remaining: number;
  /** Credits bought as packs, spendable until `packExpiresAt`. */
  packCredits: number;
  packExpiresAt?: string;
  /** True when the subscription is inactive: credit requests are refused. */
  frozen: boolean;
}

/** What `/v1/usage` reports for one model over the window. */
export interface ModelTotals {
  credits: number;
  tokens: number;
  promptTokens: number;
  /** Part of `promptTokens`. */
  cachedTokens: number;
  completionTokens: number;
  requests: number;
}

/** One UTC day of the window, summed across models. */
export interface DailyCredits {
  date: string;
  credits: number;
}

/** The pace projection (`src/pace.ts` explains the reasoning). */
export interface Pace {
  creditsPerDay: number;
  /** Days the rate is computed over; may be fractional. */
  basisDays: number;
  /** Epoch ms when the pool runs out; undefined when the rate is zero. */
  runsOutAt?: number;
  runsOutBeforeReset: boolean;
}

/** The documented `/v1/usage` report over the requested window. */
export interface UsageReport {
  startDate: string;
  endDate: string;
  totalTokens: number;
  /** Credits drawn over the window (`totals.credits`). */
  totalCredits: number;
  requests: number;
  /** Canonical model id -> window totals. */
  byModel: Record<string, ModelTotals>;
  /** One entry per UTC day with data, sorted by date. */
  daily: DailyCredits[];
  /**
   * The account balance. Covers the billing period regardless of the window.
   * Null when the payload says null (account not billed in credits) or when
   * the object is malformed or absent.
   */
  credits: CreditBalance | null;
  allTimeTokens?: number;
  cachedAt?: string;
}

/**
 * A complete, renderable view of the account: the credit balance, the pace
 * projection, and per-model consumption over the window, restricted to the
 * models this key can call and the user listed in `config.models` (the
 * balance itself is account-wide and never filtered).
 */
export interface Snapshot {
  /** Epoch ms of the read that produced this snapshot. */
  fetchedAt: number;
  /** The UTC-day window the per-model numbers cover. */
  window: { startDate: string; endDate: string };
  credits: CreditBalance | null;
  pace?: Pace;
  /** Served models with data in the window (all-zero rows are never stored). */
  byModel: Record<ModelId, ModelTotals>;
  /** Tokens of the models above. */
  totalTokens: number;
  /** Credits of the models above. */
  totalCredits: number;
  /** Daily credit totals over the window (account-wide, unfiltered). */
  daily: DailyCredits[];
  /**
   * Canonical ids this API key can call, from the documented `GET /v1/models`.
   * NaN filters that list by plan. Undefined when the list could not be read;
   * consumers then fail open.
   */
  served?: string[];
  allTimeTokens?: number;
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
