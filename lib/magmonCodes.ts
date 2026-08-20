/**
 * The MagMon's own code tables, for rendering.
 *
 * Mirrors the SQL functions magmon_error_text() and
 * magmon_compressor_status_text() in supabase/schema.sql. Two copies exist
 * because the two callers cannot share one: findings are composed server-side
 * inside evaluate_diagnostics (SQL), while the asset page decodes the RAW
 * EC1-EC4 columns out of telemetry_samples.data in the browser, where no
 * round-trip is wanted. Keep them in step — the SQL side is the source of
 * truth, and both were transcribed from the device's own help pages
 * (http://<device>/errors_help.html and /minlog_help.html).
 *
 * EC1-EC4 are NOT four fixed registers. The device documents them as "the four
 * worst error codes active during this minute", severity-ranked and zero-padded,
 * so the slot a code occupies depends on how many OTHER codes are active. Read
 * them as a SET — which is what activeErrorCodes() returns.
 */

// Verbatim from the device, including its own apparent typo at 51/52 (both read
// "(2A)"; 52 is presumably 2B). Left as published so what we print matches what
// the engineer standing at the device reads on its screen.
const ERROR_TEXT: Record<number, string> = {
  0: "No error",
  1: "He level too high",
  2: "He level too low",
  3: "He level top too high",
  4: "He level top too low",
  5: "Water flow for compressor 1 too low",
  6: "Water flow for compressor 1 too high",
  7: "Water temp for compressor 1 too cold",
  8: "Water temp for compressor 1 too hot",
  9: "Water flow for compressor 2 too low",
  10: "Water flow for compressor 2 too high",
  11: "Water temp for compressor 2 too cold",
  12: "Water temp for compressor 2 too hot",
  13: "Shield temp too cold",
  14: "Shield temp too hot",
  15: "Recondensor RuO temp too low",
  16: "Recondensor RuO temp too high",
  17: "Recondensor Si410 temp too low",
  18: "Recondensor Si410 temp too high",
  19: "Recondensor Si410 (2A) temp too low",
  20: "Recondensor Si410 (2A) temp too high",
  21: "Recondensor Si410 (2B) temp too low",
  22: "Recondensor Si410 (2B) temp too high",
  23: "Coldhead RuO temp too hot",
  24: "Coldhead RuO temp too cold",
  25: "Vessel pressure too high",
  26: "Vessel pressure too low",
  27: "Spare SR1A high",
  28: "Spare SR1A low",
  29: "Spare SR1B high",
  30: "Spare SR1B low",
  31: "SC pressure too high",
  32: "SC pressure too low",
  33: "Spare CMP1B high",
  34: "Spare CMP1B low",
  35: "Spare CMP1C high",
  36: "Spare CMP1C low",
  37: "Single-stage temp too low",
  38: "Single-stage temp too high",
  44: "Vessel pressure sensor cable disconnected",
  45: "He level cable disconnected",
  46: "He level top cable disconnected",
  47: "Recondensor RuO cable disconnected",
  48: "Coldhead RuO sensor cable disconnected",
  49: "Shield temp sensor cable disconnected",
  50: "Recondensor Si410 cable disconnected",
  51: "Recondensor Si410 (2A) cable disconnected",
  52: "Recondensor Si410 (2A) cable disconnected",
  53: "The RuO buffer is drawing too much current from Magmon",
  54: "The remote alarm is drawing too much current from Magmon",
  55: "The 12v heater is drawing too much current from Magmon",
  56: "Water meter 1 is drawing too much current from Magmon",
  57: "Water meter 2 is drawing too much current from Magmon",
  58: "The 12v heater is under voltage when turned on",
  65: "Magmon driving too much current into the He level sensor",
  66: "Magmon not driving enough current into the He level sensor",
  67: "Magmon driving too much current into the He level top sensor",
  68: "Magmon not driving enough current into the He level top sensor",
  69: "Magmon driving too much current into the Recondensor RuO sensor",
  70: "Magmon not driving enough current into the Recondensor RuO sensor",
  71: "Magmon driving too much current into the coldhead RuO sensor",
  72: "Magmon not driving enough current into the coldhead RuO sensor",
  73: "Magmon driving too much current into the Recondensor Si410 sensor",
  74: "Magmon not driving enough current into the Recondensor Si410 sensor",
  75: "Magmon driving too much current into the Recondensor Si410 (2A) sensor",
  76: "Magmon not driving enough current into the Recondensor Si410 (2A) sensor",
  77: "Magmon driving too much current into the Recondensor Si410 (2B) sensor",
  78: "Magmon not driving enough current into the Recondensor Si410 (2B) sensor",
  79: "Magmon driving too much current into the Shield Si410 sensor",
  80: "Magmon not driving enough current into the Shield Si410 sensor",
  81: "Magmon supplied 12v for the RuO buffer is too high",
  82: "Magmon supplied 12v for the RuO buffer is too low",
  83: "Magmon internal 12v supply is too high",
  84: "Magmon internal 12v supply is too low",
  85: "Magmon internal -12v supply is too high",
  86: "Magmon internal -12v supply is too low",
  87: "Magmon supplied -12v for the RuO buffer is too high",
  88: "Magmon supplied -12v for the RuO buffer is too low",
  91: "Magnet monitor internal temp too hot",
  92: "Magnet monitor internal temp too cold",
  100: "The heater has been on too long",
  101: "The He pressure is not changing",
  102: "The RfUnblank signal from the system cabinet is always on",
  110: "System cabinet coolant leak detected",
  120: "The magnet field reed switch is open",
  121: "Compressor 1 is not running",
  122: "Compressor 1 reports a tripped fuse",
  123: "Compressor 1 reports an overtemp shutdown",
  124: "Compressor 1 reports a low He pressure shutdown",
  125: "No 24v supply from compressor 1",
  126: "Compressor 1 reports a klixon error",
  127: "Compressor 2 is not running",
  128: "Compressor 2 reports a tripped fuse",
  129: "Compressor 2 reports an overtemp shutdown",
  130: "Compressor 2 reports a low He pressure shutdown",
  131: "No 24v supply from compressor 2",
  132: "Compressor 2 reports a klixon error",
};

