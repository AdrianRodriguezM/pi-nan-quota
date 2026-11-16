# pi-nan-quota — design notes

For contributors. What the extension does is in the [README](README.md); this
file records *why* it is built the way it is, so the decisions are not undone by
accident.

## Data: one documented endpoint (0.3.0)

On 2026-11-09 NaN replaced the per-model allowances with **one shared credit
pool per billing period** (7,000 Inference, 20,000 Premium), drawn at each
model's price per token for input, cached input and output. Verified against
the published OpenAPI (`https://nan.builders/openapi.json`) and a live key on
2026-11-16:

- `GET https://api.nan.builders/v1/usage` reports a **`credits`** object for the
  current billing period, whatever window is asked for: `period_start`,
  `period_end`, `allowance`, `used`, `remaining` (packs excluded),
  `pack_credits`, `pack_expires_at`, `frozen`. It is `null` for accounts not
  billed in credits. NaN says it can lag the live balance by up to a minute.
- Rows (`data[]`, per UTC day and model) and `totals.by_model` carry
  `credits` (one decimal) and `cached_tokens`. Credits are billed from
  **2026-11-10** (`CREDITS_BILLED_SINCE`). Earlier days report 0, so windows are
  clamped to that day and do not dilute rates or effective prices.
- The window may span at most 90 days. `limit` caps rows per page at 500, and
  `next_cursor` paginates the rows, not the totals. The client follows at most
  four pages and stops if a cursor repeats.
- A spent pool answers model requests with `402 insufficient_balance`.
  `frozen: true` means credit-billed requests are refused.
- The dashboard's `cloud-api.nan.builders/api/usage/quota`, which 0.1 read,
  stopped updating on 2026-11-09 and no longer carries the rolling-window
  fields. **It was removed in 0.3.0.** Do not bring it back: everything it served
  is now in `/v1/usage`, documented.
- `/v1/models` is filtered by plan and cached for an hour. It decides which
  models are "available on this key".

For a few days after the change, credits were only readable from the
dashboard. That is no longer true: do not write that they are.

## Window and period

- The window is the billing period's first UTC day through today, clamped to
  `CREDITS_BILLED_SINCE`. Until the period is known (first load, or after
  `period_end` passes) it is the last 30 inclusive days. If a response reveals
  a period whose window differs from the one requested, the loader requests
  once more with the right window, so per-model numbers always describe the
  period the balance describes. That second request happens only on the first
  load and on a rollover.
- Rows are whole UTC days, while periods start mid-day (the Stripe anchor). The
  period's first day can therefore include the previous period's tail. The
  `credits` object is authoritative for the period total, and the table says
  so.

## Pace

`src/pace.ts`, pure:

- The rate is spend over **at most seven UTC calendar days, today included**,
  never before the period start or `CREDITS_BILLED_SINCE`. Recent pace predicts
  the next week better than the period average. Summed rows and elapsed time
  must cover the same span: a test pins the eight-days-over-seven bug, which
  inflated the rate by up to 14 % after midnight.
- When the lookback reaches the period's first, partial day, `credits.used`
  replaces the row sum, and the elapsed time runs from the period start.
- Under 12 hours of elapsed time there is no projection, because one heavy turn
  would swing it wildly. A zero rate never runs out.
- The runway uses `remaining + pack_credits`. The warning shows only when the
  run-out lands before `period_end`.

## Requests

- Nothing is requested while the active model is not NaN's (unless
  `alwaysShow`). Detection: provider id equals `providerId`, or the model's
  `baseUrl` host is `nan.builders` or a subdomain of it.
- The key is the detected provider's stored credential, then `NAN_API_KEY`. It
  goes only into the `Authorization` header. It is never logged, formatted into
  a message, or put in an error.
- One request per refresh (two on a rollover), one in flight at a time,
  success TTL `refreshSeconds` (≥ 30 s), `Retry-After` on 429, exponential
  backoff 30 s → 15 min, and the last good snapshot kept with its timestamp.
  `/v1/usage` allows 30 requests per minute, separate from inference.

## Rendering

- **One `setStatus` key**, never `setFooter`: users already run custom footers
  that render `getExtensionStatuses()`, and a second footer would fight them.
- **The bar.** Its geometry was settled with the owner after several rejected
  attempts. Do not change it without asking:
  - ten `▰` / `▱` pills, the shape chosen over blocks;
  - **one colour for both halves**, the brand violet `#7D39EB` (256-colour
    `99`). A darker violet for the unused half reads as black on dark terminals
    and was reported as "the bar disappears";
  - **no gap** between used and unused pills: a blank cell there reads as a
    missing pill;
  - **a uniform scale, driven by the printed percentage**: empty only at 0,
    full only at 100, `ceil(percent × 9 / 99)` in between. That gives nine
    states of exactly eleven points (1–11, 12–22, …, 89–99), so the bar climbs
    one pill at a time and 45–55 % is the half. A test walks all 101
    percentages.
  - **Meaning since 0.3.0: a fuel gauge** of `remaining / allowance`. It is
    full at the period start. Packs are extra fuel, not tank size, so they
    appear as `+N` next to the number and not in the bar.
- Footer numbers are whole credits, **floored**, so the gauge never reads
  fuller than it is.
- Footer shapes are tried in **priority order**, not width order, within 56
  columns: the run-out warning outranks the reset countdown, because it is the
  part that calls for action. A stale suffix (`·40m`) outranks both, because a
  fresh-looking number from a stale read is the worse lie.
- Priority states: frozen, then spent (`402` seen, or no allowance and no
  packs), then no data, then a model not served to this key, then not billed in
  credits (token view), then normal. The segment does not depend on which NaN
  model is active, except for the "not available" state, because the pool is
  shared.
- The `402` flag clears when a later assistant run succeeds, or when a
  snapshot fetched more than 60 s after the `402` (past the documented lag)
  shows spendable credits.
- `/nan-quota` writes a custom entry (`appendEntry` + `registerEntryRenderer`),
  which pi keeps out of the model's context. The smoke test checks this against
  a real pi. Rows are sorted by credits. **cr/Mtok** (credits per million
  tokens, cache included) is the column that compares models. The session
  line is a balance delta, so it is account-wide by construction, and it says
  so.

## Tests

- `test/run.mjs` tests the pure functions against
  `test/fixtures/usage-credits.json`, a live `/v1/usage` capture, plus
  variants derived from it inside the tests.
- `test/wiring.mjs` drives the extension through a stand-in `ExtensionAPI`,
  with `fetch` stubbed and fake timers for the debounce.
- `test/smoke.mjs` loads the package in a real pi through its SDK. CI runs it
  at pi 1.3.0 (the peer floor) and the latest pi, which keeps the stand-in
  honest.

No suite touches the network. To refresh the fixture, capture `/v1/usage` with
a real key and check that no credential ends up in the file.
