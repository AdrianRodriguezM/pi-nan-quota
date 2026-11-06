// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Model ids and NaN detection.
 *
 * The quota endpoint is the source of truth for caps, but it also reports rows
 * the key cannot use: retired models (`glm5.2`) and models of a plan the member
 * does not hold (`glm5.3`, premium). The documented `GET /v1/models` is
 * filtered by plan on NaN's side, so intersecting both gives exactly "what this
 * key can call, and how much of it is left" — without a hard-coded list of
 * retired or premium models that would go stale.
 */

/**
 * Spellings seen in the wild for NaN ids. Kept small on purpose: guessing every
 * possible variant would hide provider bugs.
 */
const ALIASES: Readonly<Record<string, string>> = {
  "glm-5.3": "glm5.3",
  "glm-5.3-flash": "glm5.3-flash",
  "glm-5.2": "glm5.2",
  "qwen-3.8-flash": "qwen3.8-flash",
  "qwen-3.6": "qwen3.6",
  "mimo-2.6-flash": "mimo-v2.6-flash",
};

/**
 * Normalise an id: strip a leading `provider/`, lowercase, and resolve known
 * spelling variants.
 */
export function canonicalModelId(id: string): string {
  const trimmed = id.trim();
  const slash = trimmed.lastIndexOf("/");
  const bare = (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase();
  return ALIASES[bare] ?? bare;
}

/** Compare two ids that may use different spellings. */
export function sameModel(a: string, b: string): boolean {
  return canonicalModelId(a) === canonicalModelId(b);
}

/**
 * Keep the entries whose model the key can call.
 *
 * Fails open twice: with no served list (the request failed) everything is
 * kept, and if the intersection is empty while the input was not, the two
 * naming schemes disagree — keeping the payload beats blanking the footer.
 */
export function filterServed<T extends { model: string }>(entries: readonly T[], served: readonly string[] | undefined): T[] {
  if (!served || served.length === 0) return [...entries];
  const allowed = new Set(served.map(canonicalModelId));
  const kept = entries.filter((entry) => allowed.has(canonicalModelId(entry.model)));
  return kept.length > 0 || entries.length === 0 ? kept : [...entries];
}

/** True when the served list is known and does not contain `model`. */
export function isNotServed(model: string, served: readonly string[] | undefined): boolean {
  if (!served || served.length === 0) return false;
  const id = canonicalModelId(model);
  return !served.some((candidate) => canonicalModelId(candidate) === id);
}

/** NaN's inference hosts live under this domain (`api.nan.builders`). */
export const NAN_DOMAIN = "nan.builders";

/** True for a base URL on NaN's domain, e.g. `https://api.nan.builders/v1`. */
export function isNanBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === NAN_DOMAIN || host.endsWith(`.${NAN_DOMAIN}`);
}

/** The bits of a pi model this module looks at. */
export interface ModelLike {
  provider?: string;
  id?: string;
  baseUrl?: string;
}

/**
 * A model is NaN's when its provider is the configured one, or when it talks
 * to a NaN host — which is what makes `nan`, `nan-builders` and any custom
 * provider id work without configuration.
 */
export function isNanModel(model: ModelLike | undefined, providerId: string): boolean {
  if (!model) return false;
  if (model.provider !== undefined && model.provider === providerId) return true;
  return isNanBaseUrl(model.baseUrl);
}

/**
 * Pick the provider whose credential reads the quota.
 *
 *  1. the active model's provider, when it is a NaN one;
 *  2. otherwise the configured `providerId`, when some model uses it;
 *  3. otherwise the first provider with a model on a NaN host;
 *  4. otherwise the configured `providerId` (its key may still be in env).
 */
export function pickNanProvider(
  active: ModelLike | undefined,
  all: readonly ModelLike[],
  providerId: string,
): string {
  if (active?.provider && isNanModel(active, providerId)) return active.provider;
  if (all.some((model) => model.provider === providerId)) return providerId;
  const detected = all.find((model) => model.provider && isNanBaseUrl(model.baseUrl));
  return detected?.provider ?? providerId;
}
