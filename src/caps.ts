// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Dated caps table.
 *
 * Used only when the quota endpoint is off or failing: the documented
 * `/v1/usage` endpoint reports consumption but not caps, so that path needs a
 * local copy of the published limits. It is dated on purpose — every
 * percentage derived from it is marked as an estimate tied to this date. It
 * also supplies display labels and the table order.
 */

/** Date the table was transcribed from https://nan.builders/docs/models. */
export const CAPS_AS_OF = "2026-11-06";

export interface CapEntry {
  model: string;
  label: string;
  /** Tokens per calendar month; `0` means the model has no cap. */
  cap: number;
  windowHours?: number;
  fullWindowTokens?: number;
}

/**
 * Order matters: the `/nan-quota` table lists models in this order, which is
 * the order the docs use (capped models first, unlimited ones last).
 */
export const CAPS: readonly CapEntry[] = [
  { model: "deepseek-v4-flash", label: "DeepSeek V4 Flash", cap: 3_000_000_000 },
  { model: "glm5.3-flash", label: "GLM 5.3 Flash", cap: 2_000_000_000 },
  { model: "mimo-v2.6-flash", label: "MiMo V2.6 Flash", cap: 1_000_000_000 },
  { model: "qwen3.8-flash", label: "Qwen 3.8 Flash", cap: 500_000_000 },
  {
    model: "glm5.3",
    label: "GLM 5.3 (premium)",
    cap: 3_000_000_000,
    windowHours: 4,
    fullWindowTokens: 400_000_000,
  },
  { model: "qwen3.6", label: "Qwen 3.6", cap: 0 },
  { model: "gemma4", label: "Gemma 4", cap: 0 },
];

/** Look up a canonical model id in the dated table. */
export function capFor(model: string): CapEntry | undefined {
  return CAPS.find((entry) => entry.model === model);
}

/** Display label for a canonical model id. */
export function labelFor(model: string): string {
  return capFor(model)?.label ?? model;
}
