# Enhancements roadmap — Aug 2026

A batch of TV-mode and fleet-intelligence features, sequenced so the low-risk
client-side work ships first and the backend-coupled pieces land with the
alerting/DB session.

## Guiding constraints (why the order is what it is)

- **Retention is 7 days of raw telemetry** (rolling `pg_cron` purge). Enough for a
  boil-off slope, but multi-day fleet history must come from the pre-aggregated
  `asset_telemetry_15min` RPC (≤672 rows/asset over 7d), never raw samples — the
  fleet loader caps at 5000 rows.
- **Coldhead temperature lives in the `data` JSON blob**, which the 15-min RPC does
  not aggregate. So exact multi-day *coldhead* history is the one visual that needs
  a small read-only backend RPC; every other metric is a typed column.
- **Incident capture must run continuously server-side** — a browser tab that
  happens to be open can't be the system of record. It shares the cron + table
  machinery with alerting, so it belongs in that session.

## Sequence

| # | Feature | Surface | Backend? | Status |
|---|---------|---------|----------|--------|
| 1 | Audible chime on new critical | `/tv` | none | ✅ shipped |
| 2 | Helium boil-off forecast engine + asset card | `lib/forecast.ts`, asset page | existing RPC | ✅ shipped |
| 3 | Fleet "days to refill" chips | dashboard + `/tv` | existing RPC | ✅ shipped |
| 4 | 24h trend sparklines | `/tv` | **read-only coldhead RPC** | ⏳ backend session |
| 5 | Shift summary / handoff card | `/tv` | none (v1) | ✅ shipped |
| 6 | Incident capture | new table + cron + UI | **new migrations** | ⏳ backend session |

Features 1, 2, 3, 5 shipped to `main` as self-contained commits. **Decision
(2026-08-11):** #4 is deferred to the backend session and done in full there —
a small read-only `SECURITY DEFINER` RPC aggregates coldhead out of the `data`
blob so all four sparklines become a uniform 24h at once, rather than shipping a
mixed-window interim. #6 is designed now and applied live alongside alerting with
explicit go-ahead.

## Notes per feature

**1 — Audible chime.** Opt-in, off by default; a header toggle persisted to
localStorage. Sounds *once* when an asset newly enters critical — diffs against the
previously-seen critical set, so it never re-chimes on the 30s poll or for units
already red. WebAudio-generated tone (no asset file). Honors browser autoplay
policy by unlocking on the first user gesture / fullscreen.

**2 — Forecast engine.** Pure `heliumForecast(series)`: least-squares fit of
`he_lvl` vs time → rate (%/day), days until it crosses a refill floor, projected
refill date, and a quality flag from R²/span/point-count so we never show a
confident number off three noisy points. Asset page gets a "Helium forecast" card
fed by a 7-day 15-min series. A couple of demo units get a gentle boil-off so the
feature is visible in `/demo`.

**3 — Fleet chips.** The same forecast surfaced fleet-wide as "~N days to refill."
Loaded on a slow cadence (~10 min) separate from the 30s status poll, so ten
extra per-asset RPC calls don't ride every refresh.

**4 — 24h sparklines.** TV sparklines go from 1h to 24h. Deferred to the backend
session so it can be done uniformly: a read-only RPC aggregates coldhead (which
lives in the `data` blob) into 15-min buckets alongside the typed metrics, so all
four card sparklines share one 24h window instead of a mixed-window interim.

**5 — Shift handoff.** A calm periodic panel: who's in alarm, who's offline, lowest
helium, soonest refill, count nominal. v1 is an honest snapshot of current state +
forecasts; once `alert_events`/`incidents` persist, it gains "opened/cleared since
shift start."

**6 — Incident capture.** `incidents` table (immune to the telemetry purge), a
detection function on cron (quench signature: coldhead spike + helium drop +
pressure swing; plus compressor-off and offline transitions), and an incident
timeline page. Applied with the alerting migrations. Full design in
[incident-capture-design.md](incident-capture-design.md).
