// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic test suite. No network access.
 *
 *   npm test
 *
 * Every parser case runs against a fixture captured verbatim from the real
 * API (test/fixtures/usage-credits.json), so CI exercises payloads NaN
 * actually serves without depending on it being reachable. Variants are
 * derived in-test by cloning and editing the fixture. Renderer cases call the
 * pure functions directly, with three colour modes.
 */

import { readFileSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";

import { assertOk, parseRetryAfter, requestHeaders, USER_AGENT, VERSION } from "../src/api/http.ts";
import { parseModelsPayload } from "../src/api/models.ts";
import {
  CREDITS_BILLED_SINCE,
  fetchUsage,
  parseUsagePayload,
  usageUrl,
  usageWindow,
  utcDate,
} from "../src/api/usage.ts";
import { resolveApiKey } from "../src/auth.ts";
import { backoffFor, Debouncer, MAX_BACKOFF_MS, QuotaCache } from "../src/cache.ts";
import { HELP_TEXT, renderQuotaReport, sparkline } from "../src/command.ts";
import { DEFAULT_CONFIG, loadConfig, parseConfig } from "../src/config.ts";
import {
  formatAge,
  formatCredits,
  formatReset,
  formatResetLong,
  formatTokens,
  formatUntil,
  shortMonthDate,
} from "../src/format.ts";
import { applyModelFilter, MIN_PI_VERSION, sessionCreditDelta, snapshotFromUsage } from "../src/index.ts";
import {
  canonicalModelId,
  filterServedIds,
  isNanBaseUrl,
  isNanModel,
  isNotServed,
  pickNanProvider,
  sameModel,
} from "../src/models.ts";
import { projectPace } from "../src/pace.ts";
import { BAR_WIDTH, glyphsFor, pillsFor, renderBar } from "../src/render/bar.ts";
import { detectColorMode, paintBars, paintBrand } from "../src/render/color.ts";
import { MAX_SEGMENT_WIDTH, renderStatus, snapshotClearsCreditRunOut } from "../src/render/status.ts";
import { FetchError } from "../src/types.ts";

import { check, near, note, report, section } from "./harness.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const usagePayload = fixture("usage-credits");
/** What a member (non-premium) key could call when the fixtures were captured. */
const servedIds = parseModelsPayload(fixture("models"));

/** Fixture clock: shortly after the fixture's `all_time.cached_at`. */
const NOW = Date.parse("2026-11-16T14:00:00Z");
const DAY = 24 * 60 * 60_000;

const usageReport = parseUsagePayload(usagePayload);
/** The primary snapshot: balance, pace and per-model rows, served-filtered. */
const snapshot = snapshotFromUsage(usageReport, NOW, { served: servedIds });

/** Clone the fixture and edit it in place. */
const variant = (edit) => {
  const copy = structuredClone(usagePayload);
  edit(copy);
  return copy;
};

/** Theme stub that tags themed runs, so colour placement is checkable. */
const taggingTheme = {
  fg: (color, text) => (color === "warning" ? `\u00ab${text}\u00bb` : color === "error" ? `\u2039${text}\u203a` : text),
};

/** Theme stub that emits real ANSI, so width maths is exercised for real. */
const ansiTheme = {
  fg: (color, text) => `\x1b[${color === "dim" ? "2" : color === "error" ? "31" : "33"}m${text}\x1b[0m`,
};

/** Identity theme: what a `NO_COLOR` terminal ends up with. */
const plainTheme = { fg: (_color, text) => text };

const throwsKind = (fn, kind) => {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof FetchError && error.kind === kind;
  }
};

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

const response = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
});

// ---------------------------------------------------------------------------
section("http: shared plumbing");

let seenHeaders;
{
  const doFetch = async (_url, init) => {
    seenHeaders = init.headers;
    return response(200, usagePayload);
  };
  await fetchUsage("sk-test", { startDate: "2026-11-10", endDate: "2026-11-16" }, { fetchImpl: doFetch, now: () => NOW });
}
check("Authorization uses the bearer scheme", seenHeaders.Authorization === "Bearer sk-test");
check("Accept-Encoding disables gzip (pi's undici proxy bug)", seenHeaders["Accept-Encoding"] === "identity");
check("User-Agent identifies the extension", /^pi-nan-quota\/\d+\.\d+\.\d+$/.test(seenHeaders["User-Agent"]), seenHeaders["User-Agent"]);
check("request headers never carry anything else", Object.keys(seenHeaders).length === 4, Object.keys(seenHeaders).join());

check("Retry-After in seconds", parseRetryAfter("120") === 120_000);
check("Retry-After as an HTTP date", parseRetryAfter(new Date(NOW + 30_000).toUTCString(), NOW) === 30_000);
check("unparseable Retry-After is ignored", parseRetryAfter("soon") === undefined);
check("absent Retry-After is ignored", parseRetryAfter(null) === undefined);
check("2xx passes assertOk", assertOk(response(204), "usage") === undefined);

// ---------------------------------------------------------------------------
section("usage: strict-where-it-matters parsing");

check("fixture totals", usageReport.totalTokens === 1_722_623_464 && usageReport.requests === 19_122);
check("fixture window", usageReport.startDate === "2026-11-10" && usageReport.endDate === "2026-11-16");
check("total credits over the window", usageReport.totalCredits === 3254.5);
check(
  "by_model is keyed by canonical id with full model totals",
  usageReport.byModel["deepseek-v4-flash"]?.credits === 1156.8 &&
    usageReport.byModel["deepseek-v4-flash"]?.tokens === 873_701_680 &&
    usageReport.byModel["deepseek-v4-flash"]?.promptTokens === 859_135_355 &&
    usageReport.byModel["deepseek-v4-flash"]?.cachedTokens === 511_825_941 &&
    usageReport.byModel["deepseek-v4-flash"]?.completionTokens === 14_566_325 &&
    usageReport.byModel["deepseek-v4-flash"]?.requests === 13_693,
);
check("the premium glm keeps its own row", usageReport.byModel["glm5.3"]?.credits === 560);
check(
  "daily is one summed row per UTC day, sorted",
  usageReport.daily.length === 7 &&
    usageReport.daily[0].date === "2026-11-10" &&
    usageReport.daily.at(-1).date === "2026-11-16",
);
check(
  "daily sums credits across models",
  near(usageReport.daily[0].credits, 716.3, 1e-6) &&
    near(usageReport.daily[1].credits, 413.5, 1e-6) &&
    near(usageReport.daily.at(-1).credits, 566.3, 1e-6),
);
check(
  "the credit balance parses",
  usageReport.credits?.periodStart === "2026-11-02T16:50:43Z" &&
    usageReport.credits?.periodEnd === "2026-12-02T16:50:43Z" &&
    usageReport.credits?.allowance === 7000 &&
    usageReport.credits?.used === 3254.5 &&
    usageReport.credits?.remaining === 3745.5 &&
    usageReport.credits?.packCredits === 0 &&
    usageReport.credits?.frozen === false &&
    usageReport.credits?.packExpiresAt === undefined,
);
check("all_time is carried", usageReport.allTimeTokens === 4_948_464_477 && usageReport.cachedAt === "2026-11-16T13:53:57Z");

check("credits null (not billed in credits) stays null", parseUsagePayload(variant((p) => (p.credits = null))).credits === null);
check("absent credits parse as null", parseUsagePayload(variant((p) => delete p.credits)).credits === null);
check("a missing allowance makes the balance null", parseUsagePayload(variant((p) => delete p.credits.allowance)).credits === null);
check("a string used makes the balance null", parseUsagePayload(variant((p) => (p.credits.used = "3000"))).credits === null);
check("an unparsable period_start makes the balance null", parseUsagePayload(variant((p) => (p.credits.period_start = "not a date"))).credits === null);
check("a non-object credits field parses as null", parseUsagePayload(variant((p) => (p.credits = "7000"))).credits === null);
check(
  "missing pack_credits defaults to 0 and frozen to false",
  (() => {
    const parsed = parseUsagePayload(variant((p) => (p.credits = {
      period_start: "2026-11-02T16:50:43Z",
      period_end: "2026-12-02T16:50:43Z",
      allowance: 7000,
      used: 3254.5,
      remaining: 3745.5,
    }))).credits;
    return parsed?.packCredits === 0 && parsed?.frozen === false;
  })(),
);
check("a pack expiry is carried", parseUsagePayload(variant((p) => (p.credits.pack_expires_at = "2027-01-01T00:00:00Z"))).credits?.packExpiresAt === "2027-01-01T00:00:00Z");
check("frozen true is carried", parseUsagePayload(variant((p) => (p.credits.frozen = true))).credits?.frozen === true);

