// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic test suite. No network access.
 *
 *   npm test
 *
 * Every parser case runs against fixtures captured verbatim from the real API
 * (test/fixtures/quota.json, test/fixtures/usage.json), so CI exercises payloads
 * NaN actually serves without depending on it being reachable. Renderer cases
 * call the pure functions directly, with three colour modes.
 */

import { readFileSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";

import { assertOk, fetchQuota, parseQuotaPayload, parseRetryAfter, requestHeaders, USER_AGENT, VERSION } from "../src/api/quota.ts";
import { fetchUsage, parseUsagePayload, usageUrl, utcMonthWindow } from "../src/api/usage.ts";
import { resolveApiKey } from "../src/auth.ts";
import { backoffFor, Debouncer, MAX_BACKOFF_MS, QuotaCache } from "../src/cache.ts";
import { CAPS_AS_OF } from "../src/caps.ts";
import { HELP_TEXT, renderQuotaReport } from "../src/command.ts";
import { DEFAULT_CONFIG, loadConfig, parseConfig } from "../src/config.ts";
import { formatAge, formatPercent, formatReset, formatResetLong, formatTokens } from "../src/format.ts";
import { MIN_PI_VERSION, snapshotFromQuota, snapshotFromUsage } from "../src/index.ts";
import { canonicalModelId, filterServed, isNanBaseUrl, isNanModel, isNotServed, pickNanProvider, sameModel } from "../src/models.ts";
import { parseModelsPayload } from "../src/api/models.ts";
import { BAR_WIDTH, glyphsFor, pillsFor, renderBar } from "../src/render/bar.ts";
import { detectColorMode, paintBars, paintBrand } from "../src/render/color.ts";
import { MAX_SEGMENT_WIDTH, renderStatus } from "../src/render/status.ts";
import { FetchError } from "../src/types.ts";

import { check, near, note, report, section } from "./harness.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const quotaPayload = fixture("quota");
const usagePayload = fixture("usage");
/** What a member (non-premium) key could call when the fixtures were captured. */
const servedIds = parseModelsPayload(fixture("models"));

/** Fixture clock: the timestamps the payloads were captured at. */
const NOW = Date.parse("2026-11-06T20:50:00Z");
const DAY = 24 * 60 * 60_000;

const usageReport = parseUsagePayload(usagePayload);
const quotaSnapshot = snapshotFromQuota(parseQuotaPayload(quotaPayload), NOW, { usage: usageReport, served: servedIds });
const estimatedSnapshot = snapshotFromUsage(usageReport, NOW, { served: servedIds });

const model = (overrides) => ({ model: "x", label: "x", cap: 0, tokensUsed: 0, remaining: 0, ...overrides });
const snapshot = (models, extra = {}) => ({
  source: "quota",
  estimated: false,
  periodStart: "2026-11-01",
  periodEnd: "2026-12-01T00:00:00Z",
  fetchedAt: NOW,
  models,
  ...extra,
});

/** Theme stub that paints nothing but records the tokens requested. */
function recordingTheme(calls = []) {
  return { calls, fg: (color, text) => (calls.push(color), text) };
}

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

// ---------------------------------------------------------------------------
section("quota: strict payload validation");

const parsedQuota = parseQuotaPayload(quotaPayload);
check("fixture parses every row the server sent", parsedQuota.models.length === 6, `got ${parsedQuota.models.length}`);
check("periodStart is carried over", parsedQuota.periodStart === "2026-11-01");
check("the parser keeps retired rows: the served list decides", parsedQuota.models.some((entry) => entry.model === "glm5.2"));
check("labels come from the caps table", parsedQuota.models[0]?.label === "DeepSeek V4 Flash");
check(
  "window fields survive",
  parsedQuota.models.find((entry) => entry.model === "glm5.3")?.windowHours === 4 &&
    parsedQuota.models.find((entry) => entry.model === "glm5.3")?.fullWindowTokens === 400_000_000,
);
check("updatedAt takes the newest entry", parsedQuota.updatedAt === "2026-11-06T20:48:18Z", parsedQuota.updatedAt);
check("counters are untouched", parsedQuota.models[0]?.tokensUsed === 614626775);

const withModels = (models) => ({ periodStart: "2026-11-01", models });
const good = { model: "deepseek-v4-flash", cap: 1, tokensUsed: 1, remaining: 0 };

check("missing counter is a schema failure", throwsKind(() => parseQuotaPayload(withModels([{ model: "deepseek-v4-flash", cap: 1 }])), "schema"));
check(
  "a numeric string is a schema failure, not a value to coerce",
  throwsKind(() => parseQuotaPayload(withModels([{ ...good, cap: "3000000000" }])), "schema"),
);
check("null model id is a schema failure", throwsKind(() => parseQuotaPayload(withModels([{ ...good, model: null }])), "schema"));
check("negative counter is a schema failure", throwsKind(() => parseQuotaPayload(withModels([{ ...good, tokensUsed: -1 }])), "schema"));
check("an empty model list is valid (nothing capped)", parseQuotaPayload({ models: [] }).models.length === 0);
check("missing models array is a schema failure", throwsKind(() => parseQuotaPayload({}), "schema"));
check("payload that is not an object is a schema failure", throwsKind(() => parseQuotaPayload(null), "schema"));
check(
  "a model this extension has never heard of is kept, with its id as label",
  parseQuotaPayload(withModels([{ ...good, model: "minimax-h3", cap: 9 }])).models[0]?.label === "minimax-h3",
);
check(
  "a duplicated row keeps the first one",
  parseQuotaPayload(withModels([good, { ...good, tokensUsed: 9 }])).models.length === 1,
);
const pooled = parseQuotaPayload(
  withModels([{ ...good, extraTokens: 125_000_000, extraUsable: false, extraExpiresAt: "2027-04-29T00:00:00Z" }]),
).models[0];
check("extra pool size is read", pooled?.extraTokens === 125_000_000);
check("a paused pool is flagged", pooled?.extraUsable === false);
check("the pool's own expiry is read", pooled?.extraExpiresAt === "2027-04-29T00:00:00Z");
check("a negative pool is ignored", parseQuotaPayload(withModels([{ ...good, extraTokens: -5 }])).models[0]?.extraTokens === undefined);
check("cap 0 is legal and kept", parseQuotaPayload(withModels([{ ...good, model: "qwen3.6", cap: 0 }])).models[0]?.cap === 0);
check(
  "remaining is derived when absent",
  parseQuotaPayload(withModels([{ model: "deepseek-v4-flash", cap: 10, tokensUsed: 4 }])).models[0]?.remaining === 6,
);

// ---------------------------------------------------------------------------
section("quota: HTTP mapping");

const response = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
});

