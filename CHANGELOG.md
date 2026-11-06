# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). While the major version is 0, the
quota endpoint it reads is undocumented, and a minor release may change
behaviour to follow NaN.

## [0.1.0] - 2026-11-07

First release.

### Added

- Footer segment for the active NaN model: an eight-pill bar in NaN's violet, the
  percentage of the monthly cap, the time to reset, and alerts for other models
  over `warnAt`.
- `/nan-quota` command with the per-model table, extra pools, the rolling window
  of the premium model, uncapped usage, and month and all-time totals. Output is
  a custom entry and never enters the model's context.
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

[0.1.0]: https://github.com/AdrianRodriguezM/pi-nan-quota/releases/tag/v0.1.0