check("missing totals is a schema failure", throwsKind(() => parseUsagePayload({}), "schema"));
check("missing total_tokens is a schema failure", throwsKind(() => parseUsagePayload({ totals: {} }), "schema"));
check(
  "by_model, data, all_time and credits are all optional",
  parseUsagePayload({ totals: { total_tokens: 5, api_requests: 1 } }).totalTokens === 5,
);
check(
  "data rows without a date or credits are skipped",
  parseUsagePayload(variant((p) => (p.data = [{ model: "qwen3.6", total_tokens: 5 }, { date: "2026-11-10", credits: "x" }])))
    .daily.length === 0,
);
check(
  "a by_model row without a model string is skipped",
  parseUsagePayload(variant((p) => (p.totals.by_model = [{ model: null, total_tokens: 5 }]))).byModel,
  "skipped",
);
check(
  "all-zero by_model rows are never stored",
  parseUsagePayload(variant((p) => (p.totals.by_model = [{ model: "qwen3.6", total_tokens: 0, credits: 0 }]))).byModel["qwen3.6"] === undefined,
);

// ---------------------------------------------------------------------------
section("usage: window selection");

check("credits are billed from 2026-11-10", CREDITS_BILLED_SINCE === "2026-11-10");
check("utcDate is UTC", utcDate(NOW) === "2026-11-16");
check("end is always today", usageWindow(NOW).endDate === "2026-11-16");
check("without a known period the window starts 30 days back, clamped to the first billed day", usageWindow(NOW).startDate === "2026-11-10");
check("a mature unknown window spans exactly 30 inclusive days", usageWindow(Date.parse("2027-02-15T12:00:00Z")).startDate === "2027-01-17");
check("the unknown window ends today and starts 29 days earlier", usageWindow(Date.parse("2026-12-20T00:00:00Z")).startDate === "2026-11-21");
check("a known period start wins over the 30-day window", usageWindow(Date.parse("2026-12-20T00:00:00Z"), "2026-12-05T09:00:00Z").startDate === "2026-12-05");
check("a known period start is clamped to the first billed day", usageWindow(Date.parse("2026-11-12T00:00:00Z"), "2026-11-02T16:50:43Z").startDate === "2026-11-10");
check("the window never starts after it ends", usageWindow(Date.parse("2026-11-09T12:00:00Z")).startDate === "2026-11-09");
check("usage URLs carry the window and limit=500", usageUrl("2026-11-10", "2026-11-16") === "https://api.nan.builders/v1/usage?start_date=2026-11-10&end_date=2026-11-16&limit=500");
check("a cursor rides along", usageUrl("2026-11-10", "2026-11-16", "p2").endsWith("cursor=p2"));

// ---------------------------------------------------------------------------
section("usage: fetch, pagination and error mapping");

const withFetch = (impl, fn) => fn({ fetchImpl: impl, now: () => NOW });

await withFetch(async (url) => {
  check("fetchUsage hits the documented endpoint with the window", String(url).startsWith("https://api.nan.builders/v1/usage?start_date=2026-11-10&end_date=2026-11-16"));
  return response(200, usagePayload);
}, async (deps) => {
  const report = await fetchUsage("sk-test", { startDate: "2026-11-10", endDate: "2026-11-16" }, deps);
  check("fetchUsage parses the fixture", report.totalTokens === 1_722_623_464);
});

{
  // Two pages: page 1 carries totals + the first days, page 2 the rest.
  const rows = usagePayload.data;
  const cut = rows.findIndex((row) => row.date === "2026-11-13");
  const page1 = variant((p) => {
    p.data = rows.slice(0, cut);
    p.has_more = true;
    p.next_cursor = "p2";
  });
  const page2 = variant((p) => {
    p.data = rows.slice(cut);
    p.has_more = false;
    p.next_cursor = null;
  });
  const calls = [];
  await withFetch(async (url) => {
    calls.push(String(url));
    return response(200, String(url).includes("cursor=p2") ? page2 : page1);
  }, async (deps) => {
    const report = await fetchUsage("sk-test", { startDate: "2026-11-10", endDate: "2026-11-16" }, deps);
    check("pagination follows next_cursor for the daily rows", report.daily.length === 7, JSON.stringify(report.daily));
    check("daily rows are summed across pages", near(report.daily[0].credits, 716.3, 1e-6) && near(report.daily.at(-1).credits, 566.3, 1e-6));
    check("totals come from page 1", report.totalTokens === 1_722_623_464 && report.totalCredits === 3254.5);
    check("the balance comes from page 1", report.credits?.remaining === 3745.5);
    check("two requests were made", calls.length === 2, calls.join());
    check("the second request carries the cursor", calls[1].includes("cursor=p2"));
  });
}

{
  // A cursor loop: the API hands back the same cursor forever.
  const looping = variant((p) => {
    p.has_more = true;
    p.next_cursor = "same";
  });
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return response(200, looping);
  }, async (deps) => {
    const report = await fetchUsage("sk-test", { startDate: "2026-11-10", endDate: "2026-11-16" }, deps);
    check("a repeating cursor stops the pagination", calls === 2, String(calls));
    check("the loop guard still returns page 1", report.totalTokens === 1_722_623_464);
  });
}

{
  // More pages than the cap: stop after four.
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return response(200, variant((p) => {
      p.has_more = true;
      p.next_cursor = `p${calls}`;
    }));
  }, async (deps) => {
    const report = await fetchUsage("sk-test", { startDate: "2026-11-10", endDate: "2026-11-16" }, deps);
    check("at most four pages are followed", calls === 4, String(calls));
    check("the capped read still returns page 1", report.totalTokens === 1_722_623_464);
  });
}

await withFetch(async () => response(401, { error: "nope" }), async (deps) => {
  let error;
  try {
    await fetchUsage("sk-secret-do-not-print", { startDate: "2026-11-10", endDate: "2026-11-16" }, deps);
  } catch (caught) {
    error = caught;
  }
  check("401 maps to auth", error instanceof FetchError && error.kind === "auth");
  check("401 says the key was rejected and keeps the status", /rejected/.test(error?.message ?? "") && error?.status === 401);
  check("the key never appears in the error", !String(error?.message).includes("sk-secret-do-not-print"));
});

await withFetch(async () => response(429, {}, { "retry-after": "90" }), async (deps) => {
  let error;
  try {
    await fetchUsage("sk-x", { startDate: "2026-11-10", endDate: "2026-11-16" }, deps);
  } catch (caught) {
    error = caught;
  }
  check("429 maps to rate-limit", error?.kind === "rate-limit");
  check("Retry-After is preserved", error?.retryAfterMs === 90_000, String(error?.retryAfterMs));
});

await withFetch(async () => response(503, {}), async (deps) => {
  let kind;
  try {
    await fetchUsage("sk-x", { startDate: "2026-11-10", endDate: "2026-11-16" }, deps);
  } catch (caught) {
    kind = caught.kind;
  }
  check("5xx maps to server", kind === "server");
});

await withFetch(
  async () => {
    throw new Error("socket hang up");
  },
  async (deps) => {
    let kind;
    try {
      await fetchUsage("sk-x", { startDate: "2026-11-10", endDate: "2026-11-16" }, deps);
    } catch (caught) {
      kind = caught.kind;
    }
    check("network failure is classified", kind === "network");
  },
);

await withFetch(async () => response(200, undefined), async (deps) => {
  // json() returns undefined -> not valid JSON content -> schema failure.
  let kind;
  try {
    await fetchUsage("sk-x", { startDate: "2026-11-10", endDate: "2026-11-16" }, deps);
  } catch (caught) {
    kind = caught.kind;
  }
  check("a payload that is not an object is a schema failure", kind === "schema");
});

// ---------------------------------------------------------------------------
section("pace: projection");

const balance = (over = {}) => ({
  periodStart: "2026-11-02T16:50:43Z",
  periodEnd: "2026-12-02T16:50:43Z",
  allowance: 7000,
  used: 3254.5,
  remaining: 3745.5,
  packCredits: 0,
  frozen: false,
  ...over,
});
const pacedReport = (over = {}) => ({
  startDate: "2026-11-10",
  endDate: "2026-11-16",
  totalTokens: 1,
  totalCredits: 1,
  requests: 1,
  byModel: {},
  daily: usageReport.daily,
  credits: balance(),
  ...over,
});