const withFetch = (impl, fn) => fn({ fetchImpl: impl, now: () => NOW });

await withFetch(async () => response(200, quotaPayload), async (deps) => {
  check("200 parses every row", (await fetchQuota("sk-test", deps)).models.length === 6);
});

await withFetch(async () => response(401, { error: "nope" }), async (deps) => {
  let error;
  try {
    await fetchQuota("sk-secret-do-not-print", deps);
  } catch (caught) {
    error = caught;
  }
  check("401 maps to auth", error instanceof FetchError && error.kind === "auth");
  check("401 says the key was rejected and keeps the status", /rejected/.test(error?.message ?? "") && error?.status === 401);
  check("the key never appears in the error", !String(error?.message).includes("sk-secret-do-not-print"));
});

await withFetch(async () => response(403, {}), async (deps) => {
  let kind;
  try {
    await fetchQuota("sk-x", deps);
  } catch (caught) {
    kind = caught.kind;
  }
  check("403 maps to auth", kind === "auth");
});

await withFetch(async () => response(429, {}, { "retry-after": "90" }), async (deps) => {
  let error;
  try {
    await fetchQuota("sk-x", deps);
  } catch (caught) {
    error = caught;
  }
  check("429 maps to rate-limit", error?.kind === "rate-limit");
  check("Retry-After is preserved", error?.retryAfterMs === 90_000, String(error?.retryAfterMs));
});

await withFetch(async () => response(503, {}), async (deps) => {
  let kind;
  try {
    await fetchQuota("sk-x", deps);
  } catch (caught) {
    kind = caught.kind;
  }
  check("5xx maps to server", kind === "server");
});

await withFetch(async () => response(200, null, {}, "not-json"), async () => {});
await withFetch(
  async () => {
    throw new Error("socket hang up");
  },
  async (deps) => {
    let kind;
    try {
      await fetchQuota("sk-x", deps);
    } catch (caught) {
      kind = caught.kind;
    }
    check("network failure is classified", kind === "network");
  },
);

let seenHeaders;
await withFetch(
  async (_url, init) => {
    seenHeaders = init.headers;
    return response(200, quotaPayload);
  },
  async (deps) => {
    await fetchQuota("sk-test", deps);
  },
);
check("Authorization uses the bearer scheme", seenHeaders.Authorization === "Bearer sk-test");
check("Accept-Encoding disables gzip (pi's undici proxy bug)", seenHeaders["Accept-Encoding"] === "identity");
check("User-Agent identifies the extension", /^pi-nan-quota\/\d+\.\d+\.\d+$/.test(seenHeaders["User-Agent"]), seenHeaders["User-Agent"]);
check("request headers never carry anything else", Object.keys(seenHeaders).length === 4, Object.keys(seenHeaders).join());

check("Retry-After in seconds", parseRetryAfter("120") === 120_000);
check("Retry-After as an HTTP date", parseRetryAfter(new Date(NOW + 30_000).toUTCString(), NOW) === 30_000);
check("unparseable Retry-After is ignored", parseRetryAfter("soon") === undefined);
check("absent Retry-After is ignored", parseRetryAfter(null) === undefined);
check("2xx passes assertOk", assertOk(response(204), "quota") === undefined);

// ---------------------------------------------------------------------------
section("usage: documented endpoint");

