# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). While the major version is 0, a
minor release may change behaviour to follow changes in NaN's billing.

## [0.3.0] - 2026-11-17

On 2026-11-09 NaN replaced the per-model monthly allowances with one shared
pool of credits per billing period (7,000 on Inference, 20,000 on Premium),
drawn at each model's price per token. Its documented `GET /v1/usage` reports
that balance and the credits billed per day and per model, so the extension
now tracks the pool instead of per-model caps that no longer exist.

### Changed

- **Breaking:** the footer is a gauge of the shared pool: credits left, packs,
  a run-out warning and the countdown to the billing reset
  (`nan ▰▰▰▰▰▱▱▱▱▱ 3632 cr · ⚠ empty in ~7d · resets 15d18h`). The bar is
  `remaining / allowance`, full at the start of the period. It is the same
  whichever NaN model is active, because every model draws from the same pool.
- **Breaking:** `/nan-quota` is credits-first: the balance, packs and their
  expiry, the pace, the change since the pi session started, and a per-model
  table with credits, share, effective credits per million tokens (cache
  included), cache hit rate, tokens and requests, sorted by credits, plus the
  last seven days.
- The reset is the end of the billing period as NaN reports it (your Stripe
  anchor), not the end of the calendar month, and the per-model numbers cover
  that same period.
- Every request goes to the documented `api.nan.builders`: one `/v1/usage`
  read per refresh (two when a new billing period starts) and `/v1/models` at
  most hourly.
- Footer shapes degrade by priority: the run-out warning outlives the reset
  countdown on narrow footers. The segment is up to 56 columns wide.
- Models NaN added (`kimi-k3.1-pro`, `qwen3.8-max`, `deepseek-v4-pro`, `hy4`)
  work out of the box: what a key can call always comes from `/v1/models`.

### Added

- Run-out warning (`⚠ empty in ~7d`): spend over the last seven UTC days
  projects when the pool and the packs run dry, and the footer warns only when
  that is before the reset.
- `402 insufficient_balance` detection: when a run ends on a spent pool, the
  footer shows `nan ⛔ credits spent` until a later run succeeds or a fresh
  balance (read more than 60 s after the error) shows spendable credits. The
  same state appears when the balance itself reaches zero.
- States for an inactive subscription (`nan ⏸ subscription inactive`) and for
  accounts not billed in credits (token view).
- Pagination of the usage rows (`next_cursor`, at most four pages, guarded
  against cursor loops).

### Removed

- Per-model percentages, caps and the `~` estimates from a caps table: NaN no
  longer has per-model allowances.
- The dashboard's undocumented `cloud-api.nan.builders/api/usage/quota`
  endpoint, which stopped updating on 2026-11-09, and with it the rolling-window
  line and the `quotaEndpoint` setting.
- The `warnAt`, `criticalAt` and `maxAlerts` settings, which thresholded the
  per-model allowances.

Removed settings are ignored if present in `~/.pi/agent/nan-quota.json`.

## [0.1.1] - 2026-11-08

### Fixed

- The bar could disagree with the percentage printed next to it: a raw 50.04 %
  printed as `50%` drew five pills of eight, because the bar rounded the raw
  ratio up while the number rounded to the nearest. The bar is now drawn from
  the printed percentage.

### Changed

- The bar has ten pills on a uniform scale. Empty only at 0 %, full only at
  100 %, and each of the nine steps in between covers exactly eleven points
  (1–11 %, 12–22 %, …, 89–99 %), so it climbs one pill at a time and 45–55 % is
  exactly half. Eight pills could not split the range evenly. The segment is
  two columns wider.

## [0.1.0] - 2026-11-07

First release.

### Added

- Footer segment for the active NaN model: a pill bar in NaN's violet, the
  percentage of the monthly cap, the time to reset, and alerts for other models
  over `warnAt`.
- `/nan-quota` command with the per-model table, extra pools, the rolling window
  of the premium model, uncapped usage, and month and all-time totals. Output is
  a custom entry and never enters the model's context; its bars are painted in
  the same violet when drawn.
- Plan awareness without a hard-coded plan list: quota rows are intersected with
  the documented `GET /v1/models`, which NaN filters by plan. Premium models on a
  member key read `not in your plan`; retired models are hidden; new models work
  the day NaN serves them.
- NaN provider detection by base URL (`*.nan.builders`), so any provider id works;
  `providerId` remains as an override.
- Documented fallback (`/v1/usage` plus a dated caps table, marked `~`) when the
  quota endpoint fails, and a `quotaEndpoint: false` switch to use only the
  documented API.
- Caching (configurable TTL, 30 s minimum), single-flight requests, `Retry-After`
  on 429, exponential backoff, and the last good reading with an age suffix.
- `"glyphs": "safe"` / `PI_NAN_QUOTA_GLYPHS=safe` for fonts without `▰`/`▱`.
- Compatibility: pi ≥ 1.3.0, checked in CI by loading the package through a real
  pi at the oldest supported and the latest version.

[0.3.0]: https://github.com/AdrianRodriguezM/pi-nan-quota/compare/v0.1.1...v0.3.0
[0.1.1]: https://github.com/AdrianRodriguezM/pi-nan-quota/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/AdrianRodriguezM/pi-nan-quota/releases/tag/v0.1.0
