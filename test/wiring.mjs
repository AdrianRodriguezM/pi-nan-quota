// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Wiring tests: the extension driven through a fake `ExtensionAPI` and a fake
 * `ExtensionContext`, with `fetch` stubbed to synthetic payloads derived from
 * the real clock (so the suite stays deterministic whenever it runs).
 *
 * The pure-renderer suite (run.mjs) covers shapes and formatting against the
 * captured fixture; this one covers the glue that no pure function can prove:
 * event registration, the status key, the provider gate, the window
 * re-request on a period rollover, the session line, the 402 scan, and the
 * command output entry.
 *
 *   node test/wiring.mjs
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import nanQuota from "../src/index.ts";
import { shortMonthDate } from "../src/format.ts";
import { check, note, report, section } from "./harness.mjs";

const usageFixture = await import("./fixtures/usage-credits.json", { with: { type: "json" } }).then((m) => m.default);
const modelsFixture = await import("./fixtures/models.json", { with: { type: "json" } }).then((m) => m.default);

// Keep the config lookup hermetic: `configPath()` resolves against $HOME.
process.env.HOME = mkdtempSync(join(tmpdir(), "nan-quota-test-"));

const KEY = "sk-test-key-not-real";
const DAY = 24 * 60 * 60_000;

/** `YYYY-MM-DD` for an epoch ms, UTC. */
const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const today = () => utcDate(Date.now());

// ---------------------------------------------------------------------------
// Fixtures for the network

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
});

/**
 * A usage payload for the window the caller asked for, anchored on the
 * requested start (so the loader's remembered period matches and no
 * re-request happens). `used` grows with every call, which is what the
 * session line measures.
 */
function usagePayloadFor(url, usageCalls) {
  const params = new URL(String(url)).searchParams;
  const start = params.get("start_date") ?? today();
  const end = params.get("end_date") ?? today();
  const used = 1000 + 100 * usageCalls;
  const day = (offset, credits) => ({
    date: utcDate(Date.now() + offset * DAY),
    model: "deepseek-v4-flash",
    prompt_tokens: 1000,
    completion_tokens: 100,
    total_tokens: 1100,
    api_requests: 10,
    cached_tokens: 500,
    credits,
  });
  return {
    object: "usage.report",
    start_date: start,
    end_date: end,
    data: [day(-2, 100.2), day(-1, 200.4), day(0, 300)],
    totals: {
      prompt_tokens: 3000,
      completion_tokens: 300,
      total_tokens: 3300,
      api_requests: 30,
      cached_tokens: 1500,
      credits: 600.6,
      by_model: [
        { model: "deepseek-v4-flash", prompt_tokens: 2000, completion_tokens: 200, total_tokens: 2200, api_requests: 20, cached_tokens: 1000, credits: 500.5 },
        { model: "glm5.3-flash", prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, api_requests: 10, cached_tokens: 500, credits: 100.1 },
        { model: "qwen3.6", prompt_tokens: 400, completion_tokens: 40, total_tokens: 440, api_requests: 4, cached_tokens: 0, credits: 0 },
        { model: "glm5.3", prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, api_requests: 1, cached_tokens: 0, credits: 50 },
      ],
    },
    all_time: { prompt_tokens: 9000, completion_tokens: 900, total_tokens: 9900, api_requests: 90, cached_at: new Date().toISOString() },
    has_more: false,
    next_cursor: null,
    credits: {
      period_start: `${start}T16:50:43Z`,
      period_end: new Date(Date.now() + 10 * DAY).toISOString(),
      allowance: 7000,
      used,
      remaining: 7000 - used,
      pack_credits: 0,
      pack_expires_at: null,
      frozen: false,
    },
  };
}

/**
 * Stub `fetch` for the documented endpoints only. `usageImpl` can override
 * the usage responses per test; every URL is recorded.
 */
