// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Cache, refresh policy and error handling.
 *
 * The renderer must never wait for the network, so every read goes through
 * here:
 *
 *  - TTL of `refreshSeconds` (120 s by default) on success,
 *  - one in-flight request shared by every caller (single-flight),
 *  - `Retry-After` honoured on 429, capped at 15 minutes,
 *  - exponential backoff 30 s -> 60 s -> 120 s -> ... capped at 15 minutes,
 *  - the last good snapshot is never dropped, so a failure degrades to a stale
 *    bar plus an age suffix instead of an empty footer,
 *  - a given failure is announced once; repeating it stays silent until the
 *    error changes.
 */

import { FetchError, toFetchError, type Snapshot } from "./types.ts";

/** Cache TTL after a successful read. */
export const DEFAULT_TTL_MS = 120_000;
/** First backoff step after a network/5xx failure. */
export const BASE_BACKOFF_MS = 30_000;
/** Ceiling for both backoff and a server-supplied `Retry-After`. */
export const MAX_BACKOFF_MS = 15 * 60_000;
/** `model_select` refreshes only when the snapshot is older than this. */
export const MODEL_SELECT_MAX_AGE_MS = 30_000;
/** `turn_end` refreshes are coalesced into this window. */
export const TURN_DEBOUNCE_MS = 15_000;

export interface CacheDeps {
  /** Performs one read; may fall back internally to the documented endpoint. */
  fetchSnapshot: () => Promise<Snapshot>;
  now?: () => number;
  /** Called once per distinct failure; the caller words it for the user. */
  notify?: (failure: FetchError, level: "warning" | "error") => void;
  /** Success TTL; a function is read on every call, so config reloads apply. */
  ttlMs?: number | (() => number);
}

export interface CacheState {
  /** Consecutive failures; 0 after a success. */
  failures: number;
  /** Epoch ms before which no new attempt is made; 0 when clear. */
  retryAt: number;
  lastError?: FetchError;
  /** Epoch ms of the last successful read. */
  lastGoodAt?: number;
  /** True while a request is in flight. */
  inFlight: boolean;
  /** Snapshot currently served (may be the last good one). */
  snapshot?: Snapshot;
}

export interface CacheGetOptions {
  /** Ignore TTL and backoff, e.g. `/nan-quota refresh`. */
  force?: boolean;
  /** Freshness threshold for this call only, e.g. 30 s on `model_select`. */
  maxAgeMs?: number;
}

/** Single-flight, TTL and backoff state machine around one snapshot source. */
export class QuotaCache {
  private readonly deps: CacheDeps;
  private readonly now: () => number;
  private readonly ttl: () => number;

  private current: Snapshot | undefined;
  private currentAt = 0;
  private lastGoodAt: number | undefined;
  private pending: Promise<Snapshot | undefined> | undefined;
  private failures = 0;
  private retryAt = 0;
  private lastError: FetchError | undefined;
  private announcedKey: string | undefined;

  constructor(deps: CacheDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.ttl = typeof ttl === "function" ? ttl : () => ttl;
  }

  /** Read the snapshot, fetching only when the cache is cold or forced. */
  get(options: CacheGetOptions = {}): Promise<Snapshot | undefined> {
    if (this.pending) return this.pending;
    const now = this.now();
    const freshFor = options.maxAgeMs ?? this.ttl();
    if (!options.force) {
      if (this.current && now - this.currentAt < freshFor) return Promise.resolve(this.current);
      if (now < this.retryAt) return Promise.resolve(this.current);
    }
    const pending = this.run();
    this.pending = pending;
    return pending;
  }

  /** Last snapshot handed to callers (possibly stale). */
  getSnapshot(): Snapshot | undefined {
    return this.current;
  }

  getState(): CacheState {
    const state: CacheState = {
      failures: this.failures,
      retryAt: this.retryAt,
      inFlight: this.pending !== undefined,
    };
    if (this.lastError !== undefined) state.lastError = this.lastError;
    if (this.lastGoodAt !== undefined) state.lastGoodAt = this.lastGoodAt;
    if (this.current !== undefined) state.snapshot = this.current;
    return state;
  }

  /** Drop cached state, e.g. after a config reload switched providers. */
  reset(): void {
    this.current = undefined;
    this.currentAt = 0;
    this.lastGoodAt = undefined;
    this.failures = 0;
    this.retryAt = 0;
    this.lastError = undefined;
    this.announcedKey = undefined;
  }

  private async run(): Promise<Snapshot | undefined> {
    try {
      const snapshot = await this.deps.fetchSnapshot();
      const now = this.now();
      this.current = snapshot;
      this.currentAt = now;
      this.lastGoodAt = now;
      this.failures = 0;
      this.retryAt = 0;
      this.lastError = undefined;
      this.announcedKey = undefined;
      return snapshot;
    } catch (error) {
      const failure = toFetchError(error);
      this.failures += 1;
      this.lastError = failure;
      this.retryAt = this.now() + backoffFor(failure, this.failures);
      this.announce(failure);
      return this.current;
    } finally {
      this.pending = undefined;
    }
  }

  private announce(failure: FetchError): void {
    const key = `${failure.kind}:${failure.message}`;
    if (key === this.announcedKey) return;
    this.announcedKey = key;
    const level = failure.kind === "auth" ? "error" : "warning";
    this.deps.notify?.(failure, level);
  }
}

/** Delay before the next attempt: `Retry-After` for 429, exponential otherwise. */
export function backoffFor(failure: FetchError, failures: number): number {
  if (failure.kind === "rate-limit" && failure.retryAfterMs !== undefined) {
    return Math.min(failure.retryAfterMs, MAX_BACKOFF_MS);
  }
  const step = BASE_BACKOFF_MS * 2 ** Math.max(0, failures - 1);
  return Math.min(step, MAX_BACKOFF_MS);
}

/**
 * Leading-edge debouncer: the first call schedules a run, further calls inside
 * the window are folded into it.
 */
export class Debouncer {
  private readonly delayMs: number;
  private readonly run: () => void;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(delayMs: number, run: () => void) {
    this.delayMs = delayMs;
    this.run = run;
  }

  trigger(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.run();
    }, this.delayMs);
    // Never keep the process alive for a refresh that is about to be dropped.
    this.timer.unref?.();
  }

  cancel(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  get pending(): boolean {
    return this.timer !== undefined;
  }
}
