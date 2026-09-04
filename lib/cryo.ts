import type { TelemetrySample } from "./supabase";

/**
 * The cryogenic state of a magnet, as one graded level with its reasons.
 *
 * WHAT THIS IS NOT: a quench predictor. Nothing here forecasts an event. It
 * answers the narrower and answerable question — how far is this magnet from
 * the state a healthy one is in, and how urgently does someone need to look?
 * Naming it honestly matters, because a badge that implies prediction gets
 * trusted for something it cannot do.
 *
 * WHY IT EXISTS: NM1004 was found on 2026-09-04 with 0.7 % helium, having sat
 * that way for the whole retained history with a correct threshold alarm open
 * for thirteen days. The information was all present and none of it was
 * legible at a glance — you had to open the unit, read four numbers and know
 * what each should be. See docs/incidents/2026-09-04-nm1004-magnet-empty.md.
 *
 * THE RULE THAT MATTERS MOST: absence is never green. A unit with no cryo
 * reading returns "unknown", never "nominal". A green badge on a magnet nobody
 * can see is worse than no badge at all, and that failure mode is exactly what
 * this was built in response to.
 */

export type CryoLevel = "nominal" | "watch" | "urgent" | "critical" | "unknown";

export type CryoState = {
  level: CryoLevel;
  label: string;
  /** Plain-language findings, worst first. Empty when nominal. */
  reasons: string[];
};

/**
 * The bands, in one place, so tuning them is a single edit.
 *
 * Calibrated against the live fleet on 2026-09-04 rather than invented: the
 * fourteen healthy magnets ran helium 55.7–82.1 % (median ~65), vessel pressure
 * 0.91–2.70 bar (all but two under 1.7), and coldhead AND recondenser both
 * inside 3.96–4.32 K. The urgent lines for helium and pressure are deliberately
 * the fleet's own alert_rules thresholds (he_lvl < 50, he_press > 3.0) so the
 * badge and the alarms cannot tell different stories, and the 6 K coldhead line
 * is the one the existing 'bound' diagnostic already uses.
 */
export const CRYO_BANDS = {
  heliumWatch: 60,
  heliumUrgent: 50,
  heliumCritical: 20,
  pressureWatch: 2.0,
  pressureUrgent: 3.0,
  pressureCritical: 5.0,
  coldheadWatch: 5.0,
  coldheadUrgent: 6.0,
  coldheadCritical: 8.0,
  /**
   * Coldhead minus recondenser. Both sit within a few tenths of each other on
   * every healthy unit, so a gap means the cryocooler is losing the coldhead
   * while the recondenser is still cold — boil-off starting, before the helium
   * level has moved at all. It is the earliest signal available: NM1004 shows
   * 10.04 K against 4.40 K, and NM1028 showed 8.97 K against 4.16 K with a
   * perfectly healthy 76 % helium level.
   */
  divergenceUrgent: 2.0,
  /** Everything at room temperature: a warm or powered-down magnet. */
  warmKelvin: 100,
} as const;

const RANK: Record<CryoLevel, number> = {
  unknown: 0,
  nominal: 1,
  watch: 2,
  urgent: 3,
  critical: 4,
};

export const CRYO_LABELS: Record<CryoLevel, string> = {
  nominal: "Cryogenics nominal",
  watch: "Cryogenics — watch",
  urgent: "Cryogenics — action needed",
  critical: "Cryogenics — critical",
  unknown: "Cryogenics — no data",
};

export const CRYO_COLORS: Record<CryoLevel, string> = {
  nominal: "#4ade80",
  watch: "#fbbf24",
  urgent: "#fb923c",
  critical: "#f0575a",
  // Deliberately grey, not green: see the note at the top of this file.
  unknown: "#6b7280",
};

/**
 * PostgREST serialises numerics as STRINGS, so every reading arrives as text.
 * Kept local rather than imported so this module stays dependency-free and
 * testable on its own — the same reasoning as lib/health.
 */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function worst(a: CryoLevel, b: CryoLevel): CryoLevel {
  return RANK[b] > RANK[a] ? b : a;
}

