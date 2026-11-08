// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * pi-nan-quota — NaN Builders quota in the pi footer.
 *
 * Read-only by design: it never registers a provider, never writes
 * configuration and never touches `auth.json`. On each refresh it reads, in
 * parallel,
 *
 *  - the quota endpoint (caps, reset, extra pools; undocumented, can be off),
 *  - the documented usage report (month consumption, all-time totals),
 *  - the documented model list (what this key can call; cached for an hour),
 *
 * keeps the last good answer in memory, and paints one status line:
 *
 *     nan ▰▰▰▰▰▰▱▱▱▱  62% 4d3h · glm5.3-flash 91%
 *
 * `/nan-quota` prints the per-model table in the transcript as a custom entry,
 * which pi keeps out of the model's context.
 *
 * Silences: nothing is requested and nothing is drawn while the active model is
 * not a NaN one (unless `alwaysShow`), and the renderer never waits for the
 * network.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { fetchServedModels, SERVED_TTL_MS } from "./api/models.ts";
import { fetchQuota, type ParsedQuota } from "./api/quota.ts";
import { fetchUsage, utcDate } from "./api/usage.ts";
import { resolveApiKey } from "./auth.ts";
import { CAPS, CAPS_AS_OF, labelFor } from "./caps.ts";
import { Debouncer, MODEL_SELECT_MAX_AGE_MS, QuotaCache, TURN_DEBOUNCE_MS } from "./cache.ts";
import { describeFailure, HELP_TEXT, renderQuotaReport } from "./command.ts";
import { loadConfig, type NanQuotaConfig } from "./config.ts";
import { canonicalModelId, filterServed, isNanModel, pickNanProvider, type ModelLike } from "./models.ts";
import { detectColorMode, paintBars } from "./render/color.ts";
import { renderStatus, STATUS_KEY, type StatusRenderOptions } from "./render/status.ts";
import { FetchError, toFetchError, type ModelQuota, type Snapshot, type UsageReport } from "./types.ts";

/** Custom entry used to print the table without sending it to the model. */
export const ENTRY_TYPE = "nan-quota";

/** Oldest pi this extension is tested against (see the compatibility CI job). */
export const MIN_PI_VERSION = "1.3.0";

/** Extension API the extension cannot work without. */
const REQUIRED_API = ["on", "registerCommand", "registerEntryRenderer", "appendEntry"] as const;

type Settled<T> = { ok: true; value: T } | { ok: false; error: FetchError };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: toFetchError(error) };
  }
}