function stubFetch(usageImpl) {
  const calls = [];
  let usageCalls = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const target = String(url);
    if (target.includes("api.nan.builders/v1/usage")) {
      usageCalls++;
      return usageImpl ? usageImpl(target, usageCalls, calls) : jsonResponse(usagePayloadFor(target, usageCalls));
    }
    if (target.includes("api.nan.builders/v1/models")) return jsonResponse(modelsFixture);
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
  const sessionEntries = [];
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
    sessionManager: {
      getEntries: () => sessionEntries,
    },
    ui: {
      theme: { fg: (_name, text) => text },
      setStatus: (key_, value) => void statuses.push(value),
      notify: (message, level) => void notifications.push({ message, level }),
    },
  };

  nanQuota(pi);
  return { pi, ctx, state, statuses, entries, notifications, handlers, commands, renderers, sessionEntries };
}

const lastStatus = (statuses) => statuses.at(-1);
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

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
  check("shows whole credits", typeof status === "string" && /\d+ cr/.test(stripAnsi(status)), stripAnsi(status ?? ""));
  check(
    "uses the brand violet in truecolor",
    typeof status === "string" && status.includes("\u001b[38;2;125;57;235m"),
  );
  check(
    "the unused pills are painted too",
    typeof status === "string" && (status.match(/\u001b\[38;2;125;57;235m/g) ?? []).length >= 2,
  );
  check(
    "fits the footer budget",
    typeof status === "string" && stripAnsi(status).length <= 56,
    `length=${typeof status === "string" ? stripAnsi(status).length : "?"}`,
  );
  note(stripAnsi(status ?? ""));
  check("only painted once for one refresh", harness.statuses.length === 1);
}

{
  const calls = stubFetch();
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  check(
    "one usage request per refresh, plus the served list",
    calls.filter((call) => call.url.includes("/v1/usage")).length === 1 && calls.some((call) => call.url.includes("/v1/models")),
    calls.map((call) => call.url).join("\n"),
  );
  check("every request stays on api.nan.builders", calls.every((call) => call.url.includes("api.nan.builders")));
  check("the usage request asks for limit=500", calls.some((call) => call.url.includes("limit=500")));
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
  check("falls back to the 256-colour entry", typeof status === "string" && status.includes("\u001b[38;5;99m"));
  process.env.COLORTERM = "truecolor";
}

section("NaN plans and providers");

{
  // A provider registered under another id is found through its base URL, and
  // its own credential is the one used.
  const calls = stubFetch();
  const harness = makeHarness({ provider: "nan-builders", modelId: "glm5.3-flash", keyProvider: "nan-builders" });
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  check("a provider on api.nan.builders is detected without config", stripAnsi(lastStatus(harness.statuses) ?? "").startsWith("nan \u25b0"));
  check("its credential is the one asked for", harness.state.keyRequests.every((provider) => provider === "nan-builders"));
  check("usage and models are read", ["/v1/usage", "/v1/models"].every((part) => calls.some((call) => call.url.includes(part))));
}

{
  stubFetch();
  const harness = makeHarness({ modelId: "glm5.3" });
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  check("a premium model on a member key says it is not available", stripAnsi(lastStatus(harness.statuses) ?? "") === "nan glm5.3 not available on this key", stripAnsi(lastStatus(harness.statuses) ?? ""));
}

{
  stubFetch();
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  await harness.commands.get("nan-quota").handler("", harness.ctx);
  const text = harness.entries.at(-1)?.data?.text ?? "";
  check("the table hides models the key cannot call", !text.includes("glm5.3 ") && !text.includes("glm5.2"), text);
  check("the table shows the balance", text.includes("left of 7000"), text.split("\n")[2]);
  check("the session line waits for a second reading", !text.includes("since this pi session started"));
  // A second, forced read: `used` grew by 100 in the stub.
  await harness.commands.get("nan-quota").handler("refresh", harness.ctx);
  const text2 = harness.entries.at(-1)?.data?.text ?? "";
  check(
    "the session line shows the credits burned since the first reading",
    text2.includes("+100.0 cr since this pi session started"),
    text2.split("\n").find((line) => line.includes("session")),
  );
}

