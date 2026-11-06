// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The footer segment.
 *
 * Pure: it receives a `Snapshot`, a width, a colour mode and a theme, and
 * returns the string to hand to `ctx.ui.setStatus()`. No network, no clocks
 * beyond the injected `now`, which is what lets the test suite pin every shape.
 *
 * Shapes, widest first (the first that fits `MAX_SEGMENT_WIDTH` wins):
 *
 *   nan ▰▰▰▰▰▱▱▱  62% 4d3h · glm5.3-flash 91%
 *   nan ▰▰▰▰▰▱▱▱  62% 4d3h
 *   nan ▰▰▰▰▰▱▱▱  62%
 *   nan 62%
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatAge, formatPercent, formatReset, formatTokens } from "../format.ts";
import { capFor } from "../caps.ts";
import { canonicalModelId, isNotServed, sameModel } from "../models.ts";
import type { ModelQuota, Snapshot } from "../types.ts";
import { glyphsFor, renderBar, type GlyphStyle } from "./bar.ts";
import { paintBrand, paintUsage, plainTheme, type ColorMode, type ThemeLike } from "./color.ts";

/** `setStatus` key; the user's own footer renders `getExtensionStatuses()`. */
export const STATUS_KEY = "nan-quota";

/** Hard cap for the segment, so the footer stays readable on narrow terminals. */
export const MAX_SEGMENT_WIDTH = 48;

/** A failed refresh only shows an age suffix after this long. */
export const STALE_AFTER_MS = 5 * 60_000;

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
  /**
   * The active model's id when it is a NaN model. Undefined otherwise (with
   * `alwaysShow`), in which case the most used capped model is shown.
   */
  activeModelId?: string | undefined;
  warnAt?: number;
  criticalAt?: number;
  maxAlerts?: number;
  /** Glyph family: the pill (default) or the font-safe squares. */
  glyphStyle?: GlyphStyle;
  /** True when the last refresh failed and `lastGoodAt` is therefore stale. */
  failed?: boolean;
  lastGoodAt?: number;
}

/** Render the footer segment, or `undefined` when it must be cleared. */
export function renderStatus(snapshot: Snapshot | undefined, options: StatusRenderOptions): string | undefined {
  if (options.show === false) return undefined;

  const theme = options.theme ?? plainTheme;
  const width = options.width ?? MAX_SEGMENT_WIDTH;
  const now = options.now;
  const warnAt = options.warnAt ?? 80;
  const criticalAt = options.criticalAt ?? 95;
  const dim = (text: string) => theme.fg("dim", text);
  const placeholder = clamp(dim("nan \u00b7\u00b7\u00b7"), width);

  if (!snapshot) return placeholder;

  const stale = staleSuffix(options, now);
  const active = options.activeModelId;
  const quota = findActiveQuota(snapshot, active);

  if (!quota) {
    if (active === undefined) return placeholder;
    // The key cannot call this model. A model NaN publishes with a cap (glm5.3)
    // is a plan matter; anything else (glm5.2, retired) simply is not served,
    // and suggesting an upgrade for it would be wrong.
    if (isNotServed(active, snapshot.served)) {
      const id = canonicalModelId(active);
      const reason = (capFor(id)?.cap ?? 0) > 0 ? "not in your plan" : "not available on this key";
      return clamp(dim(`nan ${id} ${reason}`), width);
    }
    // Served but absent from the quota: NaN does not cap it (qwen3.6, gemma4).
    const used = snapshot.usage?.byModel[canonicalModelId(active)];
    return clamp(uncapped(used, dim) + stale, width);
  }

  if (quota.cap <= 0) return clamp(uncapped(quota.tokensUsed, dim) + stale, width);

  const percent = formatPercent(quota.tokensUsed, quota.cap);
  const tone = { mode: options.mode ?? "none", theme, warnAt, criticalAt };
  const bar = renderBar(quota.cap > 0 ? quota.tokensUsed / quota.cap : 0, {
    // From 1 % on, one cell: an almost untouched bar must not look untouched.
    minimum: percent >= 1 ? 1 : 0,
    glyphs: glyphsFor(options.glyphStyle ?? "pill"),
    fill: (text) => paintUsage(text, percent, tone),
    // Same violet as the used cells: a darker shade reads as black on a dark
    // terminal, so the unused half would look like it had vanished.
    empty: (text) => paintBrand(text, tone.mode),
  });
  const reset = resetSuffix(quota, now);
  const window = windowSuffix(quota);
  const extra = extraSuffix(quota);
  const alertParts = alertSuffixes(snapshot, quota, options);
  // The bar is a fixed 8 columns, so a 4-wide percentage keeps the footer still.
  const head = `nan ${bar}${`${percent}%`.padStart(5)}${extra}${window}`;

  // Widest first. Alerts outrank the reset countdown, so a narrow footer keeps
  // the "something else is about to run out" signal and drops the clock.
  const forms: string[] = [];
  for (let kept = alertParts.length; kept >= 0; kept--) {
    const alerts = alertParts.slice(0, kept).join("");
    forms.push(`${head}${reset}${alerts}${stale}`);
    forms.push(`${head}${reset}${alerts}`);
  }
  for (let kept = alertParts.length; kept > 0; kept--) {
    const alerts = alertParts.slice(0, kept).join("");
    forms.push(`${head}${alerts}${stale}`);
    forms.push(`${head}${alerts}`);
  }
  forms.push(`${head}${stale}`, head, `nan ${percent}%`);

  for (const form of forms) {
    if (visibleWidth(form) <= width) return form;
  }
  return clamp(`nan ${percent}%`, width, true);
}

