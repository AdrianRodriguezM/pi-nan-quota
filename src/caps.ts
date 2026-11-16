// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Model display labels.
 *
 * Since NaN moved to a shared credit pool (2026-11), there are no per-model
 * caps to transcribe, so this table only carries display labels from
 * https://nan.builders/docs/choose-a-model. The set of models a key can call
 * always comes from the API (`/v1/models`), never from this table.
 *
 * Captured 2026-11-10 from the docs page.
 */

export const LABELS_AS_OF = "2026-11-10";

export interface LabelEntry {
  model: string;
  label: string;
}

/** Order = the docs page order. */
export const LABELS: readonly LabelEntry[] = [
  { model: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { model: "glm5.3", label: "GLM 5.3" },
  { model: "glm5.3-flash", label: "GLM 5.3 Flash" },
  { model: "qwen3.8-flash", label: "Qwen 3.8 Flash" },
  { model: "mimo-v2.6-flash", label: "MiMo V2.6 Flash" },
  { model: "kimi-k3.1-pro", label: "Kimi K3.1 Pro" },
  { model: "qwen3.8-max", label: "Qwen 3.8 Max" },
  { model: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { model: "hy4", label: "HY4" },
  { model: "gemma4", label: "Gemma 4" },
  { model: "qwen3.6", label: "Qwen 3.6" },
  { model: "qwen3-embedding", label: "Qwen 3 Embedding" },
  { model: "rerank", label: "Rerank" },
  { model: "kokoro", label: "Kokoro" },
  { model: "whisper", label: "Whisper" },
];

/** Display label for a canonical model id; the id itself for unknown ones. */
export function labelFor(model: string): string {
  return LABELS.find((entry) => entry.model === model)?.label ?? model;
}
