# pi-nan-quota

Your [NaN Builders](https://nan.builders) quota in the [pi](https://pi.dev) footer:
a bar for the model you are using, in NaN's violet, and a `/nan-quota` command
with the per-model breakdown.

```
nan ▰▰▱▱▱▱▱▱  20% 24d3h
nan ▰▰▰▰▰▰▱▱  71% 24d3h · glm5.3-flash 88%
```

Read-only. It does not register a provider, does not write any configuration,
does not touch `auth.json`, and sends nothing anywhere while you are using a
model from another provider (unless you ask for that with `alwaysShow`).

> Unofficial. Not affiliated with NaN Builders or Helmcode.

## Install

```bash
pi install npm:pi-nan-quota
```

Then pick a NaN model (`/model`). The segment appears in the footer within a
second or two.

### Requirements

- **pi ≥ 1.3.0** and **Node.js ≥ 22**.
- **A NaN API key** from an inference plan: *NaN member* or *GLM 5.3 premium*.
  The *Community* plan has no API access, so there is no key to read quota with.
  Create one at [cloud.nan.builders](https://cloud.nan.builders/) → Settings → API
  Keys.
- **The NaN provider configured in pi**, any of:
  - the `nan` block in `~/.pi/agent/models.json` from
    [NaN's pi guide](https://nan.builders/docs/pi) (or written by the NaN CLI);
  - [`@gtrabanco/pi-nan-provider`](https://www.npmjs.com/package/@gtrabanco/pi-nan-provider);
  - any provider whose `baseUrl` is on `nan.builders`, whatever its id.

The key is read from that provider's stored credential (`/login <provider>`),
falling back to `NAN_API_KEY`.

## What you see

### Footer

Drawn only while the active model talks to NaN (or always, with `alwaysShow`):

| Situation | Segment |
|---|---|
| Monthly cap, 20 % used, resets in 24 days | `nan ▰▰▱▱▱▱▱▱  20% 24d3h` |
| Another model is about to run out | `nan ▰▰▰▰▰▰▱▱  71% 24d3h · glm5.3-flash 88%` |
| Cap reached, a purchased extra pool is backing it | `nan ▰▰▰▰▰▰▰▰ 100% +125M 24d3h` |
| A model NaN does not cap (`qwen3.6`, `gemma4`, new models) | `nan no cap · 427 this month` |
| A model your plan does not include (`glm5.3` on a member key) | `nan glm5.3 not in your plan` |
| A model NaN no longer serves (`glm5.2`) | `nan glm5.2 not available on this key` |
| First read still in flight, or no key | `nan ···` |
| Last refresh failed; the bar is 40 minutes old | `nan ▰▰▱▱▱▱▱▱  20% 24d3h ·40m` |
| The active model is not a NaN one | *(nothing)* |

The bar is eight pills, `▰` for the used part and `▱` for the rest, all in NaN's
violet `#7D39EB`, with no gap between the two parts. The pill the usage is
currently in counts as used, so any usage at all lights the first pill and the
bar always ends on a solid one. The bar is always eight columns and the
percentage four, so nothing in the footer moves as the numbers change.

From `warnAt` (80 %) the used part and the alerts switch to your theme's warning
colour, from `criticalAt` (95 %) to its error colour.

### `/nan-quota`

```
NaN · period 2026-11-01 → 2026-12-01 (resets in 24d 3h)

  deepseek-v4-flash  ▰▰▱▱▱▱▱▱  20%   614.6M / 3.0B    2.4B free
  glm5.3-flash       ▰▰▰▱▱▱▱▱  26%   529.3M / 2.0B    1.5B free
  mimo-v2.6-flash    ▰▱▱▱▱▱▱▱   2%    19.1M / 1.0B  980.9M free
  qwen3.8-flash      ▰▱▱▱▱▱▱▱   7%    34.5M / 500M  465.5M free

other models this month: qwen3-embedding 14.8k · qwen3.6 427 · gemma4 135

month: 1.2B · total: 1.2B · 12.4k requests

source: quota (server) · updated 20:48 UTC
```

On a GLM 5.3 premium key, `glm5.3` gets its own row with its rolling window
(`4h window: 400M`). A purchased extra pool adds `+125M extra until 2027-04-29`
to its model's row, or `(paused: needs an active membership)` when NaN has
paused it.

The table is written to the transcript as a custom entry, which pi keeps out of
the model's context: asking for your quota costs no tokens.

- `/nan-quota refresh` reads the API now, ignoring the cache.
- `/nan-quota help` lists the subcommands and settings.

## How it works with NaN's plans

The extension does not carry a list of plans, premium models or retired models.
It asks NaN:

- **Caps, consumption, reset and extra pools** come from the quota endpoint the
  NaN dashboard uses, so a cap NaN changes tomorrow is right tomorrow.
- **Which models your key can call** comes from the documented
  [`GET /v1/models`](https://nan.builders/docs/api), which NaN filters by plan.
  That is how a member key does not see `glm5.3`, nobody sees retired models such
  as `glm5.2` (the quota endpoint still reports both), and a model NaN starts
  serving today shows up today.
- **Month and all-time totals**, and the usage of uncapped models, come from the
  documented [`GET /v1/usage`](https://nan.builders/docs/api).

Percentages are always against the monthly cap. A purchased extra pool is shown
next to it, not folded into it: the API reports what is left in a pool, not how
large it was or in which order NaN draws from it.

The rolling window of the premium model is shown by size only: NaN reports how
large the window is, not how much of it has been used, and the extension does not
guess.

## Privacy and network

Requests go to two NaN hosts, with your key in the `Authorization` header and
`pi-nan-quota/<version>` as the user agent. Nothing else is sent, and nothing is
sent anywhere else. There is no telemetry.

| Request | Host | Documented | When |
|---|---|---|---|
| `GET /api/usage/quota` | `cloud-api.nan.builders` | no | each refresh |
| `GET /v1/usage` | `api.nan.builders` | [yes](https://nan.builders/docs/api) | each refresh |
| `GET /v1/models` | `api.nan.builders` | [yes](https://nan.builders/docs/api) | at most hourly |

A refresh happens when a session starts on a NaN model, when you switch to one,
after a turn (at most once every two minutes), and on `/nan-quota`. That is well
under the documented limit of the usage endpoint (30 requests per minute, counted
separately from inference).

The quota endpoint is not in NaN's published documentation; it is the one the
dashboard reads, and its own error message states that `sk-` API keys are
accepted. To keep every request on the documented API, turn it off:

```json
{ "quotaEndpoint": false }
```

Caps then come from a table copied from [NaN's model docs](https://nan.builders/docs/models),
dated in `src/caps.ts`, and every percentage is marked `~` as an estimate. The
same thing happens automatically, with one warning, if the quota endpoint ever
stops answering in the expected shape.

## Configuration

`~/.pi/agent/nan-quota.json`, every key optional:

```json
{
  "warnAt": 80,
  "criticalAt": 95,
  "maxAlerts": 2,
  "alwaysShow": false,
  "providerId": "nan",
  "glyphs": "pill",
  "quotaEndpoint": true,
  "models": [],
  "refreshSeconds": 120
}
```

| Key | Default | Meaning |
|---|---|---|
| `warnAt` | `80` | Percentage at which the bar turns to the warning colour and other models start appearing as alerts. |
| `criticalAt` | `95` | Percentage at which it turns to the error colour. Never below `warnAt`. |
| `maxAlerts` | `2` | How many other models may append `· model 91%`. `0` turns alerts off. |
| `alwaysShow` | `false` | Draw the segment with any model; it then shows your capped model closest to its limit. |
| `providerId` | `"nan"` | Provider id to treat as NaN when its models have no `nan.builders` base URL. |
| `glyphs` | `"pill"` | `"pill"` (`▰`/`▱`) or `"safe"` (`▪`/`▫`) for fonts without the parallelograms. |
| `quotaEndpoint` | `true` | `false` keeps every request on the documented API (see above). |
| `models` | `[]` | Restrict the footer and the table to these model ids. |
| `refreshSeconds` | `120` | How long a successful read is reused. Minimum `30`. |

An invalid value is ignored on its own, so one typo does not reset the rest. The
file is read again on `/reload`.

`PI_NAN_QUOTA_GLYPHS=safe` switches the glyphs for a single session.

## Terminals and fonts

- Colour follows the terminal: 24-bit when `COLORTERM` says `truecolor`, the
  nearest of 256 colours otherwise, none with `NO_COLOR` or `TERM=dumb` (the
  pills still show the progress through their shape).
- `▰` and `▱` are East Asian Width *neutral*: one column wide even where
  ambiguous-width characters are drawn double.
- Some monospace fonts do not have them (JetBrains Mono, for one). The terminal
  then borrows them from another font, which can look uneven; `"glyphs": "safe"`
  uses small squares every monospace font tested has.

## What it does not do

- It is not a provider: no model list, no request rewriting, no
  `X-Pi-Provider` header. Use it with whichever NaN provider you already have.
- No `/nan-usage` command: that name belongs to `@gtrabanco/pi-nan-provider`,
  and both packages work side by side.
- No writes: no settings, no credentials, no session entries other than the
  tables you ask for.
- No history, charts, notifications beyond one warning per failure, or support
  for several NaN accounts at once.
- No Helmcode enterprise tenants (`api.helmcode.com`): only the NaN community
  cluster.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| No segment at all | The active model is not a NaN one. Pick one with `/model`, or set `alwaysShow`. If your provider has an unusual id and no `nan.builders` base URL, set `providerId`. |
| `nan ···` that never goes away | No key. `/login nan` (or your provider's id), or export `NAN_API_KEY`. `/nan-quota` says which provider it looked up. |
| "the API key was rejected" | The key is mistyped, revoked, or from a plan without API access (Community). Check it in cloud.nan.builders → Settings → API Keys. |
| `nan glm5.3 not in your plan` | `glm5.3` needs the GLM 5.3 premium plan. NaN's own pi guide lists it for everyone, so it may be in your `models.json` anyway. |
| `~20%` and "the docs caps" in the table | The quota endpoint failed or is turned off; the numbers are estimates from `/v1/usage` and the dated caps table. |
| `·40m` at the end | The last refresh failed; the bar is the last good reading, 40 minutes old. It retries with backoff. |
| Pills look uneven or misaligned | Your font lacks `▰`/`▱`; use `"glyphs": "safe"`. |

## Development

```bash
npm ci
npm run check   # tsc --noEmit, strict
npm test        # unit, wiring and real-pi smoke suites; no network
```

- `test/run.mjs` — the pure pieces against payloads captured verbatim from the
  three endpoints (`test/fixtures/`): validation, plan filtering, provider
  detection, bar geometry, footer shapes, cache policy, command text.
- `test/wiring.mjs` — the extension driven through a stand-in `ExtensionAPI` with
  `fetch` stubbed: events, the provider gate, request counts, failure paths, the
  privacy switch.
- `test/smoke.mjs` — the package loaded by a real pi through its SDK. CI runs it
  against pi 1.3.0 and the latest pi.

## License

[GPL-3.0-or-later](LICENSE). Copyright © 2026 Adrián Rodríguez Mesa.
