// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * pi-nan-quota — NaN Builders credits in the pi footer.
 *
 * Read-only by design: it never registers a provider, never writes
 * configuration and never touches `auth.json`. On each refresh it reads
 *
 *  - the documented usage report (`/v1/usage`): the account's credit balance
 *    for the billing period (one shared pool, drawn at each model's price per
 *    token) plus per-model consumption over the window — the primary data,
 *  - the documented model list (`/v1/models`, cached hourly): what this key
 *    can call, which filters the table.
 *
 * One usage request per refresh. The window requested is the billing period
 * when its start is known and remembered from the previous read; on the first
 * load, or right after a period rollover, the response reveals a period whose
 * window differs from the one asked for, and the loader re-requests once
 * with the right window (the only case that costs a second request).
 *
 * It paints one status line:
 *
 *     nan ▰▰▰▰▰▱▱▱▱▱ 3745 cr · ⚠ ~8d · resets 15d23h
 *
 * a fuel gauge of the shared pool (full at the period start). `/nan-quota`
 * prints the balance, the pace and the per-model table in the transcript as a
 * custom entry, which pi keeps out of the model's context.
 *
 * Silences: nothing is requested and nothing is drawn while the active model
 * is not a NaN one (unless `alwaysShow`), and the renderer never waits for the
 * network.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { fetchServedModels, SERVED_TTL_MS } from "./api/models.ts";
import { fetchUsage, usageWindow } from "./api/usage.ts";
import { resolveApiKey } from "./auth.ts";
import { Debouncer, MODEL_SELECT_MAX_AGE_MS, QuotaCache, TURN_DEBOUNCE_MS } from "./cache.ts";
import { describeFailure, HELP_TEXT, renderQuotaReport } from "./command.ts";
import { loadConfig, type NanQuotaConfig } from "./config.ts";
import { canonicalModelId, filterServedIds, isNanModel, pickNanProvider, type ModelLike } from "./models.ts";
import { projectPace } from "./pace.ts";
import { detectColorMode, paintBars } from "./render/color.ts";
import { renderStatus, snapshotClearsCreditRunOut, STATUS_KEY, type StatusRenderOptions } from "./render/status.ts";
import { FetchError, type CreditBalance, type ModelTotals, type Snapshot, type UsageReport } from "./types.ts";

/** Custom entry used to print the table without sending it to the model. */
export const ENTRY_TYPE = "nan-quota";

/** Oldest pi this extension is tested against (see the compatibility CI job). */
export const MIN_PI_VERSION = "1.3.0";

/** Extension API the extension cannot work without. */
const REQUIRED_API = ["on", "registerCommand", "registerEntryRenderer", "appendEntry"] as const;

/** The assistant-error text that says the credit pool ran out. */
const CREDIT_EXHAUSTED = /insufficient_balance|\b402\b/;

/** The billing period revealed by the last successful read. */
interface RememberedPeriod {
  /** `YYYY-MM-DD` of `credits.period_start`. */
  startDay: string;
  /** Epoch ms of `credits.period_end`; the period is forgotten once passed. */
  endMs: number;
}

/** First credit reading of this pi session (the baseline of the session line). */
export interface SessionBaseline {
  /** `fetchedAt` of the reading this baseline comes from. */
  fetchedAt: number;
  periodStart: string;
  used: number;
  packCredits: number;
}

/** One credit reading: the snapshot fields the session line looks at. */
export interface SessionReading {
  fetchedAt: number;
  credits: CreditBalance;
}

/**
 * Pure core of the `/nan-quota` session line: credits burned since the
 * session's first reading. The first reading, a repeated (cached) reading
 * and the first reading after a period rollover only establish the baseline
 * (no delta yet); pack credits spent count as burned too, and the delta
 * never reads negative.
 */
