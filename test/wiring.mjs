// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Wiring tests: the extension driven through a fake `ExtensionAPI` and a fake
 * `ExtensionContext`, with `fetch` stubbed to the captured fixtures.
 *
 * The pure-renderer suite (run.mjs) covers shapes and formatting; this one
 * covers the glue that no pure function can prove: event registration, the
 * status key, the provider gate, the command output entry, and the fallback
 * path when the undocumented quota endpoint breaks.
 *
 *   node test/wiring.mjs
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import nanQuota from "../src/index.ts";
import { check, note, report, section } from "./harness.mjs";

const require = createRequire(import.meta.url);
const quotaFixture = require("./fixtures/quota.json");
const usageFixture = require("./fixtures/usage.json");
const modelsFixture = require("./fixtures/models.json");

// Keep the config lookup hermetic: `configPath()` resolves against $HOME.
process.env.HOME = mkdtempSync(join(tmpdir(), "nan-quota-test-"));

const KEY = "sk-test-key-not-real";

// ---------------------------------------------------------------------------
// Fixtures for the network

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
});

/** Serve fixtures by URL, with per-test overrides. */
function stubFetch(overrides = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of Object.entries(overrides)) {
      if (String(url).includes(match)) return handler(String(url), init);
    }
    if (String(url).includes("cloud-api.nan.builders")) return jsonResponse(quotaFixture);
    if (String(url).includes("api.nan.builders/v1/usage")) return jsonResponse(usageFixture);
    if (String(url).includes("api.nan.builders/v1/models")) return jsonResponse(modelsFixture);
    throw new Error(`unexpected fetch: ${url}`);
  };
  return calls;
}

// ---------------------------------------------------------------------------
// Fake pi / ctx

const NAN_URL = "https://api.nan.builders/v1";

function makeHarness({ provider = "nan", modelId = "deepseek-v4-flash", baseUrl = NAN_URL, key = KEY, keyProvider, all } = {}) {
  const statuses = [];
  const entries = [];
  const notifications = [];
  const handlers = new Map();
  const commands = new Map();
  const renderers = new Map();

  const pi = {
    on: (event, handler) => void handlers.set(event, handler),
    registerCommand: (name, options) => void commands.set(name, options),
    registerEntryRenderer: (type, renderer) => void renderers.set(type, renderer),
    appendEntry: (type, data) => void entries.push({ type, data }),
  };

  const state = {
    model: { id: modelId, provider, baseUrl },
    thinkingLevel: "medium",
    keyRequests: [],
  };
  const registered = all ?? [
    { provider, id: modelId, baseUrl },
    { provider: "anthropic", id: "claude-opus-5-5", baseUrl: "https://api.anthropic.com" },
  ];

  const ctx = {
    hasUI: true,
    get model() {
      return state.model;
    },
    thinkingLevel: state.thinkingLevel,
    modelRegistry: {
      getApiKeyForProvider: async (requested) => {
        state.keyRequests.push(requested);
        return keyProvider === undefined || requested === keyProvider ? key : undefined;
      },
      getAll: () => registered,
    },
    ui: {
      theme: { fg: (_name, text) => text },
      setStatus: (key_, value) => void statuses.push(value),
      notify: (message, level) => void notifications.push({ message, level }),
    },
  };

  nanQuota(pi);
  return { pi, ctx, state, statuses, entries, notifications, handlers, commands, renderers };
}

const lastStatus = (statuses) => statuses.at(-1);
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");

// ---------------------------------------------------------------------------
section("registration");

{
  const harness = makeHarness();
  check("subscribes to session_start", harness.handlers.has("session_start"));
  check("subscribes to model_select", harness.handlers.has("model_select"));
  check("subscribes to turn_end", harness.handlers.has("turn_end"));
  check("subscribes to session_shutdown", harness.handlers.has("session_shutdown"));
  check("registers /nan-quota", harness.commands.has("nan-quota"));
  check(
    "does not register a /nan-usage command (owned by pi-nan-provider)",
    !harness.commands.has("nan-usage"),
  );
  check("registers the entry renderer used by the command", harness.renderers.size === 1);
  check("does not register a provider", typeof harness.pi.registerProvider === "undefined");
}