export default function piNanQuota(pi: ExtensionAPI): void {
  const missing = REQUIRED_API.filter((name) => typeof (pi as unknown as Record<string, unknown>)[name] !== "function");
  if (missing.length > 0) {
    // Fail loudly and once instead of throwing halfway through registration.
    const message = `pi-nan-quota needs pi >= ${MIN_PI_VERSION} (missing ${missing.join(", ")}); it is disabled.`;
    if (typeof pi.on === "function") {
      pi.on("session_start", async (_event, ctx) => {
        if (ctx.hasUI) ctx.ui.notify(message, "error");
      });
    } else {
      console.warn(message);
    }
    return;
  }

  let config: NanQuotaConfig = loadConfig();
  let context: ExtensionContext | undefined;
  let warnedEstimate = false;
  let served: { ids: string[]; at: number } | undefined;
  /**
   * Last model pi told us about.
   *
   * `ctx.model` is not guaranteed on every event context; reading it only when
   * present is the difference between "the segment stays" and "the segment
   * flickers away on that event". Only an explicit non-NaN model clears it.
   */
  let lastModel: ModelLike | undefined;

  /** Every model pi knows, reduced to what NaN detection needs. */
  function allModels(): ModelLike[] {
    try {
      return (context?.modelRegistry.getAll() ?? []).map((model) => ({
        provider: model.provider,
        id: model.id,
        baseUrl: model.baseUrl,
      }));
    } catch {
      return [];
    }
  }

  /** Provider whose credential reads the quota (see `pickNanProvider`). */
  function keyProvider(): string {
    return pickNanProvider(lastModel, allModels(), config.providerId);
  }

  /** True when the active model is a NaN one, or the user asked to always show. */
  function shouldShow(): boolean {
    return config.alwaysShow || isNanModel(lastModel, config.providerId);
  }

  /** Served ids, refreshed hourly; a failed read keeps the previous list. */
  async function servedModels(key: string): Promise<string[] | undefined> {
    const now = Date.now();
    if (served && now - served.at < SERVED_TTL_MS) return served.ids;
    try {
      served = { ids: await fetchServedModels(key), at: now };
    } catch {
      // Fail open: without the list nothing is filtered (see `filterServed`).
    }
    return served?.ids;
  }

  /**
   * One read. The quota endpoint is primary; when it fails for any reason other
   * than a rejected key — or the user turned it off — the documented usage
   * report and the dated caps table take over, marked as estimates.
   */
  async function loadSnapshot(): Promise<Snapshot> {
    const at = Date.now();
    const provider = keyProvider();
    const key = await resolveApiKey(context?.modelRegistry, provider);
    if (!key) throw new FetchError("auth", `no API key for provider "${provider}"`);

    const [quota, usage, ids] = await Promise.all([
      config.quotaEndpoint ? settle(fetchQuota(key)) : Promise.resolve(undefined),
      settle(fetchUsage(key)),
      servedModels(key),
    ]);
    const usageReport = usage.ok ? usage.value : undefined;

    if (quota?.ok) {
      warnedEstimate = false;
      return applyModelFilter(snapshotFromQuota(quota.value, at, { usage: usageReport, served: ids }), config);
    }
    if (quota && !quota.ok && quota.error.kind === "auth") throw quota.error;
    if (!usage.ok) throw quota && !quota.ok ? quota.error : usage.error;

    if (quota && !quota.ok && !warnedEstimate) {
      warnedEstimate = true;
      if (context?.hasUI) {
        context.ui.notify(
          `nan-quota: the quota endpoint failed (${quota.error.message}); showing estimates from /v1/usage and the ${CAPS_AS_OF} caps`,
          "warning",
        );
      }
    }
    const snapshot = snapshotFromUsage(usage.value, at, { served: ids });
    if (!config.quotaEndpoint) snapshot.quotaEndpointDisabled = true;
    return applyModelFilter(snapshot, config);
  }

  const cache = new QuotaCache({
    fetchSnapshot: loadSnapshot,
    ttlMs: () => config.refreshSeconds * 1000,
    notify: (failure, level) => {
      if (context?.hasUI) context.ui.notify(`nan-quota: ${describeFailure(failure, keyProvider())}`, level);
    },
  });

  const debouncer = new Debouncer(TURN_DEBOUNCE_MS, () => {
    const ctx = context;
    if (!ctx || !shouldShow()) return;
    void refresh(ctx, {});
  });

  /** Refresh through the cache and repaint. Never rejects. */
  async function refresh(
    ctx: ExtensionContext,
    options: { force?: boolean; maxAgeMs?: number },
  ): Promise<Snapshot | undefined> {
    context = ctx;
    let snapshot: Snapshot | undefined;
    try {
      snapshot = await cache.get(options);
    } catch {
      snapshot = cache.getSnapshot();
    }
    pushStatus(ctx);
    return snapshot;
  }

  /** Remember the active model when the context carries one. */
  function rememberModel(ctx: ExtensionContext): void {
    if (!ctx.model) return;
    const model: ModelLike = {};
    if (ctx.model.provider !== undefined) model.provider = ctx.model.provider;
    if (ctx.model.id !== undefined) model.id = ctx.model.id;
    if (typeof ctx.model.baseUrl === "string") model.baseUrl = ctx.model.baseUrl;
    lastModel = model;
  }

  /** Repaint the footer segment from whatever the cache currently holds. */
  function pushStatus(ctx: ExtensionContext): void {
    rememberModel(ctx);
    const state = cache.getState();
    const options: StatusRenderOptions = {
      now: Date.now(),
      mode: detectColorMode(),
      theme: ctx.ui.theme,
      show: shouldShow(),
      activeModelId: isNanModel(lastModel, config.providerId) ? lastModel?.id : undefined,
      warnAt: config.warnAt,
      criticalAt: config.criticalAt,
      maxAlerts: config.maxAlerts,
      glyphStyle: process.env.PI_NAN_QUOTA_GLYPHS === "safe" ? "safe" : config.glyphs,
      failed: state.lastError !== undefined,
    };
    if (state.lastGoodAt !== undefined) options.lastGoodAt = state.lastGoodAt;
    try {
      ctx.ui.setStatus(STATUS_KEY, renderStatus(state.snapshot, options));
    } catch {
      // A footer that cannot be painted must never break the turn.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    rememberModel(ctx);
    // The config file is re-read here so `/reload` picks edits up.
    config = loadConfig();
    warnedEstimate = false;
    served = undefined;
    if (shouldShow()) await refresh(ctx, { force: true });
    else pushStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    context = ctx;
    // A switch must repaint immediately: never leave a previous model's bar.
    pushStatus(ctx);
    if (shouldShow()) await refresh(ctx, { maxAgeMs: MODEL_SELECT_MAX_AGE_MS });
  });

  pi.on("turn_end", async (_event, ctx) => {
    context = ctx;
    rememberModel(ctx);
    if (shouldShow()) debouncer.trigger();
  });

  pi.on("session_shutdown", async () => {
    debouncer.cancel();
  });

  pi.registerEntryRenderer<{ text: string }>(
    ENTRY_TYPE,
    (entry) => new Text(paintBars(entry.data?.text ?? "", detectColorMode()), 0, 0),
  );

  pi.registerCommand("nan-quota", {
    description: "Show NaN Builders quota per model (refresh | help)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      context = ctx;
      rememberModel(ctx);
      const command = args.trim().toLowerCase();
      if (command === "help" || command === "-h" || command === "--help") {
        pi.appendEntry<{ text: string }>(ENTRY_TYPE, { text: HELP_TEXT });
        return;
      }
      const snapshot = await refresh(ctx, command === "refresh" || command === "r" ? { force: true } : {});
      const error = cache.getState().lastError;
      const input: Parameters<typeof renderQuotaReport>[0] = {
        now: Date.now(),
        capsAsOf: CAPS_AS_OF,
        provider: keyProvider(),
      };
      if (snapshot !== undefined) input.snapshot = snapshot;
      if (snapshot?.usage !== undefined) input.usage = snapshot.usage;
      if (error !== undefined) input.error = error;
      pi.appendEntry<{ text: string }>(ENTRY_TYPE, { text: renderQuotaReport(input) });
    },
  });
}

