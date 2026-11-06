// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Number and duration formatting.
 *
 * Sizes use decimal SI-style suffixes at one decimal place (`1.2B`, `34.5M`,
 * `14.8k`), the shape NaN's docs use for quotas. A whole three-digit mantissa
 * below billions drops the decimal, so caps read `500M` / `400M` rather than
 * `500.0M`, while `3.0B` keeps it.
 */

const UNITS: readonly { suffix: string; scale: number }[] = [
  { suffix: "B", scale: 1e9 },
  { suffix: "M", scale: 1e6 },
  { suffix: "k", scale: 1e3 },
];

/** 606966720 -> "607.0M", 3000000000 -> "3.0B", 500000000 -> "500M". */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return "0";
  const value = Math.max(0, tokens);
  for (const unit of UNITS) {
    if (value < unit.scale) continue;
    const mantissa = value / unit.scale;
    // `3.0B` is handy at the top of the scale; `500M` reads better than
    // `500.0M`, so whole three-digit mantissas below billions lose the `.0`.
    const text =
      unit.suffix !== "B" && mantissa >= 100 && Number.isInteger(mantissa)
        ? mantissa.toFixed(0)
        : mantissa.toFixed(1);
    return `${text}${unit.suffix}`;
  }
  return String(Math.round(value));
}

/** Integer percentage of a cap. Rounding, never negative, may exceed 100. */
export function formatPercent(used: number, cap: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return 0;
  return Math.max(0, Math.round((used / cap) * 100));
}

/** Compact "time until reset": `4d3h`, `3h20m`, `12m`. */
export function formatReset(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

/** Spaced variant for the table header: `24d 3h`. */
export function formatResetLong(ms: number): string {
  const compact = formatReset(ms);
  const match = /^(\d+)([dhm])(\d+)([hm])$/.exec(compact);
  if (match) return `${match[1]}${match[2]} ${match[3]}${match[4]}`;
  return compact;
}

/** Age of the last good read, as the footer suffix: `5m`, `2h`. */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
