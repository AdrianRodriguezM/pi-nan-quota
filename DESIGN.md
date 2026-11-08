# pi-nan-quota — design notes

For contributors. What the extension does is in the [README](README.md); this
file records *why* it is built the way it is, so the decisions are not undone by
accident.

## Data: the server decides

Three NaN endpoints, read in parallel on each refresh:

| Endpoint | Documented | Gives | Used for |
|---|---|---|---|
| `cloud-api.nan.builders/api/usage/quota` | no | per-model `cap`, `tokensUsed`, `remaining`, `periodEnd`, `extraTokens`, `extraUsable`, `extraExpiresAt`, `windowHours`, `fullWindowTokens` | caps and reset (primary) |
| `api.nan.builders/v1/usage` | yes | consumption per model for a window, all-time totals | uncapped models, totals, fallback |
| `api.nan.builders/v1/models` | yes | ids the key can call, **filtered by plan** | deciding which rows are shown |

Verified facts that shaped the design (captured payloads in `test/fixtures/`):

- The quota endpoint reports rows the key cannot use: `glm5.3` (premium) on a
  member key, and `glm5.2` (retired) for everyone.
- `/v1/models` omits both on a member key and lists new models (`minimax-h3`)
  before any documentation does.
- Uncapped models (`qwen3.6`, `gemma4`) have no quota row at all.
- The window of `glm5.3` comes with its size, never its consumption.
- The extra pool reports what is left, never its original size.

Hence: **keep every quota row with valid counters, then intersect with
`/v1/models`** (`filterServed`). No list of plans, premium models or retired
models lives in the code. Both checks fail open — no served list, or an empty
intersection, keeps the payload — because a wrong "hidden" is worse than a stale
row.

The caps table in `src/caps.ts` exists only for the fallback (quota endpoint off
or failing). Everything derived from it is marked `~` and the table's date is
printed.

## Requests

- Nothing is requested while the active model is not NaN's (unless
  `alwaysShow`). Detection: provider id equals `providerId`, or the model's
  `baseUrl` host is `nan.builders` or a subdomain of it.
- The key is the detected provider's stored credential, then `NAN_API_KEY`. It
  goes only into the `Authorization` header of the three requests above; it is
  never logged, formatted into a message, or put in an error.
- One request in flight at a time, success TTL `refreshSeconds` (≥ 30 s),
  `Retry-After` on 429, exponential backoff 30 s → 15 min, the last good snapshot
  kept with its timestamp. `/v1/models` is cached for an hour.

## Rendering

- **One `setStatus` key**, never `setFooter`: users already run custom footers
  that render `getExtensionStatuses()`; a second footer would fight them.
- **The bar** — settled with the owner after several rejected attempts; do not
  change it without asking:
  - ten `▰` / `▱` pills, the shape that was chosen over blocks;
  - **one colour for both halves**, the brand violet `#7D39EB` (256-colour
    `99`). A darker violet for the unused half reads as black on dark terminals
    and was reported as "the bar disappears";
  - **no gap** between used and unused pills: a blank cell there reads as a
    missing pill;
  - **a uniform scale, driven by the printed percentage**: 0 pills only at 0 %,
    10 only at 100 %, and `ceil(percent × 9 / 99)` in between, so each of the
    nine intermediate states covers exactly eleven points (1–11, 12–22, …,
    89–99) and 45–55 % is the half bar. Eight pills with `ceil` on the raw ratio
    shipped in 0.1.0 and drew five of eight next to a printed `50%`; eight pills
    cannot split 1–99 % evenly at all (14.1 points each), which is why the bar
    moved to ten. A test walks all 101 percentages;
  - fixed width (10 columns, percentage padded to 4) so the footer never jumps.
- Theme `warning` / `error` take over the used pills from `warnAt` / `criticalAt`:
  a quota about to run out should look like a warning, not like branding.
- `▰`/`▱` are East Asian Width neutral (one column everywhere). Fonts without them
  get `"glyphs": "safe"` (`▪`/`▫`).
- `/nan-quota` writes a custom entry (`appendEntry` + `registerEntryRenderer`):
  pi keeps custom entries out of the model's context, which the smoke test checks
  against a real pi.

## Tests

- `test/run.mjs` — pure functions against the fixtures.
- `test/wiring.mjs` — the extension through a stand-in `ExtensionAPI`, with
  `fetch` stubbed.
- `test/smoke.mjs` — the package loaded by a real pi through its SDK. CI runs it
  at pi 1.3.0 (the peer floor) and latest; this is what keeps the stand-in
  honest.

No suite touches the network. To refresh the fixtures, capture the three
endpoints with a real key and check that no credential ends up in the files.