/** The coldhead and recondenser live in the device payload, not in columns. */
function fromData(row: Record<string, unknown>, key: string): number | null {
  const data = row.data as Record<string, unknown> | null | undefined;
  return data ? num(data[key]) : null;
}

export function cryoState(sample: TelemetrySample | null | undefined): CryoState {
  if (!sample) return { level: "unknown", label: CRYO_LABELS.unknown, reasons: [] };

  const row = sample as unknown as Record<string, unknown>;
  const he = num(row.he_lvl);
  const press = num(row.he_press);
  const shield = num(row.shield);
  const coldhead = fromData(row, "ColdheadRuO");
  const recon = fromData(row, "ReconRuO");

  // No helium level and no coldhead is no cryogenic picture at all. Say so.
  if (he === null && coldhead === null) {
    return { level: "unknown", label: CRYO_LABELS.unknown, reasons: [] };
  }

  let level: CryoLevel = "nominal";
  const reasons: string[] = [];

  // A magnet at room temperature is its own answer — reporting "helium low" for
  // a unit that is simply warm and powered down buries the actual state.
  const warm = [coldhead, recon, shield].filter((v) => v !== null && v >= CRYO_BANDS.warmKelvin);
  if (warm.length >= 2) {
    return {
      level: "critical",
      label: CRYO_LABELS.critical,
      reasons: [
        `Magnet is warm — coldhead ${coldhead?.toFixed(0) ?? "—"} K, shield ${shield?.toFixed(0) ?? "—"} K`,
      ],
    };
  }

  if (he !== null) {
    if (he < CRYO_BANDS.heliumCritical) {
      level = worst(level, "critical");
      reasons.push(`Helium ${he.toFixed(1)} % — the vessel is effectively empty`);
    } else if (he < CRYO_BANDS.heliumUrgent) {
      level = worst(level, "urgent");
      reasons.push(`Helium ${he.toFixed(1)} % — below the ${CRYO_BANDS.heliumUrgent} % fill line`);
    } else if (he < CRYO_BANDS.heliumWatch) {
      level = worst(level, "watch");
      reasons.push(`Helium ${he.toFixed(1)} % — worth scheduling a fill`);
    }
  }

  if (coldhead !== null) {
    if (coldhead >= CRYO_BANDS.coldheadCritical) {
      level = worst(level, "critical");
      reasons.push(`Coldhead ${coldhead.toFixed(1)} K — nominal is about 4 K`);
    } else if (coldhead >= CRYO_BANDS.coldheadUrgent) {
      level = worst(level, "urgent");
      reasons.push(`Coldhead ${coldhead.toFixed(1)} K — nominal is about 4 K`);
    } else if (coldhead >= CRYO_BANDS.coldheadWatch) {
      level = worst(level, "watch");
      reasons.push(`Coldhead ${coldhead.toFixed(1)} K — drifting above the usual 4 K`);
    }

    // The early one: the coldhead pulling away from a recondenser that is still
    // cold means the cryocooler is failing while the helium level still looks fine.
    if (recon !== null && coldhead - recon >= CRYO_BANDS.divergenceUrgent) {
      level = worst(level, "urgent");
      reasons.push(
        `Coldhead ${coldhead.toFixed(1)} K against a recondenser at ${recon.toFixed(1)} K — the cryocooler is losing the coldhead`
      );
    }
  }

  if (press !== null) {
    if (press >= CRYO_BANDS.pressureCritical) {
      level = worst(level, "critical");
      reasons.push(`Vessel pressure ${press.toFixed(2)} — a healthy unit sits near 1`);
    } else if (press >= CRYO_BANDS.pressureUrgent) {
      level = worst(level, "urgent");
      reasons.push(`Vessel pressure ${press.toFixed(2)} — above the ${CRYO_BANDS.pressureUrgent} alarm line`);
    } else if (press >= CRYO_BANDS.pressureWatch) {
      level = worst(level, "watch");
      reasons.push(`Vessel pressure ${press.toFixed(2)} — running high`);
    }
  }

  return { level, label: CRYO_LABELS[level], reasons };
}
