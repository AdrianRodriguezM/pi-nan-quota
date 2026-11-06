// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The served-models list.
 *
 * `GET https://api.nan.builders/v1/models` is documented and OpenAI-compatible.
 * NaN filters it by the key's plan: a member key does not see `glm5.3`
 * (premium) and nobody sees retired models such as `glm5.2`, while new models
 * show up the day they are served. That makes it the right list to decide which
 * quota rows belong on screen.
 *
 * It also lists non-chat endpoints (embeddings, rerank, speech, images). They
 * are kept: a membership check only asks "can this key call that id".
 */

import { canonicalModelId } from "../models.ts";
import { FetchError } from "../types.ts";
import { assertOk, requestHeaders } from "./quota.ts";

export const MODELS_URL = "https://api.nan.builders/v1/models";

/** The list changes when NaN adds or retires a model, not minute to minute. */
export const SERVED_TTL_MS = 60 * 60_000;

const schemaError = (detail: string) => new FetchError("schema", `models: ${detail}`);

/** Validate a `/v1/models` payload into canonical ids. */
export function parseModelsPayload(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw schemaError("response is not an object");
  }
  const data = (payload as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) throw schemaError("data is not an array");
  const ids = new Set<string>();
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as Record<string, unknown>)["id"];
    if (typeof id === "string" && id.trim() !== "") ids.add(canonicalModelId(id));
  }
  return [...ids];
}

export interface ModelsApiDeps {
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
}

/** Fetch the ids this key can call. Throws `FetchError` only. */
export async function fetchServedModels(apiKey: string, deps: ModelsApiDeps = {}): Promise<string[]> {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  let response: Response;
  try {
    response = await doFetch(MODELS_URL, { headers: requestHeaders(apiKey) });
  } catch (error) {
    throw new FetchError("network", `models: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertOk(response, "models", now());
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw schemaError("response is not valid JSON");
  }
  return parseModelsPayload(payload);
}
