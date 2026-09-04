// Which channels an asset carries, and therefore what the UI draws for it.
//
// THE MODEL IS ADDITIVE, NOT A CHOICE BETWEEN TWO KINDS OF UNIT.
//
// The obvious design — MRI assets get the magnet card, PET/CT assets get the
// environmental card — is wrong, and it is worth saying why here because the
// wrong version is the one that keeps suggesting itself. UPS power monitoring
// and zone temperature sensors are being fitted across the whole fleet, so an
// MRI will shortly report helium AND three zones AND mains power from the same
// unit. An either/or card cannot show that; it would have to pick one set of
// channels and silently drop the other, and adding a UPS to an existing magnet
// would mean rewriting the card again.
//
// So a PET/CT trailer is not a different kind of screen. It is an ordinary
// asset that happens not to have a MagMon, and every surface renders the
// sections whose data is actually there:
//
//   MagMon block  <- the modality says this unit has a magnet to watch
//   Zone blocks   <- these zones have readings (or the modality expects them)
//   Power block   <- there are UPS readings (or the modality expects them)
//
// The zone list is presence-driven for the same reason: whether a fitted unit
// gets two zones or three is still undecided, and the answer must not be a code
// change. Whichever zones report are the zones that show.

import type { TelemetryBucket, TelemetrySample } from "./supabase";

export const MODALITY_MRI = "MRI";
export const MODALITY_PETCT = "PET/CT";
export const MODALITY_NUCMED = "NUC MED";

/**
 * The modalities the admin form offers. Order is the order shown.
 *
 * Everything that is not MRI behaves identically today — no MagMon to scrape,
 * zone and power channels only — so this list is about naming the equipment
 * honestly on the card and in the docs, not about branching behaviour. That is
 * deliberate: usesMagmon() is written as "is MRI" precisely so a modality added
 * here (or straight into the database, since the column has no CHECK) is
 * assumed to have no magnet, which is both the safer default and the likelier
 * truth.
 */
export const MODALITIES: { value: string; label: string; hint: string }[] = [
  {
    value: MODALITY_MRI,
    label: "MRI",
    hint: "Has a MagMon to scrape — helium, water, coldhead. Needs the MagMon's local address.",
  },
  {
    value: MODALITY_PETCT,
    label: "PET/CT",
    hint: "No MagMon. Zone temperature/humidity and UPS power only.",
  },
  {
    value: MODALITY_NUCMED,
    label: "Nuc Med",
    hint: "No MagMon — same environmental build as a PET/CT trailer.",
  },
];

/**
 * Does this unit have a MagMon to scrape?
 *
 * The one thing modality genuinely decides, because it is a fact about the
 * equipment rather than about which sensors happen to be fitted: it picks the
 * collector script, decides whether a monitor host is required, and gates the
 * magnet-only parts of the UI (helium forecast, MagMon error codes).
 *
 * Written as "is MRI" rather than "is not PET/CT" so a modality added straight
 * into the database — 'NUC MED' and whatever follows — is assumed NOT to have a
 * magnet, which is both the safer default and the likelier truth.
 */
export function usesMagmon(modality: string | null | undefined): boolean {
  return (modality ?? MODALITY_MRI) === MODALITY_MRI;
}

/**
 * Are environmental channels part of this modality's baseline?
 *
 * The difference between "expected" and "present" is the difference between a
 * fault and an absence. A PET/CT trailer reporting no zone temperatures is
 * broken and must say so; an MRI reporting none has simply not had the sensors
 * fitted yet, and showing it three empty tiles would be noise. Today only
 * non-MRI modalities expect them; when the fleet rollout happens this becomes
 * a per-asset setting rather than a modality one.
 */
export function expectsEnv(modality: string | null | undefined): boolean {
  return !usesMagmon(modality);
}

/** Short badge text, or null for MRI — the default needs no label. */
export function modalityBadge(modality: string | null | undefined): string | null {
  const m = modality ?? MODALITY_MRI;
  return m === MODALITY_MRI ? null : m;
}

// ---- environmental channels ----------------------------------------------

export type EnvZone = {
  key: "s1" | "s2" | "s3";
  zone: number;
  label: string;
  short: string;
};

/**
 * The zone sensors, in bus order.
 *
 * The Modbus unit id IS the zone number and the column prefix — the collector
 * reads unit 1 into s1_temp_f/s1_rh — so this list is the one place that
 * mapping is written down. The names are the PET/CT trailer's; a magnet room
 * will want its own, which is a per-modality label table when that day comes
 * and not a reason to duplicate the list now.
 */
export const ENV_ZONES: EnvZone[] = [
  { key: "s1", zone: 1, label: "Section 1 — Engineering", short: "Engineering" },
  { key: "s2", zone: 2, label: "Section 2 — Tech / Patient", short: "Tech / Patient" },
  { key: "s3", zone: 3, label: "Section 3 — Equipment", short: "Equipment" },
];

export const POWER_KEYS = ["ups_on_battery", "ups_batt_pct", "ups_input_v"] as const;

/**
 * Coerce a telemetry value to a number.
 *
 * PostgREST serialises `numeric` columns as STRINGS ("70.0", not 70.0) to avoid
 * float precision loss, so every reading arrives as text. Comparing one to a
 * threshold, or calling toFixed on it, misbehaves silently without this —
 * lib/faults carries the same helper for the MagMon columns, for the same
 * reason.
 */
export function envNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Anything with telemetry columns on it: a raw sample or a 15-minute bucket. */
export type ChannelRow = TelemetrySample | TelemetryBucket | null | undefined;

