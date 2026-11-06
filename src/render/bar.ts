// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The footer bar: eight pills in a row, all of them in one violet.
 *
 *     ▰▰▱▱▱▱▱▱      21 %
 *     ▰▰▰▰▰▰▱▱      71 %
 *     ▰▰▰▰▰▰▰▰     100 %
 *     ▱▱▱▱▱▱▱▱       0 %
 *
 * No gap between the used and the unused part: a blank cell there reads as a
 * pill that is missing, right where the usage currently is. The cell that is in
 * progress counts as used (`ceil`), so the usage always ends on a solid pill.
 *
 * One colour, two shapes: the cells that have been used are solid and the rest
 * are hollow, and both are the same brand violet. A darker shade for the empty
 * half is *not* an option — on a dark terminal it reads as black, so half of the
 * bar looks like it disappeared. Colour carries the branding; the shape carries
 * the progress.
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

/** Cells in the bar, gap excluded. */
export const BAR_WIDTH = 8;

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

export interface BarOptions {
  /** Cells in the bar (default {@link BAR_WIDTH}). */
  width?: number;
  /** Glyph pair; {@link PILL_GLYPHS} by default. */
  glyphs?: Glyphs;
  /** Painter for the used cells; identity when omitted. */
  fill?: (text: string) => string;
  /** Painter for the unused cells; identity when omitted. */
  empty?: (text: string) => string;
  /** Minimum used cells while `0 < ratio < 1` (`ceil` already gives 1). */
  minimum?: number;
  /** Maximum used cells while `0 < ratio < 1`; defaults to `width - 1`. */
  maximum?: number;
}

/** Render the bar for `ratio` in `[0, 1]`; always `width` columns. */
export function renderBar(ratio: number, options: BarOptions = {}): string {
  const width = options.width ?? BAR_WIDTH;
  const glyphs = options.glyphs ?? PILL_GLYPHS;
  const fill = options.fill ?? identity;
  const empty = options.empty ?? identity;

  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  if (clamped <= 0) return empty(glyphs.empty.repeat(width));
  if (clamped >= 1) return fill(glyphs.fill.repeat(width));

  const floor = Math.min(width, Math.max(0, Math.trunc(options.minimum ?? 0)));
  const ceiling = Math.min(width, Math.max(1, Math.trunc(options.maximum ?? width - 1)));
  // The cell the usage is currently in is drawn solid: the bar ends on a pill.
  const used = Math.min(ceiling, Math.max(1, floor, Math.ceil(clamped * width)));
  return fill(glyphs.fill.repeat(used)) + empty(glyphs.empty.repeat(width - used));
}

const identity = (text: string): string => text;
