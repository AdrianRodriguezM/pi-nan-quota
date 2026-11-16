// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The footer segment.
 *
 * Pure: it receives a `Snapshot`, a width, a colour mode and a theme, and
 * returns the string to hand to `ctx.ui.setStatus()`. No network, no clocks
 * beyond the injected `now`, which is what lets the test suite pin every shape.
 *
 * The bar is a fuel gauge for the shared credit pool: full at the period
 * start, drained as `remaining` (the subscription allowance only — packs are
 * extra fuel, not tank size) is spent. The number is whole credits, floored
 * (conservative: the tank never looks fuller than it is).
 *
 * Shapes, in priority order; the first that fits `MAX_SEGMENT_WIDTH` wins:
 *
 *   nan ▰▰▰▰▰▱▱▱▱▱ 3745 cr · ⚠ empty in ~8d · resets 15d23h
 *   nan ▰▰▰▰▰▱▱▱▱▱ 3745 cr · ⚠ empty in ~8d
 *   nan ▰▰▰▰▰▱▱▱▱▱ 3745 cr · resets 15d23h
 *   nan ▰▰▰▰▰▱▱▱▱▱ 3745 cr
 *   nan 3745 cr
 *
 * The `⚠ empty in ~8d` part appears only when the projected run-out beats the reset.
 * When a refresh failed long ago, the staleness suffix (` ·5m`) is attached
 * to the widest shape it fits on — even if that means dropping a suffix —
 * because a fresh-looking number from a stale read is the worse lie. The
 * segment no longer depends on which NaN model is active — the pool is
 * shared by every model — except to say when the active model is not served
 * by this key at all.
 *
 * Priority states, each clamped to the width:
 *
 *   nan ⏸ subscription inactive — cloud.nan.builders     (frozen)
 *   nan ⛔ credits spent — resets 15d23h                   (402 seen / empty)
 *   nan ···                                               (no data yet)
 *   nan glm5.3 not available on this key
 *   nan 1.2B tokens (30d)                                 (not billed in credits)
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatAge, formatReset, formatTokens, formatUntil } from "../format.ts";
import { canonicalModelId, isNotServed } from "../models.ts";
import type { CreditBalance, Snapshot } from "../types.ts";
import { glyphsFor, renderBar, type GlyphStyle } from "./bar.ts";
import { paintBrand, plainTheme, type ColorMode, type ThemeLike } from "./color.ts";

/** `setStatus` key; the user's own footer renders `getExtensionStatuses()`. */
export const STATUS_KEY = "nan-quota";

/** Hard cap for the segment, so the footer stays readable on narrow terminals. */
export const MAX_SEGMENT_WIDTH = 56;

/** A failed refresh only shows an age suffix after this long. */
export const STALE_AFTER_MS = 5 * 60_000;

/**
 * A snapshot clears a seen 402 only when it was fetched this much after the
 * error: the balance may lag real spending by about a minute.
 */
export const CREDIT_RECOVERY_MS = 60_000;

export interface StatusRenderOptions {
  /** Epoch ms used for the reset countdown and the staleness suffix. */
  now: number;
  /** Max visible width; defaults to {@link MAX_SEGMENT_WIDTH}. */
  width?: number;
  mode?: ColorMode;
  theme?: ThemeLike;
  /**
   * Whether to draw at all: the active model is a NaN one, or the user set
   * `alwaysShow`. Defaults to `true` so the renderer can be used on its own.
   */
  show?: boolean;
  /** The active model's id when it is a NaN model. */
  activeModelId?: string;
  /** Glyph family: the pill (default) or the font-safe squares. */
  glyphStyle?: GlyphStyle;
  /** True when the last refresh failed and `lastGoodAt` is therefore stale. */
  failed?: boolean;
  lastGoodAt?: number;
  /** Epoch ms when the last assistant run died on a spent credit pool. */
  creditRunOutAt?: number;
}

/** Remaining share of the allowance, as a printed percentage. Packs excluded. */
function remainingPercent(credits: CreditBalance): number {
  if (credits.allowance <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((credits.remaining / credits.allowance) * 100)));
}