check("fixture totals", usageReport.totalTokens === 1197523000 && usageReport.requests === 12411);
check("by_model is keyed by canonical model", usageReport.byModel["deepseek-v4-flash"] === 614626775);
check("all_time is carried", usageReport.allTimeTokens === 1197532548 && usageReport.cachedAt === "2026-11-06T20:48:04Z");
check("M UTC month starts on the 1st", utcMonthWindow(NOW).startDate === "2026-11-01");
check("M UTC month ends today", utcMonthWindow(NOW).endDate === "2026-11-06");
check("usage URL carries the window", usageUrl("2026-11-01", "2026-11-06").includes("start_date=2026-11-01&end_date=2026-11-06&limit=1"));
check("missing totals is a schema failure", throwsKind(() => parseUsagePayload({}), "schema"));
check("missing total_tokens is a schema failure", throwsKind(() => parseUsagePayload({ totals: {} }), "schema"));
check(
  "by_model is optional",
  parseUsagePayload({ totals: { total_tokens: 5, api_requests: 1 } }).totalTokens === 5,
);

let requestedUrl;
await withFetch(
  async (url) => {
    requestedUrl = url;
    return response(200, usagePayload);
  },
  async (deps) => {
    const report = await fetchUsage("sk-test", { ...deps });
    check("fetchUsage reads the month window", report.totalTokens === 1197523000);
  },
);
check("fetchUsage hits the documented endpoint", requestedUrl.startsWith("https://api.nan.builders/v1/usage?"));
check("fetchUsage asks for one row", requestedUrl.includes("limit=1"));

// ---------------------------------------------------------------------------
section("fallback: usage + dated caps table");

check("source is usage", estimatedSnapshot.source === "usage" && estimatedSnapshot.estimated === true);
check("every caps-table model this key can call is listed", estimatedSnapshot.models.length === 6, String(estimatedSnapshot.models.length));
check("the premium model is dropped for a member key", !estimatedSnapshot.models.some((entry) => entry.model === "glm5.3"));
const estimatedDeepSeek = estimatedSnapshot.models.find((entry) => entry.model === "deepseek-v4-flash");
check("consumption comes from by_model", estimatedDeepSeek?.tokensUsed === 614626775);
check("caps come from the dated table", estimatedDeepSeek?.cap === 3_000_000_000);
check("remaining is derived", estimatedDeepSeek?.remaining === 3_000_000_000 - 614626775);
check("reset is the start of next UTC month", estimatedSnapshot.periodEnd === "2026-12-01T00:00:00Z");
check("periodStart is the current month", estimatedSnapshot.periodStart === "2026-11-01");
check("the usage report travels with the snapshot", estimatedSnapshot.usage?.totalTokens === 1197523000);
check(
  "window metadata survives the fallback",
  snapshotFromUsage(usageReport, NOW).models.find((entry) => entry.model === "glm5.3")?.fullWindowTokens === 400_000_000,
);

// ---------------------------------------------------------------------------
section("served models: the key's plan decides what is shown");

check("the models fixture parses", servedIds.length === 13 && servedIds.includes("minimax-h3"));
check("a member key is not served the premium model", !servedIds.includes("glm5.3"));
check("nobody is served the retired model", !servedIds.includes("glm5.2"));
check("a malformed list is a schema failure", throwsKind(() => parseModelsPayload({ data: "x" }), "schema"));
check("entries without an id are skipped", parseModelsPayload({ data: [{}, { id: "gemma4" }] }).length === 1);
check("ids are canonicalised", parseModelsPayload({ data: [{ id: "nan/GLM-5.3-Flash" }] })[0] === "glm5.3-flash");
check("quota rows are intersected with the served list", !quotaSnapshot.models.some((entry) => entry.model === "glm5.3" || entry.model === "glm5.2"));
check("served rows survive", quotaSnapshot.models.length === 4, String(quotaSnapshot.models.length));
check("without a served list nothing is filtered (fail open)", filterServed([{ model: "glm5.2" }], undefined).length === 1);
check("an empty intersection fails open too", filterServed([{ model: "a" }, { model: "b" }], ["c"]).length === 2);
check("an empty input stays empty", filterServed([], ["c"]).length === 0);
check("isNotServed needs a known list", isNotServed("glm5.3", undefined) === false && isNotServed("glm5.3", servedIds) === true);
check("the snapshot carries the served list", quotaSnapshot.served?.length === 13);

// ---------------------------------------------------------------------------
section("provider detection: baseUrl first, id second");

check("api.nan.builders is NaN", isNanBaseUrl("https://api.nan.builders/v1"));
check("the apex domain is NaN", isNanBaseUrl("https://nan.builders"));
check("a lookalike domain is not", !isNanBaseUrl("https://nan.builders.evil.example/v1") && !isNanBaseUrl("https://evilnan.builders/v1"));
check("garbage is not", !isNanBaseUrl("not a url") && !isNanBaseUrl(undefined));
check("any provider id on a NaN host counts", isNanModel({ provider: "nan-builders", baseUrl: "https://api.nan.builders/v1" }, "nan"));
check("the configured id counts without a URL", isNanModel({ provider: "nan" }, "nan"));
check("other providers do not", !isNanModel({ provider: "anthropic", baseUrl: "https://api.anthropic.com" }, "nan"));
const knownModels = [
  { provider: "anthropic", baseUrl: "https://api.anthropic.com" },
  { provider: "nan-builders", baseUrl: "https://api.nan.builders/v1" },
];
check("the active NaN provider wins", pickNanProvider({ provider: "nan-builders", baseUrl: "https://api.nan.builders/v1" }, knownModels, "nan") === "nan-builders");
check("otherwise a provider on a NaN host is detected", pickNanProvider({ provider: "anthropic" }, knownModels, "nan") === "nan-builders");
check("the configured id wins when some model uses it", pickNanProvider(undefined, [...knownModels, { provider: "nan" }], "nan") === "nan");
check("with nothing detected, the configured id", pickNanProvider(undefined, [], "custom") === "custom");