export interface SnapshotExtras {
  usage?: UsageReport | undefined;
  served?: string[] | undefined;
}

/** Build a snapshot from the quota endpoint payload. */
export function snapshotFromQuota(parsed: ParsedQuota, at: number, extras: SnapshotExtras = {}): Snapshot {
  const models = filterServed(parsed.models, extras.served);
  const snapshot: Snapshot = {
    source: "quota",
    estimated: false,
    fetchedAt: at,
    models,
  };
  if (parsed.periodStart !== undefined) snapshot.periodStart = parsed.periodStart;
  if (parsed.updatedAt !== undefined) snapshot.updatedAt = parsed.updatedAt;
  const periodEnd = pickPeriodEnd(models);
  if (periodEnd !== undefined) snapshot.periodEnd = periodEnd;
  if (extras.usage !== undefined) snapshot.usage = extras.usage;
  if (extras.served !== undefined) snapshot.served = extras.served;
  return snapshot;
}

/**
 * Build an estimated snapshot from `/v1/usage`: monthly consumption from the
 * server, caps from the dated docs table, restricted to what the key can call.
 */
export function snapshotFromUsage(usage: UsageReport, at: number, extras: SnapshotExtras = {}): Snapshot {
  const periodStart = `${utcDate(at).slice(0, 7)}-01`;
  const periodEnd = nextMonthStartIso(at);
  const models: ModelQuota[] = CAPS.map((entry) => {
    const tokensUsed = usage.byModel[entry.model] ?? 0;
    const model: ModelQuota = {
      model: entry.model,
      label: labelFor(entry.model),
      cap: entry.cap,
      tokensUsed,
      remaining: Math.max(0, entry.cap - tokensUsed),
      periodStart,
      periodEnd,
    };
    if (entry.windowHours !== undefined) model.windowHours = entry.windowHours;
    if (entry.fullWindowTokens !== undefined) model.fullWindowTokens = entry.fullWindowTokens;
    return model;
  });
  const snapshot: Snapshot = {
    source: "usage",
    estimated: true,
    periodStart,
    periodEnd,
    fetchedAt: at,
    models: filterServed(models, extras.served),
    usage,
  };
  if (extras.served !== undefined) snapshot.served = extras.served;
  return snapshot;
}

/** Restrict the snapshot to `config.models` when the user set a list. */
export function applyModelFilter(snapshot: Snapshot, config: NanQuotaConfig): Snapshot {
  if (config.models.length === 0) return snapshot;
  const allowed = new Set(config.models.map((model) => canonicalModelId(model)));
  const models = snapshot.models.filter((model) => allowed.has(canonicalModelId(model.model)));
  if (models.length === 0) return snapshot;
  return { ...snapshot, models };
}

/**
 * Most common reset among the models on screen.
 *
 * The captured payload reports `2026-12-01` for the four monthly models and
 * `2026-12-02` for the windowed glm; the shared date is the one the header
 * should show.
 */
function pickPeriodEnd(models: readonly ModelQuota[]): string | undefined {
  const counts = new Map<string, number>();
  for (const model of models) {
    if (!model.periodEnd) continue;
    counts.set(model.periodEnd, (counts.get(model.periodEnd) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [periodEnd, count] of counts) {
    if (count > bestCount) {
      best = periodEnd;
      bestCount = count;
    }
  }
  return best;
}

/** `2026-12-01T00:00:00Z` for a timestamp inside November. */
function nextMonthStartIso(at: number): string {
  const date = new Date(at);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0);
  return new Date(end).toISOString().replace(".000Z", "Z");
}