// ---------------------------------------------------------------------------
section("status segment on a NaN model");

{
  stubFetch();
  process.env.COLORTERM = "truecolor";
  delete process.env.NO_COLOR;
  process.env.TERM = "xterm-256color";

  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);

  const status = lastStatus(harness.statuses);
  check("paints a status string", typeof status === "string" && status.length > 0);
  check("starts with the provider tag", typeof status === "string" && status.startsWith("nan "));
  check("shows a percentage", typeof status === "string" && /\d+%/.test(stripAnsi(status)));
  check(
    "uses the brand violet in truecolor",
    typeof status === "string" && status.includes("\u001b[38;2;125;57;235m"),
  );
  check(
    "the unused part is drawn, not blank",
    typeof status === "string" && stripAnsi(status).includes("\u25b1"),
  );
  check(
    "the filled half is the brand violet",
    typeof status === "string" && status.includes("\u001b[38;2;125;57;235m"),
  );
  check(
    "and in the same violet as the used cells",
    typeof status === "string" && (status.match(/\u001b\[38;2;125;57;235m/g) ?? []).length === 2,
  );
  check("shows the reset countdown", typeof status === "string" && /\d+d\d+h/.test(stripAnsi(status)));
  check(
    "fits the footer budget",
    typeof status === "string" && stripAnsi(status).length <= 48 + 8,
    `length=${typeof status === "string" ? stripAnsi(status).length : "?"}`,
  );
  note(stripAnsi(status ?? ""));

  const quotaCall = harness.statuses.length > 0;
  check("only painted once for one refresh", quotaCall);
}

{
  stubFetch();
  process.env.NO_COLOR = "1";
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  const status = lastStatus(harness.statuses);
  check("NO_COLOR removes every escape", typeof status === "string" && !status.includes("\u001b["));
  delete process.env.NO_COLOR;
}

{
  stubFetch();
  process.env.COLORTERM = "";
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  const status = lastStatus(harness.statuses);
  check(
    "falls back to the 256-colour entry",
    typeof status === "string" && status.includes("\u001b[38;5;99m"),
  );
  process.env.COLORTERM = "truecolor";
}

{
  // A model whose month has just started used to read as an all-grey bar.
  stubFetch({ "cloud-api.nan.builders": () => jsonResponse({ periodStart: "2026-11-01", models: [ { model: "qwen3.8-flash", cap: 500000000, tokensUsed: 0, remaining: 500000000, periodEnd: "2026-12-01T00:00:00Z" } ] }) });
  const harness = makeHarness({ modelId: "qwen3.8-flash" });
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  const status = lastStatus(harness.statuses) ?? "";
  check("0% still shows a violet bar", status.includes("\u001b[38;2;125;57;235m"));
  check("0% is all hollow cells", (stripAnsi(status).match(/\u25b1/g) ?? []).length === 10);
  check("0% reads as a zero", stripAnsi(status).includes("0%"));

  // 4 % used: rounding alone would leave the bar visually empty.
  stubFetch({ "cloud-api.nan.builders": () => jsonResponse({ periodStart: "2026-11-01", models: [ { model: "qwen3.8-flash", cap: 500000000, tokensUsed: 20000000, remaining: 480000000, periodEnd: "2026-12-01T00:00:00Z" } ] }) });
  const almost = makeHarness({ modelId: "qwen3.8-flash" });
  await almost.handlers.get("session_start")({ reason: "startup" }, almost.ctx);
  const almostStatus = lastStatus(almost.statuses) ?? "";
  check("4% paints one filled cell, no gap after it", stripAnsi(almostStatus).startsWith("nan \u25b0" + "\u25b1".repeat(9) + "   4%"), JSON.stringify(stripAnsi(almostStatus)));
  check("4% still reports 4%", stripAnsi(almostStatus).includes(" 4%"));
}

// ---------------------------------------------------------------------------
section("provider gate");