export function sessionCreditDelta(
  baseline: SessionBaseline | undefined,
  reading: SessionReading,
): { baseline: SessionBaseline; delta: number | undefined } {
  const credits = reading.credits;
  const fresh: SessionBaseline = {
    fetchedAt: reading.fetchedAt,
    periodStart: credits.periodStart,
    used: credits.used,
    packCredits: credits.packCredits,
  };
  if (baseline === undefined || baseline.fetchedAt === reading.fetchedAt || baseline.periodStart !== credits.periodStart) {
    return { baseline: fresh, delta: undefined };
  }
  const delta = credits.used - baseline.used + (baseline.packCredits - credits.packCredits);
  return { baseline, delta: Math.max(0, delta) };
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
  let served: { ids: string[]; at: number } | undefined;
  let creditRunOutAt: number | undefined;
  let rememberedPeriod: RememberedPeriod | undefined;
  let sessionBaseline: SessionBaseline | undefined;
  let sessionCredits: number | undefined;
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

  /** Provider whose credential reads the data (see `pickNanProvider`). */
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
   * One read: the usage report for the right window, plus the served list.
   * The window is the remembered billing period; when the response reveals a
   * different one (first load, or a rollover), it is re-requested once with
   * the right window before the snapshot is built.
   */
  async function loadSnapshot(): Promise<Snapshot> {
    const provider = keyProvider();
    const key = await resolveApiKey(context?.modelRegistry, provider);
    if (!key) throw new FetchError("auth", `no API key for provider "${provider}"`);

    const now = Date.now();
    const known =
      rememberedPeriod !== undefined && now < rememberedPeriod.endMs ? rememberedPeriod.startDay : undefined;
    const requested = usageWindow(now, known);
    let report = await fetchUsage(key, requested, { now: () => now });

    const credits = report.credits;
    if (credits !== null) {
      const endMs = Date.parse(credits.periodEnd);
      if (Number.isNaN(endMs) || now >= endMs) {
        // The period ended (or its bounds are unreadable): forget it, so the
        // next read asks for the wide window and re-learns the new period.
        rememberedPeriod = undefined;
      } else {
        rememberedPeriod = { startDay: credits.periodStart.slice(0, 10), endMs };
        const right = usageWindow(now, rememberedPeriod.startDay);
        if (right.startDate !== requested.startDate || right.endDate !== requested.endDate) {
          report = await fetchUsage(key, right, { now: () => now });
        }
      }
    }

    const ids = await servedModels(key);
    return applyModelFilter(snapshotFromUsage(report, now, { served: ids }), config);
  }

  const cache = new QuotaCache({
    fetchSnapshot: loadSnapshot,
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
    if (snapshot !== undefined) {
      const credits = snapshot.credits;
      if (credits !== null && credits !== undefined) {
        const result = sessionCreditDelta(sessionBaseline, { fetchedAt: snapshot.fetchedAt, credits });
        sessionBaseline = result.baseline;
        sessionCredits = result.delta;
      }
      // A fresh snapshot older than a minute past the 402, showing fuel
      // again, clears the spent state (the balance lags spending briefly).
      if (creditRunOutAt !== undefined && snapshotClearsCreditRunOut(creditRunOutAt, snapshot)) {
        creditRunOutAt = undefined;
      }
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

  /**
   * Scan the newest assistant entry for a spent credit pool. NaN answers a
   * spent pool with `402 insufficient_balance`; a later assistant entry that
   * ended without an error clears the flag again.
   */
  function scanForCreditExhaustion(ctx: ExtensionContext): void {
    try {
      for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        const message = entry.message as { stopReason?: string; errorMessage?: string };
        if (message.stopReason === "error") {
          if (CREDIT_EXHAUSTED.test(message.errorMessage ?? "")) creditRunOutAt = Date.now();
          return; // Only the newest assistant entry matters.
        }
        creditRunOutAt = undefined; // A successful run means the pool answers.
        return;
      }
    } catch {
      // Session introspection is best-effort; never break the turn.
    }
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
      glyphStyle: process.env.PI_NAN_QUOTA_GLYPHS === "safe" ? "safe" : config.glyphs,
      failed: state.lastError !== undefined,
    };
    if (state.lastGoodAt !== undefined) options.lastGoodAt = state.lastGoodAt;
    if (creditRunOutAt !== undefined) options.creditRunOutAt = creditRunOutAt;
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
    served = undefined;
    creditRunOutAt = undefined;
    // The session line counts from this session's first reading.
    sessionBaseline = undefined;
    sessionCredits = undefined;
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
    scanForCreditExhaustion(ctx);
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
    description: "Show NaN Builders credits and per-model consumption (refresh | help)",
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
        provider: keyProvider(),
      };
      if (snapshot !== undefined) input.snapshot = snapshot;
      if (error !== undefined) input.error = error;
      if (creditRunOutAt !== undefined) input.creditRunOutAt = creditRunOutAt;
      if (sessionCredits !== undefined) input.sessionCredits = sessionCredits;
      pi.appendEntry<{ text: string }>(ENTRY_TYPE, { text: renderQuotaReport(input) });
    },
  });
}

export interface SnapshotExtras {
  served?: string[] | undefined;
}

/**
 * Build a snapshot: the credit balance and the pace (account-wide), plus
 * per-model totals over the window, restricted to what the key can call.
 */
export function snapshotFromUsage(usage: UsageReport, at: number, extras: SnapshotExtras = {}): Snapshot {
  const served = filterServedIds(Object.keys(usage.byModel), extras.served);
  const byModel: Record<string, ModelTotals> = {};
  let totalTokens = 0;
  let totalCredits = 0;
  for (const model of served) {
    const totals = usage.byModel[model];
    if (totals === undefined) continue;
    // Copy: the filter below must never mutate the caller's report.
    byModel[model] = { ...totals };
    totalTokens += totals.tokens;
    totalCredits += totals.credits;
  }
  const snapshot: Snapshot = {
    fetchedAt: at,
    window: { startDate: usage.startDate, endDate: usage.endDate },
    credits: usage.credits === null ? null : { ...usage.credits },
    byModel,
    totalTokens,
    totalCredits,
    daily: usage.daily.map((day) => ({ ...day })),
  };
  const pace = projectPace(usage, at);
  if (pace !== undefined) snapshot.pace = pace;
  if (extras.served !== undefined) snapshot.served = [...extras.served];
  if (usage.allTimeTokens !== undefined) snapshot.allTimeTokens = usage.allTimeTokens;
  return snapshot;
}

/**
 * Restrict the table to `config.models` when the user set a list. The balance,
 * the pace and the daily totals stay account-wide: the pool is shared.
 */
export function applyModelFilter(snapshot: Snapshot, config: NanQuotaConfig): Snapshot {
  if (config.models.length === 0) return snapshot;
  const allowed = new Set(config.models.map((model) => canonicalModelId(model)));
  const byModel = Object.fromEntries(
    Object.entries(snapshot.byModel).filter(([model]) => allowed.has(canonicalModelId(model))),
  );
  return {
    ...snapshot,
    byModel,
    totalTokens: Object.values(byModel).reduce((total, row) => total + row.tokens, 0),
    totalCredits: Object.values(byModel).reduce((total, row) => total + row.credits, 0),
  };
}