check("no balance means no projection", projectPace(pacedReport({ credits: null }), NOW) === undefined);

{
  // The 7-day branch: the lookback starts before the period's first day, so
  // the daily rows (not `used`) feed the rate.
  const pace = projectPace(pacedReport(), NOW);
  check("the rate sums the daily rows of the last 7 days", near(pace?.creditsPerDay ?? 0, 3254.4 / (158 / 24), 1e-6), String(pace?.creditsPerDay));
  check("the basis is fractional elapsed days", near(pace?.basisDays ?? 0, 158 / 24, 1e-9));
  check("the runway lands before the reset", pace?.runsOutBeforeReset === true);
  check("runs out in about 7.6 days", near((pace?.runsOutAt ?? 0) - NOW, (3745.5 / (3254.4 / (158 / 24))) * DAY, 1e-3));
}

{
  // The period-start branch: the lookback reaches the period's first (partial)
  // day, so `used` is authoritative.
  const report = pacedReport({
    credits: balance({ periodStart: "2026-11-12T10:00:00Z", periodEnd: "2026-12-12T10:00:00Z", used: 300 }),
  });
  const now = Date.parse("2026-11-15T10:00:00Z");
  const pace = projectPace(report, now);
  check("the period-start branch uses credits.used", near(pace?.creditsPerDay ?? 0, 100, 1e-9), String(pace?.creditsPerDay));
  check("elapsed runs from the period start (partial first day)", near(pace?.basisDays ?? 0, 3, 1e-9));
  check("runs out 10 days later at 100/day", near((pace?.runsOutAt ?? 0) - now, 3745.5 / 100 * DAY, 1e-3));
}

{
  // Regression: in a mature period the lookback is seven calendar days with
  // today included, so the summed rows and the elapsed time cover the same
  // span. Summing eight days over seven of elapsed time inflated the rate by
  // up to 14 % right after midnight.
  const days = [];
  for (let d = 1; d <= 20; d++) days.push({ date: `2026-12-${String(d).padStart(2, "0")}`, credits: 100 });
  const report = pacedReport({
    daily: days,
    credits: balance({ periodStart: "2026-12-01T00:00:00Z", periodEnd: "2027-01-01T00:00:00Z", used: 2000, remaining: 5000 }),
  });
  const justAfterMidnight = Date.parse("2026-12-20T00:05:00Z");
  const pace = projectPace(report, justAfterMidnight);
  // Dec 14..20 = 7 rows (700 cr) over 6 days + 5 minutes.
  const elapsedDays = 6 + 5 / 1440;
  check("the mature lookback covers seven calendar days", near(pace?.basisDays ?? 0, elapsedDays, 1e-9), String(pace?.basisDays));
  check("the mature rate sums exactly those seven rows", near(pace?.creditsPerDay ?? 0, 700 / elapsedDays, 1e-9), String(pace?.creditsPerDay));
}

{
  // Too early: less than 12 hours of elapsed time.
  const report = pacedReport({ credits: balance({ periodStart: "2026-11-12T10:00:00Z", used: 10 }) });
  check("under 12 hours there is no projection", projectPace(report, Date.parse("2026-11-12T16:00:00Z")) === undefined);
  const early = pacedReport({ credits: balance({ used: 0, remaining: 3745.5 }) });
  check("under 12 hours in the 7-day branch either", projectPace(early, Date.parse("2026-11-10T06:00:00Z")) === undefined);
}

{
  // Zero rate: the pool is not draining.
  const rows = usageReport.daily.map((day) => ({ ...day, credits: 0 }));
  const pace = projectPace(pacedReport({ daily: rows, credits: balance({ used: 0 }) }), NOW);
  check("a zero rate is a valid pace", pace !== undefined && pace.creditsPerDay === 0);
  check("a zero rate never runs out", pace?.runsOutAt === undefined && pace.runsOutBeforeReset === false);
}

{
  // Packs extend the runway: same rate, twice the spendable balance.
  const withoutPacks = projectPace(pacedReport(), NOW);
  const withPacks = projectPace(pacedReport({ credits: balance({ packCredits: 3745.5 }) }), NOW);
  check(
    "packs extend the runway",
    near((withPacks?.runsOutAt ?? 0) - NOW, 2 * ((withoutPacks?.runsOutAt ?? 0) - NOW), 1),
    `${withPacks?.runsOutAt} vs ${withoutPacks?.runsOutAt}`,
  );
}

{
  // A slow rate outlasts the reset.
  const slowRows = usageReport.daily.map((day, index) => ({ ...day, credits: index === 0 ? 10 : 0 }));
  const slow = projectPace(pacedReport({ daily: slowRows, credits: balance({ used: 10 }) }), NOW);
  check(
    "on pace: the runway outlasts the reset",
    slow?.runsOutAt !== undefined && slow.runsOutBeforeReset === false && slow.runsOutAt > Date.parse("2026-12-02T16:50:43Z"),
  );
}

// ---------------------------------------------------------------------------
section("snapshot: balance, pace and served filtering");

check("the window comes from the usage report", snapshot.window.startDate === "2026-11-10" && snapshot.window.endDate === "2026-11-16");
check("the balance is carried (and copied)", snapshot.credits?.remaining === 3745.5 && snapshot.credits !== usageReport.credits);
check("rows are per served model", Object.keys(snapshot.byModel).length === 6, Object.keys(snapshot.byModel).join());
check("the premium glm is filtered for a member key", snapshot.byModel["glm5.3"] === undefined);
check("deepseek-v4-pro is filtered for a member key", snapshot.byModel["deepseek-v4-pro"] === undefined);
check("the served total sums the shown models", snapshot.totalTokens === 1_646_757_935, String(snapshot.totalTokens));
check("the served credits sum the shown models", near(snapshot.totalCredits, 2192.3, 1e-6), String(snapshot.totalCredits));
check("daily travels with the snapshot (account-wide)", snapshot.daily.length === 7 && snapshot.daily !== usageReport.daily);
check("the served list travels with the snapshot", snapshot.served?.length === 13);
check("the pace is projected onto the snapshot", snapshot.pace?.runsOutBeforeReset === true && near(snapshot.pace.creditsPerDay, 3254.4 / (158 / 24), 1e-6));
check("all-time tokens travel", snapshot.allTimeTokens === 4_948_464_477);
check(
  "a premium key keeps the premium rows",
  snapshotFromUsage(usageReport, NOW, { served: [...servedIds, "glm5.3", "deepseek-v4-pro"] }).byModel["glm5.3"]?.credits === 560,
);
check("filterServedIds fails open with no list", filterServedIds(["glm5.2"], undefined).length === 1);
check("filterServedIds fails open on an empty intersection", filterServedIds(["a", "b"], ["c"]).length === 2);
check("filterServedIds is idempotent on an empty input", filterServedIds([], ["c"]).length === 0);
check("isNotServed needs a known list", isNotServed("glm5.3", undefined) === false && isNotServed("glm5.3", servedIds) === true);

{
  // Copy-don't-mutate: editing the snapshot never touches the report.
  const report = parseUsagePayload(structuredClone(usagePayload));
  const snap = snapshotFromUsage(report, NOW, { served: servedIds });
  snap.credits.remaining = 0;
  snap.byModel["deepseek-v4-flash"].credits = 0;
  snap.daily[0].credits = 0;
  check("the snapshot copies the balance", report.credits?.remaining === 3745.5);
  check("the snapshot copies the model rows", report.byModel["deepseek-v4-flash"].credits === 1156.8);
  check("the snapshot copies the daily rows", near(report.daily[0].credits, 716.3, 1e-6));
}

{
  // config.models filters the table only; the balance stays account-wide.
  const filtered = applyModelFilter(snapshot, { ...DEFAULT_CONFIG, models: ["glm5.3-flash"] });
  check("the table is restricted to config.models", Object.keys(filtered.byModel).length === 1 && filtered.byModel["glm5.3-flash"] !== undefined);
  check("the shown totals are recomputed", filtered.totalTokens === 730_921_280 && near(filtered.totalCredits, 963.1, 1e-6));
  check("the balance is account-wide", filtered.credits?.remaining === 3745.5 && filtered.daily.length === 7);
  check("the pace is account-wide", filtered.pace?.runsOutBeforeReset === true);
  check("an empty config.models keeps everything", applyModelFilter(snapshot, { ...DEFAULT_CONFIG, models: [] }).byModel["glm5.3-flash"] !== undefined);
}

// ---------------------------------------------------------------------------
section("session line: credits since the session started");