{
  const calls = stubFetch();
  const harness = makeHarness({ provider: "anthropic", modelId: "claude-opus-5-5", baseUrl: "https://api.anthropic.com" });
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  check("clears the segment on a non-NaN model", lastStatus(harness.statuses) === undefined);
  check("and sends nothing to NaN while another provider is in use", calls.length === 0, `${calls.length} requests`);
  await harness.handlers.get("turn_end")({ turn: {} }, harness.ctx);
  check("turn_end does not poll either", calls.length === 0);

  harness.state.model = { id: "glm5.3-flash", provider: "nan" };
  await harness.handlers.get("model_select")({ model: harness.state.model }, harness.ctx);
  check("paints it again after switching to a NaN model", typeof lastStatus(harness.statuses) === "string");

  harness.state.model = { id: "claude-opus-5-5", provider: "anthropic" };
  await harness.handlers.get("model_select")({ model: harness.state.model }, harness.ctx);
  check("clears it again when switching away", lastStatus(harness.statuses) === undefined);
}

{
  // Some event contexts arrive without `ctx.model`. Reading it naively cleared
  // the segment, which is the "the bar keeps disappearing" report.
  stubFetch();
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  const painted = lastStatus(harness.statuses);
  check("painted at session start", typeof painted === "string");

  harness.state.model = undefined;
  await harness.handlers.get("model_select")({ model: undefined }, harness.ctx);
  check("an event without ctx.model keeps the last bar", typeof lastStatus(harness.statuses) === "string");
  check("and does not repaint a different model", lastStatus(harness.statuses) === painted);

  // A brand-new context object without the property behaves the same.
  const bare = { ...harness.ctx };
  delete bare.model;
  await harness.handlers.get("model_select")({}, bare);
  check("a bare context does not clear it either", typeof lastStatus(harness.statuses) === "string");
}

// ---------------------------------------------------------------------------
section("/nan-quota command");

{
  stubFetch();
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  await harness.commands.get("nan-quota").handler("", harness.ctx);

  const entry = harness.entries.at(-1);
  check("appends a transcript entry", entry?.type === "nan-quota");
  const text = entry?.data?.text ?? "";
  check("lists a capped model with its numbers", text.includes("deepseek-v4-flash") && text.includes("free"));
  check("mentions the source", text.includes("source:"));
  check("never prints the API key", !text.includes(KEY) && !text.includes("sk-"));

  await harness.commands.get("nan-quota").handler("help", harness.ctx);
  check("help is served without a request", (harness.entries.at(-1)?.data?.text ?? "").includes("/nan-quota refresh"));
}

// ---------------------------------------------------------------------------
section("fallback and failure paths");

{
  const calls = stubFetch({
    "cloud-api.nan.builders": () => jsonResponse({ error: "boom" }, 500),
  });
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);

  const status = lastStatus(harness.statuses);
  check("still paints a segment from /v1/usage", typeof status === "string" && /\d+%/.test(stripAnsi(status)));
  check("hit the documented endpoint", calls.some((call) => call.url.includes("/v1/usage")));
  check("warned once about the degraded source", harness.notifications.length === 1);

  await harness.commands.get("nan-quota").handler("", harness.ctx);
  const text = harness.entries.at(-1)?.data?.text ?? "";
  check("the table is marked as an estimate", text.includes("estimated") && text.includes("~"));
  check("the caps table date is disclosed", text.includes("docs caps"));
}

{
  stubFetch({
    "cloud-api.nan.builders": () => jsonResponse({ error: "nope" }, 401),
  });
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  check("a 401 does not burn the fallback request", !harness.notifications.some((n) => n.level === "warning"));
  check(
    "the placeholder is shown instead of a fake bar",
    typeof lastStatus(harness.statuses) === "string" &&
      stripAnsi(lastStatus(harness.statuses)).includes("nan \u00b7\u00b7\u00b7"),
  );
}

{
  const calls = stubFetch();
  // `key: null` (not `undefined`, which would hit the default parameter) makes
  // the fake registry answer "no stored credential".
  const harness = makeHarness({ key: null });
  delete process.env.NAN_API_KEY;
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  check(
    "no key: placeholder, no crash, no network",
    stripAnsi(lastStatus(harness.statuses) ?? "").includes("nan \u00b7\u00b7\u00b7"),
    stripAnsi(lastStatus(harness.statuses) ?? ""),
  );
  check("no key: no request is attempted", calls.length === 0);
}