/** Whole days a window spans, inclusive (`Nov 10 → Nov 16` is 7). */
function windowDayCount(snapshot: Snapshot): number {
  const from = Date.parse(`${snapshot.window.startDate}T00:00:00Z`);
  const to = Date.parse(`${snapshot.window.endDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 1;
  return Math.round((to - from) / 86_400_000) + 1;
}

/**
 * True when a snapshot fetched well after a seen 402 shows a spendable
 * balance again (the reset happened, or a pack was bought).
 */
export function snapshotClearsCreditRunOut(creditRunOutAt: number, snapshot: Snapshot): boolean {
  if (snapshot.credits === null || snapshot.credits === undefined) return false;
  if (snapshot.fetchedAt - creditRunOutAt <= CREDIT_RECOVERY_MS) return false;
  return snapshot.credits.remaining + snapshot.credits.packCredits >= 1;
}

/** Render the footer segment, or `undefined` when it must be cleared. */
export function renderStatus(snapshot: Snapshot | undefined, options: StatusRenderOptions): string | undefined {
  if (options.show === false) return undefined;

  const theme = options.theme ?? plainTheme;
  const width = options.width ?? MAX_SEGMENT_WIDTH;
  const dim = (text: string) => theme.fg("dim", text);
  const placeholder = clamp(dim("nan \u00b7\u00b7\u00b7"), width);

  // A frozen subscription outranks everything: credit requests are refused
  // until it is reactivated, so no other number matters.
  if (snapshot?.credits?.frozen === true) {
    return clamp(theme.fg("error", "nan \u23f8 subscription inactive \u2014 cloud.nan.builders"), width);
  }

  // A spent pool is the one state that needs action; it clears when a later
  // run succeeds or a fresh snapshot shows fuel again (see the loader).
  const spentByBalance =
    snapshot?.credits !== undefined &&
    snapshot.credits !== null &&
    snapshot.credits.remaining + snapshot.credits.packCredits < 1;
  if (options.creditRunOutAt !== undefined || spentByBalance) {
    let reset = "";
    const periodEnd = snapshot?.credits?.periodEnd;
    if (periodEnd !== undefined) {
      const at = Date.parse(periodEnd);
      if (!Number.isNaN(at)) reset = ` \u2014 resets ${formatReset(at - options.now)}`;
    }
    return clamp(theme.fg("error", `nan \u26d4 credits spent${reset}`), width);
  }

  if (!snapshot) return placeholder;

  const active = options.activeModelId;
  if (active !== undefined && isNotServed(active, snapshot.served)) {
    return clamp(dim(`nan ${canonicalModelId(active)} not available on this key`), width);
  }

  const stale = staleSuffix(options, options.now);

  // Not billed in credits (e.g. the Gentle plan): tokens are all the API
  // reports, so that is what the footer shows. No gauge to draw.
  if (snapshot.credits === undefined || snapshot.credits === null) {
    return clamp(`nan ${formatTokens(snapshot.totalTokens)} tokens (${windowDayCount(snapshot)}d)${stale}`, width);
  }

  const credits = snapshot.credits;
  const paint = (text: string) => paintBrand(text, options.mode ?? "none");
  const bar = renderBar(remainingPercent(credits), {
    glyphs: glyphsFor(options.glyphStyle ?? "pill"),
    fill: paint,
    empty: paint,
  });

  const number = Math.floor(Math.max(0, credits.remaining));
  const packs = credits.packCredits >= 1 ? `+${Math.floor(credits.packCredits)}` : "";
  // Low on allowance-only fuel: colour the number so it is seen from afar.
  const numberText =
    remainingPercent(credits) <= 10 && credits.packCredits < 1 ? theme.fg("warning", `${number}`) : `${number}`;
  const amount = `${numberText}${packs} cr`;

  let runout = "";
  const pace = snapshot.pace;
  if (pace?.runsOutBeforeReset === true && pace.runsOutAt !== undefined) {
    runout = ` \u00b7 ${theme.fg("warning", `\u26a0 empty in ~${formatUntil(pace.runsOutAt - options.now)}`)}`;
  }

  let reset = "";
  const resetAt = Date.parse(credits.periodEnd);
  if (!Number.isNaN(resetAt)) reset = ` \u00b7 resets ${formatReset(resetAt - options.now)}`;

  const head = `nan ${bar} ${amount}`;
  // Priority order, not width order: the run-out warning is the one part that
  // calls for action, so it outlives the reset countdown when space is short.
  const shapes = [`${head}${runout}${reset}`, `${head}${runout}`, `${head}${reset}`, head, `nan ${amount}`];
  // The first shape that fits wins, in two passes: first the shapes carrying
  // the staleness suffix (a fresh-looking number from a stale read is the
  // worse lie, so staleness may shrink the shape to fit), then the plain ones.
  const firstFitting = (forms: readonly string[]): string | undefined =>
    forms.find((form) => visibleWidth(form) <= width);
  if (stale !== "") {
    const withStale = firstFitting(shapes.map((shape) => shape + stale));
    if (withStale !== undefined) return withStale;
  }
  const plain = firstFitting(shapes);
  if (plain !== undefined) return plain;
  return clamp(`nan ${amount}`, width);
}

/** ` 5m` / ` 2h` once a failed refresh is older than five minutes. */
function staleSuffix(options: StatusRenderOptions, now: number): string {
  if (!options.failed || options.lastGoodAt === undefined) return "";
  const age = now - options.lastGoodAt;
  if (age <= STALE_AFTER_MS) return "";
  return ` \u00b7${formatAge(age)}`;
}

function clamp(text: string, width: number, force = false): string {
  if (!force && visibleWidth(text) <= width) return text;
  return truncateToWidth(text, width);
}