{
  // A removed setting in a user file is silently ignored.
  const configHome = mkdtempSync(join(tmpdir(), "nan-quota-cfg-"));
  mkdirSync(join(configHome, ".pi", "agent"), { recursive: true });
  writeFileSync(join(configHome, ".pi", "agent", "nan-quota.json"), JSON.stringify({ quotaEndpoint: false, alwaysShow: true }));
  const previousHome = process.env.HOME;
  process.env.HOME = configHome;
  const calls = stubFetch();
  const harness = makeHarness({ modelId: "claude-opus-5-5", provider: "anthropic", baseUrl: "https://api.anthropic.com" });
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  process.env.HOME = previousHome;
  check("a removed setting in the config file is ignored", harness.statuses.length === 1, `${harness.statuses.length} statuses`);
  check("no undocumented host is contacted", calls.every((call) => call.url.includes("api.nan.builders")), calls.map((c) => c.url).join());
  check("the other settings still apply (alwaysShow)", stripAnsi(lastStatus(harness.statuses) ?? "").startsWith("nan "));
}

// ---------------------------------------------------------------------------
section("window re-request on a period rollover");

{
  // First response reveals a period that started 2 days ago: the requested
  // window differs, so the loader re-requests once with the right window and
  // remembers the period from then on.
  const recentStart = () => `${utcDate(Date.now() - 2 * DAY)}T10:00:00Z`;
  const calls = stubFetch((url, usageCalls) => {
    const payload = usagePayloadFor(url, usageCalls);
    if (usageCalls <= 2) payload.credits.period_start = recentStart();
    return jsonResponse(payload);
  });
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);

  const usageCalls = calls.filter((call) => call.url.includes("/v1/usage"));
  check("the first load re-requests with the right window", usageCalls.length === 2, usageCalls.map((c) => c.url).join("\n"));
  const second = new URL(usageCalls[1]?.url ?? "");
  check("the re-request covers the revealed period", second.searchParams.get("start_date") === utcDate(Date.now() - 2 * DAY), second.toString());

  // The period is remembered: the next refresh asks for it directly.
  await harness.commands.get("nan-quota").handler("refresh", harness.ctx);
  const after = calls.filter((call) => call.url.includes("/v1/usage"));
  check("the remembered period needs no re-request", after.length === 3, after.map((c) => c.url).join("\n"));
  check(
    "the remembered window starts on the period",
    new URL(after[2]?.url ?? "").searchParams.get("start_date") === utcDate(Date.now() - 2 * DAY),
    after[2]?.url,
  );
}

{
  // The captured fixture (real payload): whatever it reveals, the loader
  // settles on a window and paints.
  const calls = stubFetch(() => jsonResponse(usageFixture));
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  check("the real fixture parses and paints", typeof lastStatus(harness.statuses) === "string" && stripAnsi(lastStatus(harness.statuses) ?? "").startsWith("nan "));
  check("the fixture's pagination is respected (single page, has_more false)", calls.filter((call) => call.url.includes("/v1/usage")).length <= 2);
}

// ---------------------------------------------------------------------------
section("402: spent pool, seen and cleared");

