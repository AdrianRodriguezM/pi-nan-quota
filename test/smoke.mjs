// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Smoke test against a real pi, not a fake.
 *
 * The wiring suite drives the extension through a hand-written stand-in for
 * pi's ExtensionAPI; if that stand-in drifted from pi, it would keep passing.
 * This suite loads the package the way pi does — through `DefaultResourceLoader`
 * and `createAgentSession` from the installed `@earendil-works/pi-coding-agent` —
 * and checks the contract end to end. CI runs it against the oldest supported pi
 * and the latest one.
 *
 * Hermetic: a temporary agent dir and HOME, no API key, and `fetch` replaced by
 * a counter that refuses to reach the network.
 *
 *   node test/smoke.mjs
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { check, note, report, section } from "./harness.mjs";

const agentDir = mkdtempSync(join(tmpdir(), "pi-nan-quota-smoke-"));
process.env.HOME = agentDir;
delete process.env.NAN_API_KEY;

let requests = 0;
globalThis.fetch = async () => {
  requests++;
  throw new Error("the smoke test does not reach the network");
};

const pi = await import("@earendil-works/pi-coding-agent");
const piVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url)), "utf8"),
).version;
note(`pi ${piVersion}`);

// ---------------------------------------------------------------------------
section("loading through pi's resource loader");

const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
const loader = new pi.DefaultResourceLoader({ cwd: agentDir, agentDir, additionalExtensionPaths: [entry] });
await loader.reload();
const loaded = loader.getExtensions();
check("pi loads the package without errors", loaded.errors.length === 0, JSON.stringify(loaded.errors));
check("the extension is listed", loaded.extensions.some((extension) => JSON.stringify(extension).includes(entry)), JSON.stringify(loaded.extensions.map((e) => e.path ?? e.resolvedPath ?? Object.keys(e))));

const { session } = await pi.createAgentSession({
  resourceLoader: loader,
  sessionManager: pi.SessionManager.inMemory(),
  agentDir,
  cwd: agentDir,
});

try {
  await session.bindExtensions({});

  // -------------------------------------------------------------------------
  section("the command, end to end");

  await session.prompt("/nan-quota help");
  const entries = session.sessionManager.getEntries();
  const table = entries.find((candidate) => candidate.type === "custom" && candidate.customType === "nan-quota");
  check("/nan-quota is handled by the extension", table !== undefined, JSON.stringify(entries.map((e) => e.type)));
  check("its output is the help text", String(table?.data?.text ?? "").includes("/nan-quota refresh"));
  check("the output never enters the model's context", (session.messages?.length ?? 0) === 0);

  await session.prompt("/nan-quota");
  const report_ = session.sessionManager
    .getEntries()
    .filter((candidate) => candidate.type === "custom" && candidate.customType === "nan-quota")
    .at(-1);
  const text = String(report_?.data?.text ?? "");
  check("without a key the command explains how to add one", text.includes("no API key") && text.includes("NAN_API_KEY"), text);

  // -------------------------------------------------------------------------
  section("no key, no traffic");

  check("nothing was sent to the network", requests === 0, `${requests} requests`);
} finally {
  session.dispose();
}

report("RESULT");
