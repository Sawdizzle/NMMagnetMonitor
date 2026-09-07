// What the collectors report as their build, and what the admin panel compares
// each unit against.
//
// Their own module, apart from the generator that stamps them in. lib/piScript
// is 62 kB — the Python collector held as template strings — and the fleet list
// needs only these two strings to say whether a Pi is behind. Importing them
// from piScript pulled the whole generator into the admin's browser bundle;
// keeping them here means that cannot happen again by accident, whatever a
// bundler decides to tree-shake.

/**
 * The version stamp baked into every generated collector.
 *
 * BUMP THIS whenever generatePiScript's output changes in a way that matters on
 * a Pi. It is what lets the fleet answer "which units are running old code?" --
 * a question we could not answer at all before, and paid for: NM1035 was found
 * to be running a months-old pre-batch collector only because someone noticed
 * its recorded_at had sub-second precision instead of being minute-truncated.
 * That is luck, not monitoring.
 *
 * Deliberately a hand-maintained constant rather than a hash of the output --
 * the output differs per asset (tokens, host, credentials are baked in), so a
 * content hash would give every unit a different "version" and compare to
 * nothing.
 *
 * Format: YYYY.MM.DD-N, N being the nth change that day.
 */
export const COLLECTOR_VERSION = "2026.09.04-1";

/**
 * Version stamp for the ENV collector, reported the same way COLLECTOR_VERSION
 * is and stored in the same assets.collector_version column.
 *
 * Kept as its own constant, and deliberately prefixed "env-", because the two
 * collectors are separate programs on separate release cadences: a MagMon
 * parser fix must not make every environmental unit look out of date, and the
 * prefix is what lets the fleet list tell at a glance which program a unit is
 * running rather than comparing two date strings that mean different things.
 */
export const ENV_COLLECTOR_VERSION = "env-2026.09.03-3";