{
  stubFetch();
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  const healthy = stripAnsi(lastStatus(harness.statuses) ?? "");

  // The newest assistant entry died on 402 insufficient_balance. The
  // segment repaints on the next refresh; model_select forces one now.
  harness.sessionEntries.push({ type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "402 insufficient_balance" } });
  await harness.handlers.get("turn_end")({ turn: {} }, harness.ctx);
  await harness.handlers.get("model_select")({}, harness.ctx);
  check("a 402 flips the segment to the spent state", stripAnsi(lastStatus(harness.statuses) ?? "").startsWith("nan \u26d4 credits spent"), stripAnsi(lastStatus(harness.statuses) ?? ""));

  await harness.commands.get("nan-quota").handler("", harness.ctx);
  const spentText = harness.entries.at(-1)?.data?.text ?? "";
  check("the command heads the table with the fix", spentText.includes("credits spent \u2014 buy a credit pack at cloud.nan.builders, or wait for the reset on"), spentText.split("\n")[2]);

  // A later successful assistant run clears the flag.
  harness.sessionEntries.length = 0;
  harness.sessionEntries.push({ type: "message", message: { role: "assistant", stopReason: "stop" } });
  await harness.handlers.get("turn_end")({ turn: {} }, harness.ctx);
  await harness.handlers.get("model_select")({}, harness.ctx);
  check("a successful run clears the 402", !stripAnsi(lastStatus(harness.statuses) ?? "").includes("credits spent") && stripAnsi(lastStatus(harness.statuses) ?? "").startsWith("nan \u25b0"), stripAnsi(lastStatus(harness.statuses) ?? ""));
}

{
  // A frozen subscription: the balance says so, and everything shouts it.
  stubFetch((url, usageCalls) => {
    const payload = usagePayloadFor(url, usageCalls);
    payload.credits.frozen = true;
    return jsonResponse(payload);
  });
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  check("a frozen subscription shows the paused state", stripAnsi(lastStatus(harness.statuses) ?? "") === "nan \u23f8 subscription inactive \u2014 cloud.nan.builders", stripAnsi(lastStatus(harness.statuses) ?? ""));
}

{
  // An account not billed in credits: tokens, no bar.
  stubFetch((url, usageCalls) => {
    const payload = usagePayloadFor(url, usageCalls);
    payload.credits = null;
    return jsonResponse(payload);
  });
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  const status = stripAnsi(lastStatus(harness.statuses) ?? "");
  check("a null balance shows window tokens", /^nan [\d.]+[kMB]? tokens \(\d+d\)$/.test(status), status);
  check("no bar without credits", !status.includes("\u25b0") && !status.includes("\u25b1"));
  await harness.commands.get("nan-quota").handler("", harness.ctx);
  const text = harness.entries.at(-1)?.data?.text ?? "";
  check("the table switches to the token view", text.includes("this account is not billed in credits; caps per model are shown in the dashboard"), text);
}

// ---------------------------------------------------------------------------
section("lifecycle");

{
  const { mock } = await import("node:test");
  stubFetch();
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let painted = harness.statuses.length;
    await harness.handlers.get("turn_end")({ turn: {} }, harness.ctx);
    check("turn_end does not refresh synchronously", harness.statuses.length === painted);
    mock.timers.tick(15_000);
    await settle();
    check("turn_end refreshes once the debounce window elapses", harness.statuses.length > painted);

    painted = harness.statuses.length;
    await harness.handlers.get("turn_end")({ turn: {} }, harness.ctx);
    let threw = false;
    try {
      await harness.handlers.get("session_shutdown")({ reason: "quit" }, harness.ctx);
    } catch {
      threw = true;
    }
    check("session_shutdown does not throw", !threw);
    mock.timers.tick(15_000);
    await settle();
    check("session_shutdown cancels the pending refresh", harness.statuses.length === painted);
  } finally {
    mock.timers.reset();
  }
}

// ---------------------------------------------------------------------------
section("advice");

{
  // No key at all: the command explains where a key comes from.
  delete process.env.NAN_API_KEY;
  globalThis.fetch = async (url) => {
    throw new Error(`no key, no fetch: ${url}`);
  };
  const harness = makeHarness({ key: "" });
  await harness.commands.get("nan-quota").handler("", harness.ctx);
  const text = harness.entries.at(-1)?.data?.text ?? "";
  check("without a key the command explains how to add one", text.includes("no API key") && text.includes("NAN_API_KEY"), text);
  check("and which plans carry credits", text.includes("keys need a plan with credits (nan_member or Premium) or a credit pack; the Community plan includes none"), text);
  check("the advice never contains a key", !text.includes("sk-"));
  check("nothing was fetched without a key", !text.includes("billing period"));
}

// ---------------------------------------------------------------------------
report("RESULT");
