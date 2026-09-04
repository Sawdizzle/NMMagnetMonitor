# Incident note — NM1004 found with an empty magnet (2026-09-04)

**Status:** Open · unit down awaiting parts · **Severity:** Equipment loss (no monitoring failure)
**Asset:** NM1004 — Numed DSC, Denton TX
**Author:** Prepared with Claude Code · **Date:** 2026-09-04

---

## Summary

Field staff reported that **NM1004 quenched**. The stored telemetry agrees: the magnet has
**0.7 % helium**, a vessel pressure of **5.4 bar**, a coldhead sitting at **10 K**, and the device
raising **EC 2 "He level too low"** and **EC 25 "Vessel pressure too high"**. The cryocooler and the
cooling loop are still running normally — there is simply nothing left to condense.

This is **not** a monitoring failure, and it is important to be precise about why: **the quench
happened before this tool ever saw the unit.** NM1004 was added on 2026-08-06, and the highest
helium level in the entire retained history — 23 days of daily rollups — is **0.74 %**. We have
never observed this magnet with helium in it. The alerting did fire, correctly and for thirteen
days, on the state it inherited.

The unit is currently dark for an unrelated reason: its iR305 was removed on 2026-09-03 to bring
NM1019 online at Lavaca, and a replacement is on order. It is in **maintenance** as of 2026-09-04
21:52 UTC to stop it paging for a fault that is known and awaiting parts.

## What the data shows

Last reading before the unit went dark, 2026-09-03 18:27 UTC:

| Channel | Value | Reading |
|---|---|---|
| Helium level | **0.72 %** | Empty |
| Vessel pressure | **5.43 bar** | Fleet rule alarms above 3.0 |
| Coldhead | **10.0 K** | Nominal is below 6 K |
| Recondenser | 4.403 K | Pinned — same value for days, not jittering |
| Shield | 38.722 | Pinned — repeated flatline alerts |
| Water flow / temp | 2.11 gpm / 62.8 °F | Normal |
| Compressor (cs1) | 0 | Running |
| Device error codes | **EC 2**, **EC 25** | "He level too low", "Vessel pressure too high" |

Across all 23 days of rollups, helium never moves outside **0.66 – 0.74 %**, and the coldhead never
outside **9.87 – 10.25 K**.

## Timeline (UTC)

| Date | Event |
|---|---|
| 2026-08-06 | NM1004 added to the dashboard |
| 2026-08-12 | Earliest daily rollup we hold. Helium already 0.70 % — **the quench is before this line** |
| 2026-08-17 | Only 15 samples stored, against ~257 on every other day. Something interrupted reporting that day; worth confirming against site records |
| 2026-08-18 11:33 | First `he_lvl < 50 (now 0.68)` and `he_press > 3.0` — both auto-resolved a minute later when the unit briefly went stale |
| 2026-08-21 01:34 | Both threshold alarms re-raised. **They stay open for 13 days** |
| 2026-08-21 01:35 | `bound` — coldhead 10.04 K against a below-6 K nominal. Stays open 14 days |
| 2026-08-21 02:05 | EC 91 — magnet monitor internal temp too hot |
| 2026-08-24, 08-31 | EC 25 — vessel pressure too high, twice |
| 2026-08-21 → 09-01 | Seven `flatline` alerts on the shield channel (38.7 – 39.1, exact repeats) |
| 2026-09-03 18:27 | Last telemetry. iR305 removed for the NM1019 build |
| 2026-09-03 18:58 | **Helium and pressure alarms auto-resolve — because the unit went stale, not because anything improved** |
| 2026-09-04 21:52 | Maintenance enabled; remaining open events closed |

## What we can and cannot say

**Can:** the magnet is empty, has been for at least the whole retained window, and the device itself
is reporting the two error codes that describe exactly that state.

**Cannot:** when it happened, or how fast. Raw samples are purged on a 7-day rolling window and the
daily rollups begin 2026-08-12, by which point it was already empty. There is no boil-off curve to
read and no quench event captured. The 08-17 sample gap is the only hint in our data and it is not
evidence on its own.

## Signature — how to recognise this on another unit

A magnet that has lost its helium, as distinct from a sensor or parser fault:

- **Helium below ~1 %, and still jittering** (0.68 / 0.70 / 0.72). A live sensor reading an empty
  vessel moves a little. A dead sensor repeats one value **exactly**, which is what the shield
  channel does here (38.722, over and over) — that is a flatline, not a measurement.
- **Vessel pressure high** — 5 bar and above, where a healthy unit sits near 1.
- **Coldhead warm but not room temperature** — ~10 K says the cryocooler is running with nothing to
  condense. A powered-down magnet reads 300 K+ across coldhead, recondenser and shield together.
- **EC 25 "Vessel pressure too high"** — this one is distinctive. Only two units in the fleet raise
  a pressure code at all.