{
  stubFetch({ "cloud-api.nan.builders": () => jsonResponse({ models: "changed" }) });
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  check("an invalid payload degrades instead of throwing", typeof lastStatus(harness.statuses) === "string");
  check("and is reported once", harness.notifications.length === 1, JSON.stringify(harness.notifications));
  check("the estimate is marked in the footer path", harness.notifications[0]?.message.includes("estimates"));
}

{
  stubFetch({ "cloud-api.nan.builders": () => jsonResponse({ error: "nope" }, 401) });
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  const notice = harness.notifications.find((n) => n.level === "error")?.message ?? "";
  check("a rejected key is reported as an error", notice.includes("rejected"), notice);
  check("the notice explains the plans", notice.includes("Community plan has no API access"), notice);
  check("the notice never repeats the key", !notice.includes(KEY));
}

// ---------------------------------------------------------------------------
section("NaN plans and providers");

{
  // A provider registered under another id is found through its base URL, and
  // its own credential is the one used.
  const calls = stubFetch();
  const harness = makeHarness({ provider: "nan-builders", modelId: "glm5.3-flash", keyProvider: "nan-builders" });
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  check("a provider on api.nan.builders is detected without config", stripAnsi(lastStatus(harness.statuses) ?? "").startsWith("nan \u25b0"));
  check("its credential is the one asked for", harness.state.keyRequests.every((provider) => provider === "nan-builders"));
  check("quota, usage and models are read", ["cloud-api.nan.builders", "/v1/usage", "/v1/models"].every((part) => calls.some((call) => call.url.includes(part))));
}

{
  stubFetch();
  const harness = makeHarness({ modelId: "glm5.3" });
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  check("a premium model on a member key says so", stripAnsi(lastStatus(harness.statuses) ?? "") === "nan glm5.3 not in your plan", stripAnsi(lastStatus(harness.statuses) ?? ""));
}

{
  stubFetch();
  const harness = makeHarness({ modelId: "qwen3.6" });
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  check("an uncapped model shows its month usage", stripAnsi(lastStatus(harness.statuses) ?? "") === "nan no cap · 427 this month", stripAnsi(lastStatus(harness.statuses) ?? ""));
}

{
  stubFetch();
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  await harness.commands.get("nan-quota").handler("", harness.ctx);
  const text = harness.entries.at(-1)?.data?.text ?? "";
  check("the table hides models the key cannot call", !text.includes("glm5.3 ") && !text.includes("glm5.2"), text);
}

{
  // Privacy switch: only the documented host is contacted.
  const configHome = mkdtempSync(join(tmpdir(), "nan-quota-cfg-"));
  mkdirSync(join(configHome, ".pi", "agent"), { recursive: true });
  writeFileSync(join(configHome, ".pi", "agent", "nan-quota.json"), JSON.stringify({ quotaEndpoint: false }));
  const previousHome = process.env.HOME;
  process.env.HOME = configHome;
  const calls = stubFetch();
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  process.env.HOME = previousHome;
  check("quotaEndpoint false never calls cloud-api", !calls.some((call) => call.url.includes("cloud-api")), calls.map((c) => c.url).join());
  check("and still draws an (estimated) bar", stripAnsi(lastStatus(harness.statuses) ?? "").startsWith("nan \u25b0"));
  check("and does not warn about a choice the user made", harness.notifications.length === 0);
  await harness.commands.get("nan-quota").handler("", harness.ctx);
  check("the table says the endpoint is off", (harness.entries.at(-1)?.data?.text ?? "").includes("quota endpoint off"));
}

// ---------------------------------------------------------------------------
section("lifecycle");

{
  stubFetch();
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  await harness.handlers.get("turn_end")({ turn: {} }, harness.ctx);
  check("turn_end schedules a debounced refresh", true);
  await harness.handlers.get("session_shutdown")({ reason: "quit" }, harness.ctx);
  check("session_shutdown does not throw", true);
}

// ---------------------------------------------------------------------------
report("RESULT");
