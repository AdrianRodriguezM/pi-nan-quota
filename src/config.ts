// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `~/.pi/agent/nan-quota.json`.
 *
 * Everything is optional and validated field by field: a hand-edited file with
 * one bad value must not take the extension down, so invalid fields fall back
 * to their defaults instead of rejecting the whole document.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type GlyphStyleSetting = "pill" | "safe";

export interface NanQuotaConfig {
  /** Cache TTL for a successful read. */
  refreshSeconds: number;
  /** Footer alerts start at this percentage. */
  warnAt: number;
  /** Theme `error` starts at this percentage. */
  criticalAt: number;
  /** How many other models the segment may alert about. */
  maxAlerts: number;
  /** Show the segment even when the active model is not a NaN one. */
  alwaysShow: boolean;
  providerId: string;
  /** Glyph family for the bar: the pill (default) or the font-safe squares. */
  glyphs: GlyphStyleSetting;
  /**
   * Read the undocumented `cloud-api.nan.builders` quota endpoint. `false`
   * keeps every request on the documented `api.nan.builders` and estimates the
   * percentages from the published caps.
   */
  quotaEndpoint: boolean;
  /** Restrict the table and footer to these models (empty = all known). */
  models: string[];
}

/** Floor for `refreshSeconds`, protecting NaN's rate limit. */
export const MIN_REFRESH_SECONDS = 30;

export const DEFAULT_CONFIG: NanQuotaConfig = {
  refreshSeconds: 120,
  warnAt: 80,
  criticalAt: 95,
  maxAlerts: 2,
  alwaysShow: false,
  providerId: "nan",
  glyphs: "pill",
  quotaEndpoint: true,
  models: [],
};

/** Absolute path of the config file. */
export function configPath(home: string = homedir()): string {
  return join(home, ".pi", "agent", "nan-quota.json");
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const inRange = (value: unknown, min: number, max: number): number | undefined =>
  isFiniteNumber(value) && value >= min && value <= max ? value : undefined;

/** Merge a parsed JSON document over the defaults, ignoring invalid fields. */
export function parseConfig(raw: unknown): NanQuotaConfig {
  const config: NanQuotaConfig = { ...DEFAULT_CONFIG, models: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return config;
  const source = raw as Record<string, unknown>;

  const refreshSeconds = inRange(source["refreshSeconds"], 1, 86_400);
  // Two requests per refresh: anything faster than 30 s would eat into the
  // 30 requests/minute NaN allows on /v1/usage for no visible benefit.
  if (refreshSeconds !== undefined) config.refreshSeconds = Math.max(MIN_REFRESH_SECONDS, refreshSeconds);

  const warnAt = inRange(source["warnAt"], 1, 100);
  if (warnAt !== undefined) config.warnAt = Math.round(warnAt);

  const criticalAt = inRange(source["criticalAt"], 1, 100);
  if (criticalAt !== undefined) config.criticalAt = Math.round(criticalAt);
  // A critical threshold below the warning one would invert the tone logic.
  if (config.criticalAt < config.warnAt) config.criticalAt = config.warnAt;

  const maxAlerts = inRange(source["maxAlerts"], 0, 10);
  if (maxAlerts !== undefined) config.maxAlerts = Math.floor(maxAlerts);

  if (typeof source["alwaysShow"] === "boolean") config.alwaysShow = source["alwaysShow"];
  if (typeof source["quotaEndpoint"] === "boolean") config.quotaEndpoint = source["quotaEndpoint"];

  const providerId = source["providerId"];
  if (typeof providerId === "string" && providerId.trim() !== "") config.providerId = providerId.trim();

  const glyphs = source["glyphs"];
  if (glyphs === "pill" || glyphs === "safe") config.glyphs = glyphs;

  const models = source["models"];
  if (Array.isArray(models)) {
    config.models = models
      .filter((model): model is string => typeof model === "string" && model.trim() !== "")
      .map((model) => model.trim());
  }
  return config;
}

/**
 * Read and validate the config file. Missing file, unreadable file and invalid
 * JSON all resolve to the defaults.
 */
export function loadConfig(path: string = configPath(), read?: (path: string) => string): NanQuotaConfig {
  const reader = read ?? ((target: string) => readFileSync(target, "utf8"));
  let text: string;
  try {
    text = reader(path);
  } catch {
    return { ...DEFAULT_CONFIG, models: [] };
  }
  try {
    return parseConfig(JSON.parse(text) as unknown);
  } catch {
    return { ...DEFAULT_CONFIG, models: [] };
  }
}