- **EC 2 "He level too low" is NOT diagnostic on its own.** Checked across the fleet on 2026-09-04,
  six units carry EC 2 while perfectly healthy — NM1008 at 62.7 %, NM1029 at 64.2 %, NM1006 at
  64.7 %. The device's own low-level threshold sits somewhere around 65 %, far above the point of
  danger, so EC 2 corroborates a low reading and proves nothing by itself.
- **Water and compressor normal.** This is what separates "the magnet is gone" from "the site lost
  power" or "the chiller failed" — everything else is still working.

Cross-check before concluding, per the troubleshooting runbook: compare the HTTP scrape against the
FTP `.dat`, since they use different parsers. If both agree to the decimal, the numbers are real.

## Also found while calibrating against the fleet

Comparing every unit's cryogenics to build the state scale (below) surfaced two that deserve a look
on their own account:

- **NM1028 — coldhead 8.97 K while its recondenser reads 4.16 K.** Every healthy unit in the fleet
  runs both between 3.96 and 4.32 K. That divergence is the same shape NM1004 shows (10.04 K against
  4.40 K) and it is what precedes boil-off: the cryocooler is losing the coldhead while the
  recondenser is still cold. Helium is fine today at 76.4 %.
- **NM1037 — helium 35.4 %**, the lowest in the fleet after the two known-down units, and below the
  50 % fleet alarm line. Not urgent, though, and it is worth recording why: it has been 35.34-35.36 %
  every day for 21 days. It is not losing anything — it needs a fill scheduled, not a response.
- **Three units read "compressor powered off or cable disconnected"** — NM1001, NM1031 and NM1037 —
  while their coldheads sit at 3.89-4.14 K. A compressor genuinely stopped for weeks cannot leave a
  coldhead at 4 K, and NM1001's device says so itself with EC 125, "No 24v supply from compressor 1".
  These are sense-line faults. The alert now says so (see below).
- **NM1031 is the one that is actually losing helium**: 70.67 % to 61.11 % in eight days, about
  1.2 %/day, with its coldhead at 3.89 K and vessel pressure high (EC 25). A cold coldhead means the
  cryocooler is working, so this is venting or a leak, not boil-off — a valve or a seal, not a
  cryocooler. Worth noting against the fleet's baseline: every healthy magnet here moved less than
  0.1 % in 21 days, so this unit is losing helium roughly a hundred times faster than its neighbours.

## What this changes

1. **A critical alarm can stay open for thirteen days and nothing escalates.** The helium alarm was
   correct, continuous, and ignored — it sat in the queue alongside everything else. Nothing in the
   system treats "open for two weeks" differently from "opened this morning". Alert ageing or
   escalation is the single highest-value change this incident argues for.

2. **"Resolved" does not mean "fixed" when a unit goes stale.** `evaluate_alerts` deliberately
   resolves threshold events on a unit whose data has gone stale — holding a value alarm against a
   reading that may be hours old asserts something we no longer know. That is right, but the event
   closes looking identical to one that recovered. NM1004's thirteen-day helium alarm now reads
   "resolved 09-03 18:58", which is the opposite of what happened. These closures should be marked
   distinctly, so a magnet that was empty when it went dark does not read as one that got better.

3. **Retention is shorter than the investigation window.** Seven days of raw samples is the right
   call for storage, but it means an event discovered a fortnight later has no evidence behind it.
   Daily rollups are cheap and already exist — keeping them for a year, and capturing the triggering
   reading into the alert event itself, would have given this note a boil-off curve instead of a
   sentence saying we cannot know.

4. **A unit can be onboarded already broken, and nothing says so.** NM1004 has never once reported a
   healthy helium level. A "we have never seen this channel in a nominal state" flag at onboarding
   would have made its condition unmissable on day one instead of arriving as a threshold alarm two
   weeks later.

## Changed as a result (2026-09-04)

Both of these were detection that already worked and wording that did not say what was found:

- The **cs1 alarm** now appends what the coldhead implies — "the magnet is still cold (coldhead
  4.14 K), so this reads as a lost 24 V sense line rather than a stopped compressor — check the
  cable before the compressor", or, on a genuinely warm unit, "consistent with a compressor that
  really has stopped".
- The **helium trend finding** does the same for the other direction: "the coldhead is at 3.89 K, so
  the cryocooler is running — this reads as venting or a leak rather than boil-off".

Both come from one helper, `cryo_coldhead_clause`, which returns nothing at all when there is no
coldhead reading rather than guessing at a mechanism.

## Follow-ups

- [ ] Confirm the quench date against site records; 2026-08-17 is the only candidate our data offers
- [ ] Decide the disposition of the magnet (refill and ramp, or retire) before the replacement iR305 lands
- [ ] Take NM1004 **out** of maintenance deliberately once it reports again — if it is still empty the
      alarms should be seen, not suppressed
- [ ] Alert ageing/escalation for long-open critical events
- [ ] Distinguish "resolved because stale" from "resolved because recovered"
- [ ] Extend daily-rollup retention, and snapshot the triggering reading into `alert_events.detail`
