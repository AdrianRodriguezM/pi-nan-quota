// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Colour policy.
 *
 * The bar is drawn in NaN's corporate violet on both halves — a single colour.
 * A darker tone for the unused cells reads as black on a dark terminal, which
 * made half of the bar look like it had disappeared; the shape of the glyph
 * (solid against hollow) carries the progress instead.
 *
 * The colour is emitted directly (rather than through the theme) because
 * terminals have no token for it, with three explicit modes so the renderer
 * stays a pure function:
 *
 *  - `truecolor` when `COLORTERM` advertises 24-bit support,
 *  - `ansi256` (#98) otherwise,
 *  - `none` when `NO_COLOR` is set or `TERM=dumb`.
 *
 * Theme tokens still win above the warning/critical thresholds: a quota that is
 * about to run out should look like a warning, not like branding.
 */

export type ColorMode = "truecolor" | "ansi256" | "none";

/** Brand violet `#7D39EB`. */
export const BRAND_RGB = [125, 57, 235] as const;

/** Nearest xterm-256 entry for the brand violet. */
export const BRAND_ANSI256 = 99;

const RESET_FG = "\u001b[39m";

/** Pick a colour mode from the environment. */
export function detectColorMode(env: Record<string, string | undefined> = process.env): ColorMode {
  if (env.NO_COLOR !== undefined) return "none";
  if (env.TERM === "dumb") return "none";
  const colorTerm = env.COLORTERM ?? "";
  if (/truecolor|24bit/i.test(colorTerm)) return "truecolor";
  return "ansi256";
}

/** Wrap `text` in the brand violet, using the requested mode. */
export function paintBrand(text: string, mode: ColorMode): string {
  if (text === "" || mode === "none") return text;
  if (mode === "truecolor") {
    return `\u001b[38;2;${BRAND_RGB[0]};${BRAND_RGB[1]};${BRAND_RGB[2]}m${text}${RESET_FG}`;
  }
  return `\u001b[38;5;${BRAND_ANSI256}m${text}${RESET_FG}`;
}

/**
 * Every glyph the bars are drawn with, in either family, plus the eighth
 * blocks of the seven-day sparkline (`▁`–`█`). Nothing else in the table uses
 * them.
 */
const BAR_GLYPHS = /[\u25b0\u25b1\u25aa\u25ab\u2581-\u2588]+/g;

/**
 * Paint the bars inside a block of plain text (the `/nan-quota` table) in the
 * brand violet. The stored entry stays plain; colour is applied when drawn, so
 * it follows the terminal of whoever reopens the session.
 */
export function paintBars(text: string, mode: ColorMode): string {
  if (mode === "none") return text;
  return text.replace(BAR_GLYPHS, (bar) => paintBrand(bar, mode));
}

/** The slice of pi's `Theme` the renderer depends on. */
export interface ThemeLike {
  fg(color: ThemeColorName, text: string): string;
}

/** Theme tokens this extension uses. */
export type ThemeColorName = "dim" | "muted" | "warning" | "error" | "accent" | "text";

/** Theme stand-in for tests and for contexts without a TUI. */
export const plainTheme: ThemeLike = {
  fg: (_color: ThemeColorName, text: string) => text,
};
