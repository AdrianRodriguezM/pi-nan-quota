// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The footer bar: ten pills in a row, all of them in one violet.
 *
 *     ▱▱▱▱▱▱▱▱▱▱       0 %
 *     ▰▱▱▱▱▱▱▱▱▱    1–11 %
 *     ▰▰▱▱▱▱▱▱▱▱   12–22 %
 *     ▰▰▰▱▱▱▱▱▱▱   23–33 %
 *     ▰▰▰▰▱▱▱▱▱▱   34–44 %
 *     ▰▰▰▰▰▱▱▱▱▱   45–55 %
 *     ▰▰▰▰▰▰▱▱▱▱   56–66 %
 *     ▰▰▰▰▰▰▰▱▱▱   67–77 %
 *     ▰▰▰▰▰▰▰▰▱▱   78–88 %
 *     ▰▰▰▰▰▰▰▰▰▱   89–99 %
 *     ▰▰▰▰▰▰▰▰▰▰     100 %
 *
 * The scale is uniform. An empty bar means nothing used and a full bar means
 * the cap is reached, so the 99 values in between (1–99 %) are shared evenly
 * by the nine intermediate states: exactly eleven points each, with the half
 * bar centred on 50 %. Every step is one pill — the bar never skips one — and
 * the first unit of usage always lights the first pill.
 *
 * It is driven by the *printed* percentage, not the raw ratio, so the bar and
 * the number next to it can never disagree (a raw 50.04 % printed as `50%`
 * once drew five pills of eight).
 *
 * No gap between the used and the unused part: a blank cell there reads as a
 * pill that is missing, right where the usage currently is.
 *
 * One colour, two shapes: used pills are solid and the rest are hollow, both in
 * the same brand violet. A darker shade for the unused part is *not* an option —
 * on a dark terminal it reads as black, so half of the bar looks like it
 * disappeared. Colour carries the branding; the shape carries the progress.
 *
 * `▰` and `▱` (U+25B0, U+25B1) are East Asian Width `N` (neutral), so they are
 * one column wide even on terminals that render ambiguous-width characters
 * double. Fonts without the parallelograms (JetBrains Mono) can switch family
 * with {@link SAFE_GLYPHS}.
 *
 * The bar is always `BAR_WIDTH` columns wide, so the percentage next to it never
 * moves.
 *
 * Pure by construction — colours arrive as two callbacks — so the geometry is
 * testable without a terminal.
 */

/** Pills in the bar. Ten gives nine equal 11-point steps between 0 and 100. */
export const BAR_WIDTH = 10;

/** Default family: parallelograms, solid for used cells, hollow for the rest. */
export const PILL_GLYPHS = { fill: "\u25b0", empty: "\u25b1" } as const;

/** Fallback family for fonts without the parallelograms. */
export const SAFE_GLYPHS = { fill: "\u25aa", empty: "\u25ab" } as const;

export type GlyphStyle = "pill" | "safe";

export interface Glyphs {
  fill: string;
  empty: string;
}

/** The glyph pair for a family. */
export function glyphsFor(style: GlyphStyle): Glyphs {
  return style === "safe" ? SAFE_GLYPHS : PILL_GLYPHS;
}

/**
 * Used pills for a printed percentage: 0 only at 0 %, all of them only at
 * 100 %, and `ceil(percent × (width − 1) / 99)` in between, which splits
 * 1–99 % into `width − 1` equal steps.
 */
export function pillsFor(percent: number, width: number = BAR_WIDTH): number {
  const cells = Math.max(1, Math.trunc(width));
  const value = Number.isFinite(percent) ? Math.round(percent) : 0;
  if (value <= 0) return 0;
  if (value >= 100) return cells;
  return Math.min(cells - 1, Math.max(1, Math.ceil((value * (cells - 1)) / 99)));
}

export interface BarOptions {
  /** Pills in the bar (default {@link BAR_WIDTH}). */
  width?: number;
  /** Glyph pair; {@link PILL_GLYPHS} by default. */
  glyphs?: Glyphs;
  /** Painter for the used pills; identity when omitted. */
  fill?: (text: string) => string;
  /** Painter for the unused pills; identity when omitted. */
  empty?: (text: string) => string;
}

/**
 * Render the bar for a printed percentage (`0`–`100`; rounded, clamped, and
 * `NaN` counts as 0). Always `width` columns.
 */
export function renderBar(percent: number, options: BarOptions = {}): string {
  const width = Math.max(1, Math.trunc(options.width ?? BAR_WIDTH));
  const glyphs = options.glyphs ?? PILL_GLYPHS;
  const fill = options.fill ?? identity;
  const empty = options.empty ?? identity;

  const used = pillsFor(percent, width);
  const usedPart = used > 0 ? fill(glyphs.fill.repeat(used)) : "";
  const emptyPart = used < width ? empty(glyphs.empty.repeat(width - used)) : "";
  return usedPart + emptyPart;
}

const identity = (text: string): string => text;
