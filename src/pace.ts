// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pace projection: when does the credit pool run out?
 *
 * The rate is consumption over *recent* time, not over the whole period:
 * usage patterns shift, so the last 7 days predict the next week better than
 * an average that still weights the period's quiet start. The lookback covers
 * at most 7 UTC calendar days, today included and never before the billing period (or
 * the first day credits were billed, whichever is later) — days without
 * credit data would dilute the rate towards zero and look like a runway.
 *
 * One caveat forces a branch: when the lookback reaches the period's first
 * day, the daily rows of that day may mix in the previous period's tail
 * (whole UTC days, but the period starts mid-day), so `credits.used` —
 * authoritative, period-scoped — replaces the row sum, and the elapsed time
 * is measured from the period's start (a partial first day).
 *
 * Under 12 hours of elapsed time the projection is noise (one heavy turn
 * skews it wildly), so it stays undefined until then. A zero rate never runs
 * out. Packs extend the runway: they are spendable balance too.
 */

import { CREDITS_BILLED_SINCE } from "./api/usage.ts";
import type { Pace, UsageReport } from "./types.ts";

const DAY_MS = 24 * 60 * 60_000;
const LOOKBACK_DAYS = 7;
/** Below this elapsed time the projection is noise. */
const MIN_ELAPSED_MS = 12 * 3_600_000;

function startOfUTCDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Project the burn rate and the runway. `undefined` when there is no credit
 * balance or the period is too young to project.
 */
export function projectPace(report: UsageReport, now: number): Pace | undefined {
  const credits = report.credits;
  if (!credits) return undefined;
  const periodStart = Date.parse(credits.periodStart);
  const periodEnd = Date.parse(credits.periodEnd);
  if (Number.isNaN(periodStart) || Number.isNaN(periodEnd)) return undefined;

  const effectiveStart = Math.max(periodStart, Date.parse(`${CREDITS_BILLED_SINCE}T00:00:00Z`));
  if (now <= effectiveStart) return undefined;

  // Seven calendar days including today: six whole days back plus today's
  // elapsed part, so the summed rows and the elapsed time cover the same span.
  const lookbackStart = Math.max(effectiveStart, startOfUTCDay(now) - (LOOKBACK_DAYS - 1) * DAY_MS);

  let spent: number;
  let elapsed: number;
  if (utcDay(lookbackStart) === utcDay(periodStart)) {
    // The lookback reaches the period's first (partial) day: `used` is
    // authoritative where the daily rows are not.
    spent = credits.used;
    elapsed = now - effectiveStart;
  } else {
    const from = utcDay(lookbackStart);
    const today = utcDay(now);
    spent = report.daily
      .filter((day) => day.date >= from && day.date <= today)
      .reduce((total, day) => total + day.credits, 0);
    elapsed = now - lookbackStart;
  }

  if (elapsed < MIN_ELAPSED_MS) return undefined;
  const basisDays = elapsed / DAY_MS;
  const creditsPerDay = spent / basisDays;

  const pace: Pace = { creditsPerDay, basisDays, runsOutBeforeReset: false };
  if (creditsPerDay <= 0) return pace; // A pool that is not draining never runs out.

  const runwayMs = ((credits.remaining + credits.packCredits) / creditsPerDay) * DAY_MS;
  pace.runsOutAt = now + runwayMs;
  pace.runsOutBeforeReset = pace.runsOutAt < periodEnd;
  return pace;
}
