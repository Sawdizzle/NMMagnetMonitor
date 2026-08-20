/**
 * Reading back the value that nullify_sentinel() threw away.
 *
 * The MagMon has no concept of a blank channel: an analog input with no sensor
 * on it still prints a number every minute, and on this fleet that number is a
 * fixed constant (5.024 gal/min, 100.476 °F — or the same reading in the .dat
 * file's metric units, 19.017 L/min and 38.042 °C). nullify_sentinel() in
 * supabase/schema.sql stores NULL for those so a dead channel can't trip a
 * threshold rule, and evaluate_alerts() opens a sensor_fault instead.
 *
 * That is the right thing to store and the wrong thing to SHOW. Anyone
 * comparing the app against the MagMon's own web interface sees a number there
 * and an em-dash here, with nothing on the page explaining the gap — which
 * reads as the app losing data rather than refusing to believe it. The raw
 * device row is kept verbatim in telemetry_samples.data, so we can put the
 * number back on screen and label it for what it is.
 *
 * The constants and the 0.002 tolerance MUST stay in step with
 * nullify_sentinel(); a value the database blanks but this file doesn't
 * recognize renders as a bare em-dash again.
 */

export type SentinelField = "h2o_flow" | "h2o_temp";

// Every spelling of the placeholder, per channel: the HTTP reading and the
// .dat file's metric twin. Both reach the database, so both must be matched.
const SENTINELS: Record<SentinelField, number[]> = {
  h2o_flow: [5.0238, 19.017],
  h2o_temp: [100.4756, 38.042],
};

const TOLERANCE = 0.002;

// Where each channel's untouched device reading lives inside telemetry_samples.data.
// The gateway writes the parsed device column (H20_Flow — the zero is the
// device's own spelling, not a typo) and report_telemetry_batch also carries a
// lowercase copy, so accept either.
const RAW_KEYS: Record<SentinelField, string[]> = {
  h2o_flow: ["H20_Flow", "h2o_flow"],
  h2o_temp: ["H2O_Temp", "h2o_temp"],
};

function isSentinel(field: SentinelField, value: number): boolean {
  return SENTINELS[field].some((s) => Math.abs(value - s) < TOLERANCE);
}

/**
 * The placeholder a channel is stuck on, or null.
 *
 * Returns a value ONLY when the stored column is blank *because* the device
 * sent the placeholder. A channel that is blank for any other reason (no raw
 * row kept, a gateway that never reported the field) stays null and renders as
 * an ordinary em-dash — claiming a placeholder we didn't actually see would be
 * its own kind of lie.
 */
export function suppressedReading(
  field: SentinelField,
  stored: number | null | undefined,
  data: Record<string, unknown> | null | undefined
): number | null {
  if (stored !== null && stored !== undefined) return null;
  if (!data) return null;

  for (const key of RAW_KEYS[field]) {
    const raw = data[key];
    const value = typeof raw === "string" ? Number(raw) : raw;
    if (typeof value === "number" && Number.isFinite(value) && isSentinel(field, value)) {
      return value;
    }
  }
  return null;
}

/**
 * Three decimals, because that is what the MagMon itself prints: 5.024,
 * 100.476, 19.017, 38.042. The whole point of showing this number is that it
 * can be matched against the device's own web interface, so it has to be the
 * device's spelling — the stored value may be a float-repr twin of it
 * (5.023759919694909) after the .dat unit conversion, and printing THAT would
 * leave the two screens disagreeing all over again.
 */
export function formatSuppressed(value: number): string {
  return String(Number(value.toFixed(3)));
}

export const SENTINEL_SHORT = "fixed placeholder";

export function sentinelExplanation(value: number): string {
  return (
    `The MagMon is reporting a constant ${formatSuppressed(value)} on this input, and has ` +
    `read exactly that on every sample. That is what an input with no working sensor on it ` +
    `looks like: the device always prints a number, so this is a placeholder rather than a ` +
    `measurement. It is held out of the charts and alarm rules on purpose.`
  );
}