function anyValue(rows: readonly ChannelRow[], keys: readonly string[]): boolean {
  for (const row of rows) {
    if (!row) continue;
    const r = row as unknown as Record<string, unknown>;
    for (const k of keys) if (envNum(r[k]) !== null) return true;
  }
  return false;
}

/**
 * The zones this asset actually reports, across the rows given.
 *
 * Deliberately looks at the whole window rather than only the newest reading:
 * a sensor that dropped off the bus twenty minutes ago should keep its tile and
 * show a blank — which reads as "this stopped answering" — instead of quietly
 * vanishing from the card, which reads as though it was never there.
 */
export function zonesWithData(rows: readonly ChannelRow[]): EnvZone[] {
  return ENV_ZONES.filter((z) => anyValue(rows, [`${z.key}_temp_f`, `${z.key}_rh`]));
}

/**
 * Which zone tiles to draw: every zone the modality expects, or — for a unit
 * where these sensors are an addition rather than the baseline — only the ones
 * actually wired up. Two zones or three is a wiring decision, not a code one.
 */
export function zonesToShow(
  modality: string | null | undefined,
  rows: readonly ChannelRow[]
): EnvZone[] {
  return expectsEnv(modality) ? ENV_ZONES : zonesWithData(rows);
}

/** Whether to draw the power section at all. */
export function showsPower(
  modality: string | null | undefined,
  rows: readonly ChannelRow[]
): boolean {
  return expectsEnv(modality) || anyValue(rows, POWER_KEYS);
}

/**
 * The zone trend charts, ordered ALL TEMPERATURES first and then all humidity.
 *
 * THE ORDER IS THE LAYOUT, which is why it lives here with a test rather than
 * inline in the component. Dropped into a grid whose column count equals the
 * number of zones, this puts every zone's temperature across the top row and
 * each zone's humidity directly beneath it — two families as rows, zones as
 * columns. Building the list the obvious way instead (temp, humidity, temp,
 * humidity, … per zone) wraps into a diagonal scatter as soon as the column
 * count and the zone count disagree, which is exactly what it looked like
 * before this existed.
 */
export function envChartSpecs(zones: EnvZone[]): EnvChannelSpec[] {
  return [
    ...zones.map((z) => ({
      key: `${z.key}_temp_f` as const,
      label: `${z.short} — temp`,
      short: z.short,
      unit: "°F",
      color: "#fbbf24",
      isTemp: true,
      zone: z,
    })),
    ...zones.map((z) => ({
      key: `${z.key}_rh` as const,
      label: `${z.short} — humidity`,
      short: z.short,
      unit: "%RH",
      color: "#22d3ee",
      isTemp: false,
      zone: z,
    })),
  ];
}

export type EnvChannelSpec = {
  key: keyof Omit<TelemetryBucket, "created_at" | "sample_count">;
  /** Full form, for a chart heading: "Engineering — temp". */
  label: string;
  /**
   * Compact form for a card tile, which is a third of a card wide.
   *
   * Just the zone name, deliberately WITHOUT the measure. The tiles are laid
   * out with every temperature on one row and every humidity on the next, and
   * the unit sits in the value directly beneath, so the measure is already
   * unmistakable — while the zone is the thing that varies across a row and has
   * to stay readable. Folding "temp"/"RH" in here would push "Tech / Patient"
   * into an ellipsis and make the two rows look identical.
   */
  short: string;
  unit: string;
  color: string;
  /** Temperature charts carry the outside-air trace; humidity ones do not. */
  isTemp: boolean;
  /** The zone this channel belongs to, for tooltips and column grouping. */
  zone: EnvZone;
};

/**
 * Does this asset have anything to show in an environmental section at all?
 *
 * Zones OR power — either is enough to earn the section. Used both by the card
 * (which renders whichever blocks apply) and by the fleet table, where it
 * decides whether the asset appears under the environmental heading. A magnet
 * fitted with only a UPS and no sensors still belongs there.
 */
export function hasEnvSection(
  modality: string | null | undefined,
  rows: readonly ChannelRow[]
): boolean {
  return zonesToShow(modality, rows).length > 0 || showsPower(modality, rows);
}

// ---- mains power ---------------------------------------------------------

export type PowerState = "wall" | "battery" | "unknown";

/**
 * Wall power, battery, or genuinely unknown.
 *
 * "unknown" is a real third state and NOT a polite word for fine: a null
 * ups_on_battery means the NUT link to the UPS is not answering, so the one
 * condition this hardware exists to catch is exactly what cannot be seen. It
 * reads grey and says so, rather than reading green.
 */
export function powerState(onBattery: unknown): PowerState {
  const n = envNum(onBattery);
  if (n === null) return "unknown";
  return n > 0 ? "battery" : "wall";
}

export const POWER_LABELS: Record<PowerState, string> = {
  wall: "Wall power",
  battery: "ON BATTERY",
  unknown: "Power unknown",
};

/**
 * Compact forms for a fixed-width table column and a wall display, where the
 * full labels do not fit. "OUTAGE" rather than "ON BATTERY" because the column
 * is about 56px on a phone and the outage is the point, not the mechanism.
 */
export const POWER_SHORT: Record<PowerState, string> = {
  wall: "Wall",
  battery: "OUTAGE",
  unknown: "—",
};

export const POWER_COLORS: Record<PowerState, string> = {
  wall: "#4ade80", // --status-online
  battery: "#f0575a", // --status-offline
  unknown: "#6b7280",
};
