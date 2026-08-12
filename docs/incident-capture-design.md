# Incident capture — design

**Status:** design only — no migrations applied. Lands with the alerting/DB
session (it shares the cron + evaluator machinery), with explicit go-ahead.

## Why it can't be client-side

Telemetry is purged on a 7-day rolling window, and a quench or compressor trip
is exactly the event you'll want to look back on months later. Capture has to
run continuously on the server — a browser tab that happens to be open is not a
system of record. So this is a table + a detector on `pg_cron`, evaluated right
after `evaluate_alerts()`.

## The `incidents` table (immune to the telemetry purge)

```sql
create table if not exists public.incidents (
  id            bigint generated always as identity primary key,
  asset_id      uuid not null references public.assets(id) on delete cascade,
  kind          text not null,   -- 'quench' | 'compressor_off' | 'offline' | 'helium_low'
  severity      text not null default 'critical' check (severity in ('critical','warning')),
  started_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  peak_detail   text,            -- e.g. 'coldhead 41 K, He -6%/h'
  -- A frozen high-resolution window around the event, copied out of
  -- telemetry_samples so it survives the 7-day cleanup. jsonb array of readings.
  snapshot      jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists idx_incidents_asset_started
  on public.incidents (asset_id, started_at desc);
```

The `snapshot` is the key idea: when an incident opens, copy the surrounding
readings (say −30 min … +2 h at full resolution) into `snapshot` so the incident
page can render the event long after the raw rows are gone. The rolling purge
(`cleanup_old_telemetry`) is left untouched; incidents are a separate, permanent
store.

## Detection (runs on cron, idempotent like `evaluate_alerts`)

One `detect_incidents()` function, opening an incident when a signature starts
and stamping `resolved_at` when it clears — same open/resolve discipline as the
alert evaluator, so nothing double-fires.

- **Quench** — the signature, not any single value: coldhead rising fast **and**
  helium dropping fast within a short window (e.g. coldhead slope > +X K/min and
  he_lvl slope < −Y %/h), optionally corroborated by a pressure swing. This is
  the one worth a frozen snapshot.
- **Compressor off** — `cs1 > 0` sustained past a debounce (a single blip
  shouldn't open an incident).
- **Offline** — a reporting gap beyond the asset's `offline_threshold_minutes`,
  mirroring the offline alert but recorded as a durable incident with duration.
- **Helium low** — crosses the critical floor; complements the boil-off forecast
  (the forecast warns *ahead*, the incident records the *event*).

Maintenance-flagged units are exempt (same rule the TV uses today).

## Snapshot capture

On open, `detect_incidents()` selects the window around `started_at` from
`telemetry_samples` and writes it to `incidents.snapshot`. Because detection runs
every minute and telemetry is retained 7 days, the pre-event minutes are always
still present when the incident opens. A follow-up pass can extend the snapshot
with post-event readings until the incident resolves.

## UI

- **Incident timeline page** (`/incidents` and a per-asset section): list of
  past incidents with kind, duration, peak detail, and a chart rendered from the
  frozen `snapshot` — the "what happened at 3 a.m." view.
- **Asset page**: an "Incidents" strip under the forecast card.
- **TV / handoff**: the shift-summary overlay gains "incidents since shift start"
  once this exists — the persisted history the v1 snapshot can't provide yet.

## Rollout (with the alerting session)

1. `create table incidents` (+ index). Inert on its own.
2. `detect_incidents()` — dry-run by hand, inspect rows, tune slopes/debounce
   against real fleet data before scheduling.
3. Schedule on `pg_cron` right after `evaluate_alerts()`.
4. Build the timeline UI last — the capture works headless before any screen.

## Open questions for tuning

- Quench slope thresholds (X K/min, Y %/h) — set against real event data; the
  service team has seen more quenches than the dataset has.
- Snapshot window size vs. row storage (free-tier budget).
- Whether `helium_low` incidents are worth recording separately from the alert,
  or are better left to the forecast + alert pair.