// ---------------------------------------------------------------------------
section("format: sizes, percentages, durations");

check("1.2B", formatTokens(1_200_000_000) === "1.2B");
check("3.0B", formatTokens(3_000_000_000) === "3.0B");
check("500M drops the .0", formatTokens(500_000_000) === "500M");
check("400M drops the .0", formatTokens(400_000_000) === "400M");
check("607.0M", formatTokens(606_966_720) === "607.0M");
check("34.5M", formatTokens(34_490_632) === "34.5M");
check("560 bytes", formatTokens(562) === "562");
check("0", formatTokens(0) === "0");
check("negative clamps to 0", formatTokens(-5) === "0");
check("requests read as 12.4k", formatTokens(12_411) === "12.4k");

check("20%", formatPercent(614_626_775, 3_000_000_000) === 20);
check("100%", formatPercent(3_000_000_000, 3_000_000_000) === 100);
check("server lag can exceed 100", formatPercent(4_000_000_000, 3_000_000_000) === 133);
check("no cap means 0%", formatPercent(10, 0) === 0);
check("never negative", formatPercent(-10, 100) === 0);

check("days and hours", formatReset(4 * DAY + 3 * 3_600_000) === "4d3h");
check("hours and minutes", formatReset(3 * 3_600_000 + 20 * 60_000) === "3h20m");
check("minutes", formatReset(12 * 60_000) === "12m");
check("a past reset reads 0m", formatReset(-1) === "0m");
check("long variant is spaced", formatResetLong(24 * DAY + 3 * 3_600_000 + 10 * 60_000) === "24d 3h", formatResetLong(24 * DAY + 3 * 3_600_000 + 10 * 60_000));
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

check("cleared when told not to show", renderStatus(quotaSnapshot, { now: NOW, show: false, activeModelId: "deepseek-v4-flash" }) === undefined);
check(
  "with no active NaN model (alwaysShow) the busiest capped model is shown",
  /glm5\.3-flash|26%/.test(stripAnsi(renderStatus(quotaSnapshot, { now: NOW, theme: plainTheme, mode: "none" }) ?? "")),
  stripAnsi(renderStatus(quotaSnapshot, { now: NOW, theme: plainTheme, mode: "none" }) ?? ""),
);
check("no snapshot shows the placeholder", stripAnsi(renderStatus(undefined, { now: NOW, theme: plainTheme }) ?? "").includes("···"));

const deepSeek = renderStatus(quotaSnapshot, {
  now: NOW,
  activeModelId: "deepseek-v4-flash",
  theme: plainTheme,
  mode: "none",
});
check("active model bar and percent", /^nan \u25b0{2}\u25b1{8}  20% /.test(deepSeek ?? ""), JSON.stringify(deepSeek));
check("reset countdown is compact", (deepSeek ?? "").includes("24d3h"), JSON.stringify(deepSeek));
check("segment fits the cap", visibleWidth(deepSeek ?? "") <= MAX_SEGMENT_WIDTH);
for (const used of [1.5e9, 1.5012e9, 1.514e9]) {
  const half = stripAnsi(renderStatus(
    snapshot([model({ model: "deepseek-v4-flash", cap: 3e9, tokensUsed: used, remaining: 3e9 - used, periodEnd: "2026-12-01T00:00:00Z" })]),
    { now: NOW, activeModelId: "deepseek-v4-flash", theme: plainTheme, mode: "none" },
  ) ?? "");
  check(`a raw ${((used / 3e9) * 100).toFixed(2)}% printed as 50% draws exactly half`, half.startsWith(`nan ${bar(5)}  50% `), half);
}

const precise = renderStatus(quotaSnapshot, {
  now: NOW,
  activeModelId: "deepseek-v4-flash",
  theme: ansiTheme,
  mode: "truecolor",
});
check("truecolor uses the brand RGB", (precise ?? "").includes("\x1b[38;2;125;57;235m"));
check("truecolor keeps the width", visibleWidth(precise ?? "") === visibleWidth(deepSeek ?? ""));

