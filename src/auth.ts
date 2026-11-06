// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * API key resolution.
 *
 * pi's model registry is authoritative: it knows about `/login nan`, OAuth and
 * keys stored in `auth.json`. `NAN_API_KEY` is only a fallback for headless
 * setups. The key is returned to the caller and never logged, formatted into a
 * message, or put in an error — every failure path below stays key-free.
 */

/** The slice of `ctx.modelRegistry` this module needs. */
export interface ApiKeyRegistry {
  getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

/** Resolve the NaN key: model registry first, `NAN_API_KEY` second. */
export async function resolveApiKey(
  registry: ApiKeyRegistry | undefined,
  providerId = "nan",
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  if (registry) {
    try {
      const fromRegistry = await registry.getApiKeyForProvider(providerId);
      const trimmed = fromRegistry?.trim();
      if (trimmed) return trimmed;
    } catch {
      // A provider without configured auth throws or resolves undefined; both
      // mean "try the environment next", and neither is worth surfacing.
    }
  }
  const fromEnv = env.NAN_API_KEY?.trim();
  return fromEnv ? fromEnv : undefined;
}