/**
 * The active model's quota. Without an active NaN model (`alwaysShow` while
 * another provider is in use), the capped model closest to its limit.
 */
function findActiveQuota(snapshot: Snapshot, activeModelId: string | undefined): ModelQuota | undefined {
  if (activeModelId !== undefined) return snapshot.models.find((model) => sameModel(model.model, activeModelId));
  const capped = snapshot.models.filter((model) => model.cap > 0);
  capped.sort((a, b) => b.tokensUsed / b.cap - a.tokensUsed / a.cap);
  return capped[0];
}

/** `nan no cap · 12.4M this month` for a model NaN does not cap. */
function uncapped(tokens: number | undefined, dim: (text: string) => string): string {
  const amount = tokens === undefined ? "" : ` \u00b7 ${formatTokens(tokens)} this month`;
  return `nan ${dim(`no cap${amount}`)}`;
}

/** ` +125M` when a usable extra pool backs the model. */
function extraSuffix(quota: ModelQuota): string {
  if (!quota.extraTokens || quota.extraTokens <= 0 || quota.extraUsable === false) return "";
  return ` +${formatTokens(quota.extraTokens)}`;
}

/** `4d3h` until the server-reported reset. */
function resetSuffix(quota: ModelQuota, now: number): string {
  if (!quota.periodEnd) return "";
  const resetAt = Date.parse(quota.periodEnd);
  if (Number.isNaN(resetAt)) return "";
  return ` ${formatReset(resetAt - now)}`;
}

/**
 * ` 4h 12%` for a rolling window, only when the server reports its use. The
 * quota endpoint currently sends the window's size but not its consumption, so
 * the footer stays silent rather than printing a bare `4h`; `/nan-quota` shows
 * the size.
 */
function windowSuffix(quota: ModelQuota): string {
  if (!quota.windowHours || !quota.fullWindowTokens || quota.windowTokensUsed === undefined) return "";
  const percent = formatPercent(quota.windowTokensUsed, quota.fullWindowTokens);
  return ` ${quota.windowHours}h ${percent}%`;
}

/** ` · model 91%` for up to `maxAlerts` other models over the threshold. */
function alertSuffixes(snapshot: Snapshot, active: ModelQuota, options: StatusRenderOptions): string[] {
  const warnAt = options.warnAt ?? 80;
  const criticalAt = options.criticalAt ?? 95;
  const maxAlerts = options.maxAlerts ?? 2;
  if (maxAlerts <= 0) return [];

  const alerts = snapshot.models
    .filter((model) => model.cap > 0 && !sameModel(model.model, active.model))
    .map((model) => ({ model, percent: formatPercent(model.tokensUsed, model.cap) }))
    .filter((entry) => entry.percent >= warnAt)
    .sort((a, b) => b.percent - a.percent)
    .slice(0, maxAlerts);

  const theme = options.theme ?? plainTheme;
  return alerts.map((entry) => {
    const tone = entry.percent >= criticalAt ? "error" : "warning";
    return ` \u00b7 ${theme.fg(tone, `${entry.model.model} ${entry.percent}%`)}${extraSuffix(entry.model)}`;
  });
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