{
  const first = sessionCreditDelta(undefined, { fetchedAt: NOW, credits: balance() });
  check("the first reading only sets the baseline", first.delta === undefined && first.baseline.used === 3254.5);
  const cached = sessionCreditDelta(first.baseline, { fetchedAt: NOW, credits: balance({ used: 9000 }) });
  check("a repeated (cached) reading is not a second reading", cached.delta === undefined);
  const second = sessionCreditDelta(first.baseline, { fetchedAt: NOW + 60_000, credits: balance({ used: 3296.5 }) });
  check("the delta is credits burned since the session started", second.delta === 42);
  const third = sessionCreditDelta({ fetchedAt: NOW, periodStart: "2026-11-02T16:50:43Z", used: 3296.5, packCredits: 10 }, { fetchedAt: NOW + 60_000, credits: balance({ used: 3306.5, packCredits: 0 }) });
  check("pack credits spent count as burned", third.delta === 20, String(third.delta));
  const fourth = sessionCreditDelta({ fetchedAt: NOW, periodStart: "2026-11-02T16:50:43Z", used: 3296.5, packCredits: 0 }, { fetchedAt: NOW + 60_000, credits: balance({ used: 3000 }) });
  check("the delta never reads negative", fourth.delta === 0);
  const rolled = sessionCreditDelta({ fetchedAt: NOW, periodStart: "2026-11-02T16:50:43Z", used: 3296.5, packCredits: 0 }, { fetchedAt: NOW + 60_000, credits: balance({ periodStart: "2026-12-02T16:50:43Z", used: 10 }) });
  check("a period rollover resets the baseline", rolled.delta === undefined && rolled.baseline.used === 10);
}

// ---------------------------------------------------------------------------
section("format: sizes, credits, durations");

check("1.2B", formatTokens(1_200_000_000) === "1.2B");
check("3.0B", formatTokens(3_000_000_000) === "3.0B");
check("500M drops the .0", formatTokens(500_000_000) === "500M");
check("607.0M", formatTokens(606_966_720) === "607.0M");
check("35.2k", formatTokens(35_203) === "35.2k");
check("562 bytes", formatTokens(562) === "562");
check("0", formatTokens(0) === "0");
check("negative clamps to 0", formatTokens(-5) === "0");
check("requests read as 13.7k", formatTokens(13_693) === "13.7k");

check("credits keep one decimal", formatCredits(3745.5) === "3745.5" && formatCredits(963.1) === "963.1");
check("whole credits drop the .0", formatCredits(7000) === "7000" && formatCredits(560) === "560" && formatCredits(0) === "0");

check("short month dates", shortMonthDate("2026-11-02") === "Nov 2" && shortMonthDate("2026-11-16T13:53:57Z") === "Nov 16");
check("an unparsable date is returned as-is", shortMonthDate("whenever") === "whenever");

check("days and hours", formatReset(4 * DAY + 3 * 3_600_000) === "4d3h");
check("hours and minutes", formatReset(3 * 3_600_000 + 20 * 60_000) === "3h20m");
check("minutes", formatReset(12 * 60_000) === "12m");
check("a past reset reads 0m", formatReset(-1) === "0m");
check("long variant is spaced", formatResetLong(24 * DAY + 3 * 3_600_000 + 10 * 60_000) === "24d 3h", formatResetLong(24 * DAY + 3 * 3_600_000 + 10 * 60_000));

check("coarse until: days", formatUntil(7.5 * DAY) === "8d" && formatUntil(DAY) === "1d");
check("coarse until: hours", formatUntil(20 * 3_600_000) === "20h" && formatUntil(3_600_000) === "1h");
check("coarse until: minutes", formatUntil(45 * 60_000) === "45m");
check("a past run-out reads 0m", formatUntil(-1) === "0m");
check("age in minutes", formatAge(5 * 60_000) === "5m");
check("age in hours", formatAge(125 * 60_000) === "2h");

// ---------------------------------------------------------------------------
section("bar: ten pills, a uniform scale");

const F = "\u25b0";
const E = "\u25b1";
const bar = (used) => F.repeat(used) + E.repeat(BAR_WIDTH - used);

check("the bar has ten pills", BAR_WIDTH === 10);

// The whole scale, every printed percentage: 0 only at 0 %, full only at
// 100 %, and the nine states in between take exactly eleven points each.
{
  const bands = new Map();
  let previous = 0;
  let steps = true;
  let widths = true;
  let shapes = true;
  for (let percent = 0; percent <= 100; percent++) {
    const rendered = renderBar(percent);
    const used = pillsFor(percent);
    if (rendered !== bar(used)) shapes = false;
    if (visibleWidth(rendered) !== BAR_WIDTH) widths = false;
    if (used - previous !== 0 && used - previous !== 1) steps = false;
    previous = used;
    bands.set(used, [...(bands.get(used) ?? []), percent]);
  }
  check("every percentage renders used pills then hollow ones, no gap", shapes);
  check("every bar is exactly ten columns", widths);
  check("the bar climbs one pill at a time and never skips one", steps);
  check("all eleven states are reached", bands.size === 11);
  check("empty only at 0 %", bands.get(0)?.join() === "0");
  check("full only at 100 %", bands.get(10)?.join() === "100");
  const uniform = [1, 2, 3, 4, 5, 6, 7, 8, 9].every((used) => bands.get(used)?.length === 11);
  check("each intermediate pill covers exactly eleven points", uniform, JSON.stringify([...bands].map(([k, v]) => [k, v[0], v.at(-1)])));
  const expected = [[1, 1, 11], [2, 12, 22], [3, 23, 33], [4, 34, 44], [5, 45, 55], [6, 56, 66], [7, 67, 77], [8, 78, 88], [9, 89, 99]];
  check(
    "the documented bands are the real ones",
    expected.every(([used, from, to]) => bands.get(used)?.[0] === from && bands.get(used)?.at(-1) === to),
  );
}

check("1% already lights the first pill", renderBar(1) === bar(1));
check("50% is exactly half", renderBar(50) === bar(5));
check("54% is still half", renderBar(54) === bar(5));
check("56% is the sixth pill", renderBar(56) === bar(6));
check("99% keeps one pill hollow", renderBar(99) === bar(9));
check(">100% clamps to full", renderBar(150) === bar(10));
check("negative clamps to empty", renderBar(-5) === bar(0));
check("NaN is empty rather than broken", renderBar(Number.NaN) === bar(0));
check("a fractional percentage is rounded first", renderBar(55.4) === bar(5) && renderBar(55.6) === bar(6));
check("glyphs are configurable", renderBar(0, { glyphs: { fill: "\u25aa", empty: "\u25ab" } }) === "\u25ab".repeat(BAR_WIDTH));
check("the width is configurable and stays uniform", renderBar(50, { width: 4 }) === F.repeat(2) + E.repeat(2) && renderBar(100, { width: 4 }) === F.repeat(4));