const ansi256 = renderStatus(quotaSnapshot, {
  now: NOW,
  activeModelId: "deepseek-v4-flash",
  theme: ansiTheme,
  mode: "ansi256",
});
check("256-colour mode uses index 99", (ansi256 ?? "").includes("\x1b[38;5;99m"));
check("both halves share index 99", (ansi256 ?? "").match(/\x1b\[38;5;99m/g)?.length === 2, JSON.stringify(ansi256));

check("no ANSI when the mode is none", !stripAnsi(deepSeek ?? "").includes("\x1b[") && deepSeek === stripAnsi(deepSeek ?? ""));
check("brand is plain text in none mode", paintBrand("██", "none") === "██");
check("brand truecolor escape", paintBrand("██", "truecolor") === "\x1b[38;2;125;57;235m██\x1b[39m");
check("brand 256 escape", paintBrand("██", "ansi256") === "\x1b[38;5;99m██\x1b[39m");
const tableLine = "  deepseek-v4-flash  \u25b0\u25b0\u25b1\u25b1\u25b1\u25b1\u25b1\u25b1  20%   614.6M / 3.0B";
check("table bars are painted violet", paintBars(tableLine, "truecolor") === tableLine.replace("\u25b0\u25b0\u25b1\u25b1\u25b1\u25b1\u25b1\u25b1", "\x1b[38;2;125;57;235m\u25b0\u25b0\u25b1\u25b1\u25b1\u25b1\u25b1\u25b1\x1b[39m"));
check("the rest of the table line is untouched", stripAnsi(paintBars(tableLine, "truecolor")) === tableLine);
check("table bars stay plain with NO_COLOR", paintBars(tableLine, "none") === tableLine);
check("the safe family is painted too", paintBars("\u25aa\u25ab", "ansi256") === "\x1b[38;5;99m\u25aa\u25ab\x1b[39m");

const hot = snapshot([
  model({ model: "deepseek-v4-flash", cap: 3e9, tokensUsed: 1.86e9, remaining: 1.14e9, periodEnd: "2026-12-01T00:00:00Z" }),
  model({ model: "glm5.3-flash", cap: 2e9, tokensUsed: 1.82e9, remaining: 1.8e8 }),
  model({ model: "mimo-v2.6-flash", cap: 1e9, tokensUsed: 8.6e8, remaining: 1.4e8 }),
  model({ model: "qwen3.8-flash", cap: 5e8, tokensUsed: 1e8, remaining: 4e8 }),
]);
const withAlerts = stripAnsi(
  renderStatus(hot, { now: NOW, activeModelId: "deepseek-v4-flash", theme: plainTheme, mode: "none" }),
);
check("the busiest alert survives the 48-cell cap", withAlerts.includes("· glm5.3-flash 91%"), withAlerts);
check("alerts fit the cap", visibleWidth(withAlerts) <= MAX_SEGMENT_WIDTH);

const roomy = stripAnsi(
  renderStatus(hot, { now: NOW, activeModelId: "deepseek-v4-flash", theme: plainTheme, mode: "none", width: 120 }),
);
check("a wide footer lists both alerts, busiest first", roomy.includes("· glm5.3-flash 91% · mimo-v2.6-flash 86%"), roomy);

const crowded = snapshot([
  model({ model: "deepseek-v4-flash", cap: 3e9, tokensUsed: 1.86e9, remaining: 1.14e9 }),
  model({ model: "glm5.3-flash", cap: 2e9, tokensUsed: 1.82e9, remaining: 1.8e8 }),
  model({ model: "mimo-v2.6-flash", cap: 1e9, tokensUsed: 8.6e8, remaining: 1.4e8 }),
  model({ model: "qwen3.8-flash", cap: 5e8, tokensUsed: 4.9e8, remaining: 1e7 }),
]);
const capped = stripAnsi(
  renderStatus(crowded, { now: NOW, activeModelId: "deepseek-v4-flash", theme: plainTheme, mode: "none", width: 200 }),
);
check("alerts are capped at two", (capped.match(/·/g) ?? []).length === 2, capped);
check(
  "maxAlerts 0 disables them",
  !stripAnsi(renderStatus(hot, { now: NOW, activeModelId: "deepseek-v4-flash", theme: plainTheme, maxAlerts: 0 }) ?? "").includes("·"),
);

const tones = recordingTheme();
renderStatus(hot, { now: NOW, activeModelId: "deepseek-v4-flash", theme: tones, mode: "none" });
check("alerts use the warning token", tones.calls.includes("warning"), tones.calls.join());
const criticalTones = recordingTheme();
const critical = snapshot([model({ model: "glm5.3-flash", cap: 2e9, tokensUsed: 1.98e9, remaining: 2e7 }), model({ model: "qwen3.8-flash", cap: 5e8, tokensUsed: 4.9e8, remaining: 1e7 })]);
renderStatus(critical, { now: NOW, activeModelId: "glm5.3-flash", theme: criticalTones, mode: "none" });
check("≥95% uses the error token", criticalTones.calls.includes("error"), criticalTones.calls.join());

const wide = snapshot([model({ model: "deepseek-v4-flash", cap: 3e9, tokensUsed: 1.86e9, remaining: 1.14e9, periodEnd: "2026-12-01T00:00:00Z" })]);
const stale = stripAnsi(renderStatus(wide, {
  now: NOW + 40 * 60_000,
  activeModelId: "deepseek-v4-flash",
  theme: plainTheme,
  failed: true,
  lastGoodAt: NOW,
}));
check("a failed refresh adds an age suffix", stale.includes("·40m"), stale);
const fresh = stripAnsi(renderStatus(wide, {
  now: NOW + 60_000,
  activeModelId: "deepseek-v4-flash",
  theme: plainTheme,
  failed: true,
  lastGoodAt: NOW,
}));
check("a failure younger than five minutes adds nothing", !fresh.includes("·"), fresh);

const narrow = renderStatus(hot, { now: NOW, activeModelId: "deepseek-v4-flash", theme: ansiTheme, width: 14 });
check("narrow terminals fall back to the short form", stripAnsi(narrow ?? "") === "nan 62%", JSON.stringify(stripAnsi(narrow ?? "")));
check("the short form still fits", visibleWidth(narrow ?? "") <= 14);
check("width 48 is the default", visibleWidth(renderStatus(hot, { now: NOW, activeModelId: "deepseek-v4-flash", theme: ansiTheme }) ?? "") <= MAX_SEGMENT_WIDTH);

check("a cap-0 row says so, with its month tokens", stripAnsi(renderStatus(
  snapshot([model({ model: "qwen3.6", cap: 0, tokensUsed: 12_400_000 })]),
  { now: NOW, activeModelId: "qwen3.6", theme: plainTheme, mode: "none" },
) ?? "") === "nan no cap · 12.4M this month");
check(
  "a served model without a quota row is uncapped, with usage from /v1/usage",
  stripAnsi(renderStatus(quotaSnapshot, { now: NOW, activeModelId: "qwen3.6", theme: plainTheme }) ?? "") === "nan no cap · 427 this month",
  stripAnsi(renderStatus(quotaSnapshot, { now: NOW, activeModelId: "qwen3.6", theme: plainTheme }) ?? ""),
);
check(
  "a brand-new served model is never stuck on the placeholder",
  stripAnsi(renderStatus(quotaSnapshot, { now: NOW, activeModelId: "minimax-h3", theme: plainTheme }) ?? "") === "nan no cap",
);
check(
  "a model the key cannot call says it is not in the plan",
  stripAnsi(renderStatus(quotaSnapshot, { now: NOW, activeModelId: "glm5.3", theme: plainTheme }) ?? "") === "nan glm5.3 not in your plan",
);
check(
  "a retired model is not blamed on the plan",
  stripAnsi(renderStatus(quotaSnapshot, { now: NOW, activeModelId: "glm5.2", theme: plainTheme }) ?? "") === "nan glm5.2 not available on this key",
  stripAnsi(renderStatus(quotaSnapshot, { now: NOW, activeModelId: "glm5.2", theme: plainTheme }) ?? ""),
);
check(
  "without a served list an unmatched model is uncapped, not accused",
  stripAnsi(renderStatus({ ...quotaSnapshot, served: undefined }, { now: NOW, activeModelId: "glm5.3", theme: plainTheme }) ?? "").startsWith("nan no cap"),
);
check("a window of unknown use is not printed in the footer", !stripAnsi(renderStatus(
  snapshot([model({ model: "glm5.3", cap: 3e9, tokensUsed: 0, remaining: 3e9, windowHours: 4, fullWindowTokens: 4e8 })]),
  { now: NOW, activeModelId: "glm5.3", theme: plainTheme, mode: "none" },
) ?? "").includes("4h"));
const pool = snapshot([
  model({ model: "qwen3.8-flash", cap: 5e8, tokensUsed: 5e8, remaining: 0, extraTokens: 1.25e8 }),
  model({ model: "glm5.3-flash", cap: 2e9, tokensUsed: 1.9e9, remaining: 1e8, extraTokens: 5e7 }),
  model({ model: "mimo-v2.6-flash", cap: 1e9, tokensUsed: 9e8, remaining: 1e8, extraTokens: 5e7, extraUsable: false }),
]);
const pooledStatus = stripAnsi(renderStatus(pool, { now: NOW, activeModelId: "qwen3.8-flash", theme: plainTheme, mode: "none", width: 120 }) ?? "");
check("a usable pool is shown next to the percentage", pooledStatus.startsWith(`nan ${bar(10)} 100% +125M`), pooledStatus);
check("alerts carry their pool too", pooledStatus.includes("glm5.3-flash 95% +50.0M"), pooledStatus);
check("a paused pool is not advertised in the footer", !pooledStatus.includes("mimo-v2.6-flash 90% +"), pooledStatus);
check(
  "window percent appears when the payload exposes it",
  stripAnsi(renderStatus(
    snapshot([model({ model: "glm5.3", cap: 3e9, tokensUsed: 0, remaining: 3e9, windowHours: 4, fullWindowTokens: 4e8, windowTokensUsed: 1e8 })]),
    { now: NOW, activeModelId: "glm5.3", theme: plainTheme, mode: "none" },
  ) ?? "").includes("0% 4h 25%"),
);

// ---------------------------------------------------------------------------
section("colour detection");

check("truecolor via COLORTERM", detectColorMode({ COLORTERM: "truecolor" }) === "truecolor");
check("24bit is truecolor", detectColorMode({ COLORTERM: "24bit" }) === "truecolor");
check("default is 256 colours", detectColorMode({}) === "ansi256");
check("NO_COLOR wins", detectColorMode({ COLORTERM: "truecolor", NO_COLOR: "1" }) === "none");
check("NO_COLOR counts even when empty", detectColorMode({ NO_COLOR: "" }) === "none");
check("TERM=dumb disables colour", detectColorMode({ TERM: "dumb" }) === "none");

// ---------------------------------------------------------------------------
section("brand painting");

check("fill is the brand violet in truecolor", paintBrand("ab", "truecolor") === "\u001b[38;2;125;57;235mab\u001b[39m");
check("fill uses 256 entry 99", paintBrand("ab", "ansi256") === "\u001b[38;5;99mab\u001b[39m");
check("fill paints nothing with NO_COLOR", paintBrand("ab", "none") === "ab");

// ---------------------------------------------------------------------------
section("cache: TTL, single-flight, backoff");

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

function harness({ ttlMs, result = () => snapshot([model({ model: "deepseek-v4-flash", cap: 1, tokensUsed: 1 })]) } = {}) {
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
        release = () => resolve(snapshot([model({ model: "deepseek-v4-flash", cap: 1, tokensUsed: 1 })]));
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
      throw new FetchError("network", "quota: socket hang up");
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
      if (fail) throw new FetchError("rate-limit", "quota: HTTP 429", { retryAfterMs: 120_000 });
      return snapshot([model({ model: "deepseek-v4-flash", cap: 1, tokensUsed: 1 })]);
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
      if (fail) throw new FetchError("server", "quota: HTTP 503");
      return snapshot([model({ model: "deepseek-v4-flash", cap: 1, tokensUsed: 1 })]);
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

check("defaults are the documented ones", DEFAULT_CONFIG.refreshSeconds === 120 && DEFAULT_CONFIG.warnAt === 80 && DEFAULT_CONFIG.criticalAt === 95 && DEFAULT_CONFIG.maxAlerts === 2);
check("provider defaults to nan", DEFAULT_CONFIG.providerId === "nan" && DEFAULT_CONFIG.alwaysShow === false);

const configured = parseConfig({ refreshSeconds: 60, warnAt: 70, criticalAt: 90, maxAlerts: 3, alwaysShow: true, providerId: "nan-b", models: ["glm5.3"] });
check("valid fields are applied", configured.refreshSeconds === 60 && configured.alwaysShow === true && configured.providerId === "nan-b");
check("models list is kept", configured.models.length === 1 && configured.models[0] === "glm5.3");
const junk = parseConfig({ refreshSeconds: "60", warnAt: 150, criticalAt: 10, maxAlerts: -1, alwaysShow: "yes", providerId: "  ", models: ["", 3] });
check("invalid fields fall back", junk.refreshSeconds === 120 && junk.warnAt === 80 && junk.alwaysShow === false);
check("critical below warning is clamped", junk.criticalAt === 80, String(junk.criticalAt));
check("maxAlerts keeps its default", junk.maxAlerts === 2);
check("blank provider keeps the default", junk.providerId === "nan");
check("non-string models are dropped", junk.models.length === 0);
check("refreshSeconds is floored at 30 to protect the rate limit", parseConfig({ refreshSeconds: 5 }).refreshSeconds === 30);
check("the quota endpoint is on by default", DEFAULT_CONFIG.quotaEndpoint === true);
check("quotaEndpoint can be turned off", parseConfig({ quotaEndpoint: false }).quotaEndpoint === false);
check("a non-boolean quotaEndpoint is ignored", parseConfig({ quotaEndpoint: "no" }).quotaEndpoint === true);
check("glyphs default to the pill", DEFAULT_CONFIG.glyphs === "pill");
check("glyphs accept the safe family", parseConfig({ glyphs: "safe" }).glyphs === "safe");
check("unknown glyph families are ignored", parseConfig({ glyphs: "emoji" }).glyphs === "pill");
check("non-object config is ignored", parseConfig(null).refreshSeconds === 120);
check("loadConfig on a missing file returns defaults", loadConfig("/nonexistent/nan-quota.json").warnAt === 80);
check(
  "loadConfig on invalid JSON returns defaults",
  loadConfig("x", () => "{ not json").refreshSeconds === 120,
);
check(
  "loadConfig reads a valid file",
  loadConfig("x", () => JSON.stringify({ warnAt: 50 })).warnAt === 50,
);

// ---------------------------------------------------------------------------
section("models: aliases");

check("provider prefix is stripped", canonicalModelId("nan/deepseek-v4-flash") === "deepseek-v4-flash");
check("hyphenated glm maps to the API id", canonicalModelId("glm-5.3") === "glm5.3");
check("ids are case-insensitive", canonicalModelId("GLM5.3-Flash") === "glm5.3-flash");
check("sameModel tolerates spelling", sameModel("nan/glm-5.3", "glm5.3") === true);

// ---------------------------------------------------------------------------
section("/nan-quota: table output");

const reportText = renderQuotaReport({ snapshot: quotaSnapshot, usage: usageReport, now: NOW, capsAsOf: CAPS_AS_OF });
const reportLines = reportText.split("\n");
note(reportLines[0]);

check("header carries the period and the reset", reportLines[0] === "NaN · period 2026-11-01 → 2026-12-01 (resets in 24d 3h)", reportLines[0]);
check("deepseek row is aligned and complete", /^ {2}deepseek-v4-flash +\u25b0{2}\u25b1{8} +20% +614\.6M \/ 3\.0B +2\.4B free$/.test(reportLines[2]), JSON.stringify(reportLines[2]));
check("glm5.3-flash row", /^ {2}glm5\.3-flash +\u25b0{3}\u25b1{7} +26% +529\.3M \/ 2\.0B +1\.5B free$/.test(reportLines[3]), JSON.stringify(reportLines[3]));
check("a member key's table has the four models it can call", (reportText.match(/ free/g) ?? []).length === 4);
check("the premium model is not listed for a member key", !/^ {2}glm5\.3 /m.test(reportText));
const premiumText = renderQuotaReport({
  snapshot: snapshotFromQuota(parseQuotaPayload(quotaPayload), NOW, { served: [...servedIds, "glm5.3"] }),
  now: NOW,
  capsAsOf: CAPS_AS_OF,
});
check("a premium key gets the glm5.3 row with its 4h window", /^ {2}glm5\.3 .*3\.0B free +4h window: 400M$/m.test(premiumText), premiumText);
check("percentages are not marked as estimates", !reportText.includes("~"));
check("usage line sums month, all-time and requests", reportText.includes("month: 1.2B · total: 1.2B · 12.4k requests"));
check("source line names the server and the update time", reportLines.at(-1) === "source: quota (server) · updated 20:48 UTC", JSON.stringify(reportLines.at(-1)));
check("retired glm5.2 never appears", !reportText.includes("glm5.2") && !premiumText.includes("glm5.2"));
check(
  "uncapped traffic is listed from the usage report",
  reportText.includes("other models this month: qwen3-embedding 14.8k · qwen3.6 427 · gemma4 135"),
  reportText,
);
const poolText = renderQuotaReport({
  snapshot: snapshot([
    model({ model: "qwen3.8-flash", cap: 5e8, tokensUsed: 5e8, remaining: 0, extraTokens: 1.25e8, extraExpiresAt: "2027-04-29T00:00:00Z" }),
    model({ model: "mimo-v2.6-flash", cap: 1e9, tokensUsed: 1e8, remaining: 9e8, extraTokens: 5e7, extraUsable: false }),
  ]),
  now: NOW,
});
check("a pool is listed with its own expiry", poolText.includes("+125M extra until 2027-04-29"), poolText);
check("a paused pool says why", poolText.includes("+50.0M extra (paused: needs an active membership)"), poolText);

const estimatedText = renderQuotaReport({ snapshot: estimatedSnapshot, now: NOW, capsAsOf: CAPS_AS_OF });
check("estimated percentages are marked", estimatedText.includes("~20%") && estimatedText.includes("~7%"));
check("estimated source names the caps date", estimatedText.includes("source: /v1/usage + the docs caps (2026-11-06, estimated ~)"));
check("cap-less models get their own line", estimatedText.includes("other models this month: qwen3-embedding 14.8k · qwen3.6 427 · gemma4 135"), estimatedText);
check("the estimated table shows every capped model the key can call", (estimatedText.match(/ free/g) ?? []).length === 4);
check(
  "a disabled quota endpoint is stated in the source line",
  renderQuotaReport({ snapshot: { ...estimatedSnapshot, quotaEndpointDisabled: true }, now: NOW }).includes("estimated ~) · quota endpoint off"),
);

const noKeyText = renderQuotaReport({ now: NOW, provider: "nan-builders", error: new FetchError("auth", 'no API key for provider "nan-builders"') });
check("no data explains itself", noKeyText.startsWith("NaN · no data yet"));
check("a missing key says how to add one", noKeyText.includes("/login nan-builders") && noKeyText.includes("NAN_API_KEY"), noKeyText);
check("and that the Community plan has no key", noKeyText.includes("Community plan has no API access"));
const rejectedText = renderQuotaReport({ now: NOW, error: new FetchError("auth", "quota: HTTP 401, the API key was rejected", { status: 401 }) });
check("a rejected key points at the dashboard", rejectedText.includes("cloud.nan.builders → Settings → API Keys"), rejectedText);
check("a rejected key mentions the plans", rejectedText.includes("member or GLM 5.3 premium"));
check(
  "a schema failure is reported without a stack",
  renderQuotaReport({ now: NOW, error: new FetchError("schema", "quota: models is not an array") }).includes("quota: models is not an array"),
);
check(
  "a failure next to data is labelled",
  renderQuotaReport({ snapshot: quotaSnapshot, now: NOW, error: new FetchError("server", "quota: HTTP 503") }).includes("last error: quota: HTTP 503"),
);
check("the advice never contains a key", !rejectedText.includes("sk-") && !noKeyText.includes("sk-"));
check("help mentions the subcommands", HELP_TEXT.includes("/nan-quota refresh") && HELP_TEXT.includes("/nan-quota help"));
check("help lists the settings", HELP_TEXT.includes("quotaEndpoint") && HELP_TEXT.includes("glyphs"));

// ---------------------------------------------------------------------------
section("packaging");

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
check("VERSION matches package.json", VERSION === pkg.version, `${VERSION} vs ${pkg.version}`);
check("the User-Agent carries the version", USER_AGENT === `pi-nan-quota/${pkg.version}`);
check("the pi manifest points at the entry", pkg.pi?.extensions?.[0] === "./index.ts");
check("the peer floor matches MIN_PI_VERSION", pkg.peerDependencies?.["@earendil-works/pi-coding-agent"] === `>=${MIN_PI_VERSION}`);

// ---------------------------------------------------------------------------
report("RESULT");