// The CS1/CS2 columns. The vendor lists fuse and klixon in both a one- and
// two-digit form (8/18, 4/14); both are carried.
const COMPRESSOR_STATUS: Record<number, string> = {
  0: "normal operation, compressor running",
  4: "klixon error",
  8: "compressor fuse tripped",
  10: "compressor stopped, reason unknown",
  11: "compressor stopped due to overheat",
  12: "compressor stopped due to low He pressure",
  13: "compressor stopped due to overheat and low pressure",
  14: "klixon error",
  18: "compressor fuse tripped",
  20: "compressor powered off or cable disconnected (no 24v signal)",
  30: "compressor powered off or cable disconnected (no 24v signal)",
  31: "compressor powered off or cable disconnected (no 24v signal)",
  32: "compressor powered off or cable disconnected (no 24v signal)",
  33: "compressor powered off or cable disconnected (no 24v signal)",
};

export function errorText(code: number): string {
  return ERROR_TEXT[code] ?? "undocumented code";
}

export function compressorStatusText(code: number): string {
  return COMPRESSOR_STATUS[code] ?? "undocumented status code";
}

/**
 * The set of error codes a raw device row is currently raising.
 *
 * Reads EC1-EC4 out of telemetry_samples.data, drops the zero padding, and
 * de-duplicates — the ORDER is severity, not identity, so the caller gets codes
 * ascending and never a slot number. Values arrive as numbers or as numeric
 * strings ("26.0") depending on which reporting path stored the row.
 */
export function activeErrorCodes(data: Record<string, unknown> | null | undefined): number[] {
  if (!data) return [];
  const out = new Set<number>();
  for (const key of ["EC1", "EC2", "EC3", "EC4"]) {
    const raw = data[key];
    const n = typeof raw === "string" ? Number(raw) : raw;
    if (typeof n === "number" && Number.isFinite(n) && n !== 0) out.add(Math.round(n));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Codes so common across the fleet that they carry little information on their
 * own. 26 (vessel pressure low) sits on 8 of 13 units and 6 (flow high) on 5,
 * which reads as a default threshold most units simply live outside rather than
 * as thirteen simultaneous faults. Shown, but muted, so a genuinely rare code
 * next to them is the thing that catches the eye.
 */
export const COMMON_CODES = new Set([2, 6, 26]);