for (const mode of ["truecolor", "ansi256", "none"]) {
  const painted = renderBar(50, {
    glyphs: glyphsFor("pill"),
    fill: (text) => paintBrand(text, mode),
    empty: (text) => paintBrand(text, mode),
  });
  check(`${mode}: painted bar keeps the plain geometry`, stripAnsi(painted) === renderBar(50));
  check(`${mode}: both halves use the same colour`, new Set((painted.match(/\u001b\[[0-9;]*m/g) ?? []).filter((c) => c !== "\u001b[39m")).size <= 1, JSON.stringify(painted));
  check(`${mode}: still ${BAR_WIDTH} columns`, visibleWidth(painted) === BAR_WIDTH, `got ${visibleWidth(painted)}`);
}
check("pill family is solid against hollow", glyphsFor("pill").fill === F && glyphsFor("pill").empty === E);
check("safe family uses squares", glyphsFor("safe").fill === "\u25aa" && glyphsFor("safe").empty === "\u25ab");

// ---------------------------------------------------------------------------
section("status: footer segment");

const status = (over = {}) =>
  stripAnsi(renderStatus(snapshot, { now: NOW, activeModelId: "deepseek-v4-flash", theme: plainTheme, mode: "none", ...over }) ?? "");

// 3745.5 of 7000 = 54 % -> five pills; ~8 days of runway; reset in 16d2h.
const full = status();
check(
  "the full shape: fuel gauge, whole credits, run-out warning, reset",
  full === `nan ${bar(5)} 3745 cr \u00b7 \u26a0 empty in ~8d \u00b7 resets 16d2h`,
  JSON.stringify(full),
);
check("the segment fits the cap", visibleWidth(full) <= MAX_SEGMENT_WIDTH, full);
check("the bar is the remaining fuel, not the used share", stripAnsi(renderStatus({ ...snapshot, credits: { ...snapshot.credits, remaining: 6300, used: 700 } }, { now: NOW, activeModelId: "deepseek-v4-flash", theme: plainTheme, mode: "none" }) ?? "") === `nan ${bar(9)} 6300 cr \u00b7 \u26a0 empty in ~8d \u00b7 resets 16d2h`);
check("numbers are whole credits, floored", status().includes("3745 cr"));

check("a full pool is a full bar", stripAnsi(renderStatus({ ...snapshot, credits: { ...snapshot.credits, remaining: 7000, used: 0 } }, { now: NOW, activeModelId: "deepseek-v4-flash", theme: plainTheme, mode: "none" }) ?? "") === `nan ${bar(10)} 7000 cr \u00b7 \u26a0 empty in ~8d \u00b7 resets 16d2h`);
check("the run-out warning disappears when on pace", stripAnsi(renderStatus({ ...snapshot, pace: { ...snapshot.pace, runsOutBeforeReset: false } }, { now: NOW, activeModelId: "deepseek-v4-flash", theme: plainTheme, mode: "none" }) ?? "") === `nan ${bar(5)} 3745 cr \u00b7 resets 16d2h`);
check("no projection shows the reset only", stripAnsi(renderStatus({ ...snapshot, pace: undefined }, { now: NOW, activeModelId: "deepseek-v4-flash", theme: plainTheme, mode: "none" }) ?? "") === `nan ${bar(5)} 3745 cr \u00b7 resets 16d2h`);

{
  // Packs: shown as extra fuel, and they lift the low-fuel warning colour.
  const packed = { ...snapshot, credits: { ...snapshot.credits, remaining: 500, used: 6500, packCredits: 1000, packExpiresAt: "2027-01-01T00:00:00Z" } };
  const text = stripAnsi(renderStatus(packed, { now: NOW, activeModelId: "deepseek-v4-flash", theme: plainTheme, mode: "none" }) ?? "");
  check("packs are appended to the number", text.includes("500+1000 cr"), text);
  const tagged = renderStatus(packed, { now: NOW, activeModelId: "deepseek-v4-flash", theme: taggingTheme, mode: "none", width: 200 }) ?? "";
  check("a packed pool does not warn on the number", !tagged.includes("\u00ab500"));
  const low = renderStatus({ ...snapshot, credits: { ...snapshot.credits, remaining: 700, used: 6300 } }, { now: NOW, activeModelId: "deepseek-v4-flash", theme: taggingTheme, mode: "none", width: 200 }) ?? "";
  check("10 % remaining warns on the number", low.includes("\u00ab700\u00bb"), low);
}

{
  // Shape fallback by width: shapes in priority order, the first that fits
  // wins. The run-out warning outranks the reset countdown.
  check("width 56 keeps everything", status({ width: 56 }) === full);
  check("width 44 keeps the run-out warning over the reset", status({ width: 44 }) === `nan ${bar(5)} 3745 cr \u00b7 \u26a0 empty in ~8d`);
  {
    const onPace = { ...snapshot, pace: { ...snapshot.pace, runsOutBeforeReset: false } };
    const text = stripAnsi(renderStatus(onPace, { now: NOW, width: 44, theme: plainTheme, mode: "none" }) ?? "");
    check("without a warning, width 44 keeps the reset", text === `nan ${bar(5)} 3745 cr \u00b7 resets 16d2h`, text);
  }
  check("width 40 keeps the warning only", status({ width: 40 }) === `nan ${bar(5)} 3745 cr \u00b7 \u26a0 empty in ~8d`);
  check("width 29 drops every suffix", status({ width: 29 }) === `nan ${bar(5)} 3745 cr`);
  check("width 14 falls back to the short form", status({ width: 14 }) === "nan 3745 cr");
  check("a tiny width truncates", visibleWidth(status({ width: 10 })) <= 10, status({ width: 10 }));
  check("width 56 is the default", visibleWidth(renderStatus(snapshot, { now: NOW, activeModelId: "deepseek-v4-flash", theme: ansiTheme }) ?? "") <= MAX_SEGMENT_WIDTH);
}

{
  // Staleness suffix: it attaches to the first shape it fits on, even if
  // that drops a suffix — a fresh-looking number from a stale read is worse.
  // The run-out warning still outranks the reset countdown.
  const stale = status({ now: NOW + 40 * 60_000, failed: true, lastGoodAt: NOW });
  check("a failed refresh adds an age suffix", stale === `nan ${bar(5)} 3745 cr \u00b7 \u26a0 empty in ~8d \u00b740m`, stale);
  const narrow = status({ now: NOW + 40 * 60_000, failed: true, lastGoodAt: NOW, width: 26 });
  check("the age suffix survives by shrinking the shape", narrow === `nan 3745 cr \u00b740m`, narrow);
  const fresh = status({ now: NOW + 60_000, failed: true, lastGoodAt: NOW });
  check("a failure younger than five minutes adds nothing", !/\u00b7\d+[mh]/.test(fresh), fresh);
}

{
  // State 1: frozen.
  const frozen = renderStatus({ ...snapshot, credits: { ...snapshot.credits, frozen: true } }, { now: NOW, theme: plainTheme, mode: "none" });
  check("frozen outranks everything", stripAnsi(frozen ?? "") === "nan \u23f8 subscription inactive \u2014 cloud.nan.builders", frozen);
  const tagged = renderStatus({ ...snapshot, credits: { ...snapshot.credits, frozen: true } }, { now: NOW, theme: taggingTheme, mode: "none", width: 200 });
  check("frozen is an error", tagged?.includes("\u2039"), tagged);
}

{
  // State 2: spent — by a seen 402, or by an empty pool.
  const spent402 = status({ creditRunOutAt: NOW - 1 });
  check("a seen 402 shows the spent state with the reset", spent402 === "nan \u26d4 credits spent \u2014 resets 16d2h", spent402);
  const spent402NoSnapshot = stripAnsi(renderStatus(undefined, { now: NOW, creditRunOutAt: NOW - 1, theme: plainTheme }) ?? "");
  check("the spent state without a snapshot drops the reset", spent402NoSnapshot === "nan \u26d4 credits spent", spent402NoSnapshot);
  const spentBalance = stripAnsi(renderStatus({ ...snapshot, credits: { ...snapshot.credits, remaining: 0.5, used: 6999.5 } }, { now: NOW, theme: plainTheme, mode: "none" }) ?? "");
  check("an empty pool shows the spent state", spentBalance === "nan \u26d4 credits spent \u2014 resets 16d2h", spentBalance);
  const packedLow = stripAnsi(renderStatus({ ...snapshot, credits: { ...snapshot.credits, remaining: 0.5, used: 6999.5, packCredits: 1000 } }, { now: NOW, theme: plainTheme, mode: "none" }) ?? "");
  check("packs keep a near-empty pool out of the spent state", packedLow.startsWith(`nan ${bar(0)} 0+1000 cr`), packedLow);
  const tagged = renderStatus(snapshot, { now: NOW, creditRunOutAt: NOW - 1, theme: taggingTheme, mode: "none", width: 200 });
  check("the spent state is an error", tagged?.includes("\u2039"), tagged);
}

{
  // State 3: no data yet.
  const none = renderStatus(undefined, { now: NOW, theme: plainTheme, mode: "none" });
  check("no snapshot shows the dim placeholder", stripAnsi(none ?? "") === "nan \u00b7\u00b7\u00b7", none);
  check("show=false clears the segment", renderStatus(snapshot, { now: NOW, show: false }) === undefined);
}

{
  // State 4: the active model is not served by this key.
  const notServed = status({ activeModelId: "glm5.3" });
  check("a premium model on a member key says so", notServed === "nan glm5.3 not available on this key", notServed);
  check("a retired model is not blamed on the plan", status({ activeModelId: "glm5.2" }) === "nan glm5.2 not available on this key");
  check("without a served list an unmatched model falls back to the balance", stripAnsi(renderStatus({ ...snapshot, served: undefined }, { now: NOW, activeModelId: "glm5.3", theme: plainTheme, mode: "none" }) ?? "") === full);
}

{
  // State 5: not billed in credits — tokens over the window, no bar.
  const nullSnapshot = snapshotFromUsage(parseUsagePayload(variant((p) => (p.credits = null))), NOW, { served: servedIds });
  const tokens = stripAnsi(renderStatus(nullSnapshot, { now: NOW, activeModelId: "deepseek-v4-flash", theme: plainTheme, mode: "none" }) ?? "");
  check("a null balance shows window tokens and the day count", tokens === "nan 1.6B tokens (7d)", tokens);
  check("no bar is drawn without credits", !tokens.includes("\u25b0") && !tokens.includes("\u25b1"));
}

{
  // Colours.
  const preciseRaw = renderStatus(snapshot, { now: NOW, activeModelId: "deepseek-v4-flash", theme: ansiTheme, mode: "truecolor" });
  check("truecolor uses the brand RGB on both halves", (preciseRaw ?? "").split("\u001b[38;2;125;57;235m").length === 3, preciseRaw);
  check("truecolor keeps the width", visibleWidth(stripAnsi(preciseRaw ?? "")) === visibleWidth(full));
  const ansi256 = renderStatus(snapshot, { now: NOW, activeModelId: "deepseek-v4-flash", theme: ansiTheme, mode: "ansi256" });
  check("256-colour mode uses index 99", (ansi256 ?? "").includes("\x1b[38;5;99m"));
  check("no ANSI when the mode is none", !full.includes("\x1b["));
  const tagged = renderStatus(snapshot, { now: NOW, activeModelId: "deepseek-v4-flash", theme: taggingTheme, mode: "none", width: 200 }) ?? "";
  check("the run-out warning is theme warning", tagged.includes("\u00ab\u26a0 empty in ~8d\u00bb"), tagged);
  const safe = stripAnsi(renderStatus(snapshot, { now: NOW, activeModelId: "deepseek-v4-flash", theme: plainTheme, mode: "none", glyphStyle: "safe" }) ?? "");
  check("the safe glyph family is honoured", safe.includes("\u25aa".repeat(5) + "\u25ab".repeat(5)), safe);
}

{
  // The 402 flag clears when a later snapshot shows fuel again.
  const fuelled = { ...snapshot, fetchedAt: NOW };
  const dry = { ...snapshot, fetchedAt: NOW, credits: { ...snapshot.credits, remaining: 0, packCredits: 0 } };
  check("a fresh snapshot with fuel clears the 402", snapshotClearsCreditRunOut(NOW - 61_000, fuelled) === true);
  check("a snapshot only 60 s after the 402 does not", snapshotClearsCreditRunOut(NOW - 60_000, fuelled) === false);
  check("a late snapshot without fuel does not", snapshotClearsCreditRunOut(NOW - 61_000, dry) === false);
  check("a null balance never clears the 402", snapshotClearsCreditRunOut(NOW - 61_000, { ...fuelled, credits: null }) === false);
}

section("colour: table painter");

{
  const violet = "\u001b[38;2;125;57;235m";
  const text = "  credits  \u25b0\u25b0\u25b1  12 left\n  last 7 days  \u2581\u2585\u2588  1 5 9 cr";
  const painted = paintBars(text, "truecolor");
  check("the pills are painted violet", painted.includes(`${violet}\u25b0\u25b0\u25b1`), JSON.stringify(painted));
  check("the sparkline is painted violet", painted.includes(`${violet}\u2581\u2585\u2588`), JSON.stringify(painted));
  check("plain text is left alone", stripAnsi(painted) === text && !painted.includes(`${violet}  `));
  check("no colour mode leaves the text untouched", paintBars(text, "none") === text);
}

section("colour detection");

check("truecolor via COLORTERM", detectColorMode({ COLORTERM: "truecolor" }) === "truecolor");
check("24bit is truecolor", detectColorMode({ COLORTERM: "24bit" }) === "truecolor");
check("default is 256 colours", detectColorMode({}) === "ansi256");
check("NO_COLOR wins", detectColorMode({ COLORTERM: "truecolor", NO_COLOR: "1" }) === "none");
check("NO_COLOR counts even when empty", detectColorMode({ NO_COLOR: "" }) === "none");
check("TERM=dumb disables colour", detectColorMode({ TERM: "dumb" }) === "none");

// ---------------------------------------------------------------------------
section("sparkline");

check("empty is empty", sparkline([]) === "");
check("all-zero reads flat-low", sparkline([0, 0, 0]) === "\u2581\u2581\u2581");
check("the max reads high", sparkline([0, 2]) === "\u2581\u2588");
check("single values read high", sparkline([5]) === "\u2588");
check("the fixture week is scaled to its max", sparkline(snapshot.daily.map((day) => day.credits)) === "\u2588\u2585\u2587\u2587\u2584\u2582\u2587", sparkline(snapshot.daily.map((day) => day.credits)));

// ---------------------------------------------------------------------------
section("cache: TTL, single-flight, backoff");

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

const bare = (extra = {}) => ({
  fetchedAt: NOW,
  window: { startDate: "2026-11-10", endDate: "2026-11-16" },
  credits: null,
  byModel: {},
  totalTokens: 0,
  totalCredits: 0,
  daily: [],
  ...extra,
});

function harness({ ttlMs, result = () => bare() } = {}) {
  const time = clock();
  const state = { fetches: 0, notices: [] };
  const cache = new QuotaCache({
    now: time.now,
    ttlMs,
    notify: (message) => state.notices.push(message),
    fetchSnapshot: async () => {
      state.fetches++;
      return result();
    },
  });
  return { cache, time, state };
}

{
  const { cache, time, state } = harness();
  const first = await cache.get();
  check("first read fetches", state.fetches === 1 && first !== undefined);
  await cache.get();
  check("second read inside the TTL is cached", state.fetches === 1);
  time.advance(119_999);
  await cache.get();
  check("still cached just before the TTL", state.fetches === 1);
  time.advance(2);
  await cache.get();
  check("expired TTL refetches", state.fetches === 2);
  await cache.get({ force: true });
  check("force bypasses the TTL", state.fetches === 3);
  time.advance(31_000);
  await cache.get({ maxAgeMs: 30_000 });
  check("maxAgeMs overrides the TTL for one call", state.fetches === 4);
}

{
  let ttl = 10_000;
  const { cache, time, state } = harness({ ttlMs: () => ttl });
  await cache.get();
  time.advance(9_000);
  await cache.get();
  check("a TTL function is honoured", state.fetches === 1);
  ttl = 5_000;
  await cache.get();
  check("a changed TTL applies on the next call (config reload)", state.fetches === 2);
}

{
  const time = clock();
  let release;
  let fetches = 0;
  const cache = new QuotaCache({
    now: time.now,
    fetchSnapshot: () => {
      fetches++;
      return new Promise((resolve) => {
        release = () => resolve(bare());
      });
    },
  });
  const first = cache.get();
  const second = cache.get();
  check("concurrent reads share one request", fetches === 1, `fetches=${fetches}`);
  release();
  const [a, b] = await Promise.all([first, second]);
  check("both callers get the same snapshot", a === b && a !== undefined);
  check("state reports no request in flight afterwards", cache.getState().inFlight === false);
}

{
  const time = clock();
  let fetches = 0;
  const notices = [];
  const cache = new QuotaCache({
    now: time.now,
    notify: (message) => notices.push(message),
    fetchSnapshot: async () => {
      fetches++;
      throw new FetchError("network", "usage: socket hang up");
    },
  });
  const result = await cache.get();
  check("a failing read keeps the previous snapshot", result === undefined);
  let state = cache.getState();
  check("first failure backs off 30s", state.retryAt === time.now() + 30_000, String(state.retryAt));
  check("the failure is remembered", state.failures === 1 && state.lastError?.kind === "network");
  await cache.get();
  check("no request while backing off", fetches === 1);
  time.advance(30_000);
  await cache.get();
  check("a second failure backs off 60s", fetches === 2 && cache.getState().retryAt === time.now() + 60_000);
  time.advance(60_000);
  await cache.get();
  check("a third failure backs off 120s", fetches === 3 && cache.getState().retryAt === time.now() + 120_000);
  check("the same failure is announced once", notices.length === 1, `${notices.length} notices`);
  check("backoff is capped at 15 minutes", backoffFor(new FetchError("network", "x"), 20) === MAX_BACKOFF_MS);
}

{
  const time = clock();
  let fetches = 0;
  let fail = true;
  const cache = new QuotaCache({
    now: time.now,
    fetchSnapshot: async () => {
      fetches++;
      if (fail) throw new FetchError("rate-limit", "usage: HTTP 429", { retryAfterMs: 120_000 });
      return bare();
    },
  });
  await cache.get();
  check("429 honours Retry-After", cache.getState().retryAt === time.now() + 120_000, String(cache.getState().retryAt));
  time.advance(120_000);
  fail = false;
  const recovered = await cache.get();
  check("recovers once Retry-After elapses", recovered !== undefined && fetches === 2);
  check("success clears the backoff", cache.getState().failures === 0 && cache.getState().retryAt === 0);
  check("lastGoodAt is recorded", cache.getState().lastGoodAt === time.now());
  check("a 429 with a huge Retry-After is capped", backoffFor(new FetchError("rate-limit", "x", { retryAfterMs: 3_600_000 }), 1) === MAX_BACKOFF_MS);
}

{
  const time = clock();
  let fail = false;
  const cache = new QuotaCache({
    now: time.now,
    ttlMs: 1,
    fetchSnapshot: async () => {
      if (fail) throw new FetchError("server", "usage: HTTP 503");
      return bare();
    },
  });
  await cache.get();
  const good = cache.getSnapshot();
  const goodAt = cache.getState().lastGoodAt;
  time.advance(2);
  fail = true;
  const afterFailure = await cache.get();
  check("a failure still serves the last good snapshot", afterFailure === good && afterFailure !== undefined);
  check("lastGoodAt survives the failure", cache.getState().lastGoodAt === goodAt);
  check("the failure is exposed for the stale suffix", cache.getState().lastError?.kind === "server");
  cache.reset();
  check("reset clears the cached snapshot", cache.getSnapshot() === undefined && cache.getState().failures === 0);
}

// ---------------------------------------------------------------------------
section("debounce: turn_end refreshes");

{
  let runs = 0;
  const debouncer = new Debouncer(5, () => runs++);
  debouncer.trigger();
  debouncer.trigger();
  check("a pending run is reported", debouncer.pending === true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  check("overlapping triggers coalesce into one run", runs === 1, String(runs));
  debouncer.trigger();
  debouncer.cancel();
  await new Promise((resolve) => setTimeout(resolve, 25));
  check("cancel drops the pending run", runs === 1);
}

// ---------------------------------------------------------------------------
section("auth: registry first, environment second");

const registry = (value, shouldThrow = false) => ({
  calls: 0,
  async getApiKeyForProvider(provider) {
    this.calls++;
    if (shouldThrow) throw new Error("no auth");
    return provider === "nan" ? value : undefined;
  },
});

{
  const reg = registry("sk-registry");
  check("registry key wins", (await resolveApiKey(reg, "nan", { NAN_API_KEY: "sk-env" })) === "sk-registry");
  check("registry is asked for the configured provider", reg.calls === 1);
  check("environment is the fallback", (await resolveApiKey(registry(undefined), "nan", { NAN_API_KEY: " sk-env " })) === "sk-env");
  check("a throwing registry falls back", (await resolveApiKey(registry(undefined, true), "nan", { NAN_API_KEY: "sk-env" })) === "sk-env");
  check("no key resolves to undefined", (await resolveApiKey(undefined, "nan", {})) === undefined);
}

// ---------------------------------------------------------------------------
section("config: optional file, field-by-field validation");

check("defaults are the documented ones", DEFAULT_CONFIG.refreshSeconds === 120 && DEFAULT_CONFIG.alwaysShow === false);
check("provider defaults to nan", DEFAULT_CONFIG.providerId === "nan");
check("the removed quota endpoint setting is gone from the defaults", !("quotaEndpoint" in DEFAULT_CONFIG));

const configured = parseConfig({ refreshSeconds: 60, alwaysShow: true, providerId: "nan-b", models: ["glm5.3"] });
check("valid fields are applied", configured.refreshSeconds === 60 && configured.alwaysShow === true && configured.providerId === "nan-b");
check("models list is kept", configured.models.length === 1 && configured.models[0] === "glm5.3");
const junk = parseConfig({ refreshSeconds: "60", warnAt: 150, alwaysShow: "yes", providerId: "  ", models: ["", 3] });
check("invalid fields fall back", junk.refreshSeconds === 120 && junk.alwaysShow === false);
check("the removed alert settings are ignored", junk.warnAt === undefined);
check("blank provider keeps the default", junk.providerId === "nan");
check("non-string models are dropped", junk.models.length === 0);
check("refreshSeconds is floored at 30 to protect the rate limit", parseConfig({ refreshSeconds: 5 }).refreshSeconds === 30);
check("a removed setting in a user file is ignored, not an error", parseConfig({ quotaEndpoint: false }).refreshSeconds === 120 && parseConfig({ quotaEndpoint: false }).models.length === 0);
check("glyphs default to the pill", DEFAULT_CONFIG.glyphs === "pill");
check("glyphs accept the safe family", parseConfig({ glyphs: "safe" }).glyphs === "safe");
check("unknown glyph families are ignored", parseConfig({ glyphs: "emoji" }).glyphs === "pill");
check("non-object config is ignored", parseConfig(null).refreshSeconds === 120);
check("loadConfig on a missing file returns defaults", loadConfig("/nonexistent/nan-quota.json").refreshSeconds === 120);
check("loadConfig on invalid JSON returns defaults", loadConfig("x", () => "{ not json").refreshSeconds === 120);
check("loadConfig reads a valid file", loadConfig("x", () => JSON.stringify({ refreshSeconds: 90 })).refreshSeconds === 90);
check("loadConfig ignores a removed setting in a real file", loadConfig("x", () => JSON.stringify({ quotaEndpoint: false, refreshSeconds: 90 })).refreshSeconds === 90);

// ---------------------------------------------------------------------------
section("models: aliases and NaN detection");

const NAN_URL = "https://api.nan.builders/v1";

check("provider prefix is stripped", canonicalModelId("nan/deepseek-v4-flash") === "deepseek-v4-flash");
check("hyphenated glm maps to the API id", canonicalModelId("glm-5.3") === "glm5.3");
check("ids are case-insensitive", canonicalModelId("GLM5.3-Flash") === "glm5.3-flash");
check("sameModel tolerates spelling", sameModel("nan/glm-5.3", "glm5.3") === true);
check("isNanBaseUrl", isNanBaseUrl("https://api.nan.builders/v1") && !isNanBaseUrl("https://api.openai.com/v1"));
check("isNanModel by provider and by base URL", isNanModel({ provider: "nan", id: "x" }, "nan") && isNanModel({ provider: "other", id: "x", baseUrl: "https://api.nan.builders/v1" }, "nan") && !isNanModel({ provider: "other", id: "x" }, "nan"));
check("pickNanProvider prefers the active model", pickNanProvider({ provider: "nan-b", baseUrl: NAN_URL }, [], "nan") === "nan-b");

// ---------------------------------------------------------------------------
section("/nan-quota: table output");

const reportText = renderQuotaReport({ snapshot, now: NOW });
const reportLines = reportText.split("\n");
note(reportLines[0]);

check(
  "header carries the billing period and the reset",
  reportLines[0] === "NaN \u00b7 billing period Nov 2 \u2192 Dec 2 \u00b7 resets in 16d 2h",
  JSON.stringify(reportLines[0]),
);
check(
  "the credits line: fuel gauge, one-decimal balance, allowance and used",
  reportLines[2] === `  credits  ${bar(5)}  3745.5 left of 7000 \u00b7 3254.5 used`,
  JSON.stringify(reportLines[2]),
);
check("the packs line says none", reportLines[3] === "  packs    none", JSON.stringify(reportLines[3]));
check(
  "the pace line projects the run-out against the reset",
  reportLines[4] === "  pace     ~494 cr/day over the last 6.6 days \u2192 runs out ~Nov 24, 8 days before the reset",
  JSON.stringify(reportLines[4]),
);
check("the session line is omitted until two readings exist", !reportText.includes("since this pi session started"), reportLines[5]);

{
  const withSession = renderQuotaReport({ snapshot, now: NOW, sessionCredits: 42 });
  check(
    "the session line shows credits burned this session",
    withSession.includes("  session  +42.0 cr since this pi session started (account-wide, every key)"),
    withSession.split("\n")[5],
  );
}

const tableStart = reportLines.findIndex((line) => line.startsWith("  model"));
check("the model table header names the columns", /^ {2}model( +credits)( +share)( +cr\/Mtok)( +cached)( +tokens)( +req)$/.test(reportLines[tableStart]), JSON.stringify(reportLines[tableStart]));
check(
  "rows sort by credits desc",
  reportLines[tableStart + 1].startsWith("  deepseek-v4-flash (DeepSeek V4 Flash)") &&
    reportLines[tableStart + 2].startsWith("  glm5.3-flash (GLM 5.3 Flash)") &&
    reportLines[tableStart + 3].startsWith("  qwen3.8-flash (Qwen 3.8 Flash)") &&
    reportLines[tableStart + 4].startsWith("  mimo-v2.6-flash (MiMo V2.6 Flash)"),
  reportLines.slice(tableStart + 1, tableStart + 5).join("\n"),
);
check(
  "a row carries credits, share, price, cache ratio, tokens and requests",
  /^ {2}deepseek-v4-flash \(DeepSeek V4 Flash\) +1156\.8 +53% +1\.32 +60% +873\.7M +13\.7k$/.test(reportLines[tableStart + 1]),
  JSON.stringify(reportLines[tableStart + 1]),
);
check("the cr/Mtok column reads \u2014 below 100k tokens", /mimo-v2\.6-flash \(MiMo V2\.6 Flash\) +0\.1 +0% +\u2014 +67% +35\.2k +15$/.test(reportLines[tableStart + 4]), JSON.stringify(reportLines[tableStart + 4]));
check("the member table lists every served model with credits", (reportText.match(/^ {2}\S+ \([^)]+\)/gm) ?? []).length === 4, String((reportText.match(/^ {2}\S+ \([^)]+\)/gm) ?? []).length));
check("models with tokens but no credits go to one line", reportText.includes("  no credits drawn: gemma4, qwen3.6"), reportText.split("\n").find((l) => l.includes("no credits drawn")));
check("the premium glm is not listed for a member key", !/^ {2}glm5\.3 \(/m.test(reportText));

check(
  "the sparkline row shows the last 7 UTC days",
  reportText.includes(`  last 7 days  \u2588\u2585\u2587\u2587\u2584\u2582\u2587  716 414 578 566 285 130 566 cr  (Nov 10 \u2192 Nov 16, UTC)`),
  reportText.split("\n").find((line) => line.includes("last 7 days")),
);
check(
  "the source line names the window and its caveat",
  reportLines.at(-1) ===
    "source: /v1/usage 2026-11-10 \u2192 2026-11-16 (whole UTC days) \u00b7 the balance is authoritative",
  JSON.stringify(reportLines.at(-1)),
);

{
  // A premium key sees the premium rows in the same order.
  const premium = renderQuotaReport({
    snapshot: snapshotFromUsage(usageReport, NOW, { served: [...servedIds, "glm5.3", "deepseek-v4-pro"] }),
    now: NOW,
  });
  check("the premium glm row appears for a premium key", /^ {2}glm5\.3 \(GLM 5\.3\) +560\.0 /m.test(premium), premium.split("\n").find((l) => l.startsWith("  glm5.3 ")));
  check("premium rows keep the credits-desc order", premium.indexOf("deepseek-v4-flash") < premium.indexOf("glm5.3-flash") && premium.indexOf("glm5.3 ") < premium.indexOf("deepseek-v4-pro"));
}

{
  // Packs and an on-pace projection.
  const packed = renderQuotaReport(
    {
      snapshot: {
        ...snapshot,
        credits: { ...snapshot.credits, packCredits: 1000, packExpiresAt: "2027-01-01T00:00:00Z" },
        pace: { ...snapshot.pace, runsOutBeforeReset: false },
      },
      now: NOW,
    },
  );
  check("the packs line shows the pack and its expiry", packed.includes("  packs    1000.0 left \u00b7 expire 2027-01-01"), packed.split("\n")[3]);
  check("an on-pace run says so", packed.includes("on pace to last until the reset"), packed.split("\n")[4]);
  const early = renderQuotaReport({ snapshot: { ...snapshot, pace: undefined }, now: NOW });
  check("too early in the period says so", early.includes("  pace     too early in the period to project"));
}

{
  // The null-credits variant: header, token table, one advice line.
  const nullSnapshot = snapshotFromUsage(parseUsagePayload(variant((p) => (p.credits = null))), NOW, { served: servedIds });
  const nullText = renderQuotaReport({ snapshot: nullSnapshot, now: NOW });
  const nullLines = nullText.split("\n");
  check("the header names the window instead of the period", nullLines[0] === "NaN \u00b7 usage, last 7 days (UTC)", JSON.stringify(nullLines[0]));
  check("the credits columns are omitted", /^ {2}model( +cached)( +tokens)( +req)$/.test(nullLines[2]), JSON.stringify(nullLines[2]));
  check("rows keep the model totals", /^ {2}deepseek-v4-flash \(DeepSeek V4 Flash\) +60% +873\.7M +13\.7k$/.test(nullLines[3]), JSON.stringify(nullLines[3]));
  check("the account says it is not billed in credits", nullText.includes("this account is not billed in credits; caps per model are shown in the dashboard"));
  check("no balance lines appear", !nullText.includes("left of") && !nullText.includes("packs") && !nullText.includes("pace"));
  check("the source line has no balance caveat", nullLines.at(-1) === "source: /v1/usage 2026-11-10 \u2192 2026-11-16 (UTC days)");
}

{
  // Frozen, spent and 402 states, each with the fix.
  const frozen = renderQuotaReport({ snapshot: { ...snapshot, credits: { ...snapshot.credits, frozen: true } }, now: NOW });
  check("a frozen subscription heads the table with the fix", frozen.includes("  subscription inactive \u2014 credit requests are refused \u00b7 buy a credit pack at cloud.nan.builders, or wait for the reset on Dec 2"), frozen.split("\n")[2]);
  const spent = renderQuotaReport({ snapshot: { ...snapshot, credits: { ...snapshot.credits, remaining: 0.5, used: 6999.5 } }, now: NOW });
  check("an empty pool heads the table with the fix", spent.includes("  credits spent \u2014 buy a credit pack at cloud.nan.builders, or wait for the reset on Dec 2"), spent.split("\n")[2]);
  const seen402 = renderQuotaReport({ snapshot, now: NOW, creditRunOutAt: NOW - 1 });
  check("a seen 402 heads the table too", seen402.includes("  credits spent \u2014 buy a credit pack at cloud.nan.builders, or wait for the reset on Dec 2"), seen402.split("\n")[2]);
}

{
  // Failures, next to data or instead of it.
  const noKeyText = renderQuotaReport({ now: NOW, provider: "nan-builders", error: new FetchError("auth", 'no API key for provider "nan-builders"') });
  check("no data explains itself", noKeyText.startsWith("NaN \u00b7 no data yet"));
  check("a missing key says how to add one", noKeyText.includes("/login nan-builders") && noKeyText.includes("NAN_API_KEY"), noKeyText);
  check("and names the plans that carry credits", noKeyText.includes("keys need a plan with credits (nan_member or Premium) or a credit pack; the Community plan includes none"), noKeyText);
  const rejectedText = renderQuotaReport({ now: NOW, error: new FetchError("auth", "usage: HTTP 401, the API key was rejected", { status: 401 }) });
  check("a rejected key points at the dashboard", rejectedText.includes("cloud.nan.builders \u2192 Settings \u2192 API Keys"), rejectedText);
  check(
    "a schema failure is reported without a stack",
    renderQuotaReport({ now: NOW, error: new FetchError("schema", "usage: totals.total_tokens is not a number") }).includes("usage: totals.total_tokens is not a number"),
  );
  check(
    "a failure next to data is labelled",
    renderQuotaReport({ snapshot, now: NOW, error: new FetchError("server", "usage: HTTP 503") }).includes("last error: usage: HTTP 503"),
  );
  check("the advice never contains a key", !rejectedText.includes("sk-") && !noKeyText.includes("sk-"));
}

check("help mentions the subcommands", HELP_TEXT.includes("/nan-quota refresh") && HELP_TEXT.includes("/nan-quota help"));
check("help names the accounting", HELP_TEXT.includes("shared pool of credits") && HELP_TEXT.includes("/v1/usage"));
check("help lists the settings", ["alwaysShow", "providerId", "glyphs", "models", "refreshSeconds"].every((key) => HELP_TEXT.includes(key)));

// ---------------------------------------------------------------------------
section("packaging");

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
check("VERSION matches package.json", VERSION === pkg.version, `${VERSION} vs ${pkg.version}`);
check("the User-Agent carries the version", USER_AGENT === `pi-nan-quota/${pkg.version}`);
check("the pi manifest points at the entry", pkg.pi?.extensions?.[0] === "./index.ts");
check("the peer floor matches MIN_PI_VERSION", pkg.peerDependencies?.["@earendil-works/pi-coding-agent"] === `>=${MIN_PI_VERSION}`);

// ---------------------------------------------------------------------------
report("RESULT");
