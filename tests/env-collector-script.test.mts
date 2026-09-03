import test from "node:test";
import assert from "node:assert/strict";

import {
  ENV_COLLECTOR_VERSION,
  generateEnvPiScript,
  generatePiScript,
  generateSystemdUnit,
} from "../lib/piScript.ts";
import { MODALITY_MRI, MODALITY_PETCT } from "../lib/modality.ts";

/**
 * The environmental collector as an ADD-ON to a magnet, not just as the PET/CT
 * trailer's only program.
 *
 * NM1019 is the first unit to run both collectors on one Pi for one asset, and
 * everything that keeps them from fighting is in the generated names: two
 * scripts, two services, two lock files, two syslog identifiers. A change that
 * collapses any of those pairs is invisible in review and obvious in the field,
 * where it looks like a collector that keeps dying or a unit whose helium goes
 * blank whenever the bay sensor reports.
 *
 * Static and offline, like the other suites: no database, no network, no Pi.
 */

const shared = {
  assetName: "NM1019",
  gatewayToken: "test-token",
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "test-key",
  intervalMinutes: 5,
  serviceUser: "numed",
};

test("the env script names the asset's real modality, not always PET/CT", () => {
  const petct = generateEnvPiScript(shared);
  assert.match(petct, new RegExp(`Asset: NM1019\\s+\\(modality: ${MODALITY_PETCT.replace("/", "\\/")}\\)`));

  const magnet = generateEnvPiScript({ ...shared, modality: MODALITY_MRI });
  assert.match(magnet, /Asset: NM1019\s+\(modality: MRI\)/);
  // A header that calls a magnet a PET/CT is how a script ends up installed on
  // the wrong machine.
  assert.ok(!magnet.includes("(modality: PET/CT)"));
});

test("a mixed unit's script says the second collector is supposed to be there", () => {
  const addon = generateEnvPiScript({ ...shared, modality: MODALITY_MRI, alongsideMagmon: true });
  assert.match(addon, /THIS UNIT RUNS TWO COLLECTORS/);
  // The trap this heads off: the runbook's own check prints 2 on this box.
  assert.match(addon, /pgrep -c -f gateway\s+# 2/);
  assert.match(addon, /magmon-gateway-NM1019/);

  // A trailer with no magnet must not be told about a collector it does not run.
  const alone = generateEnvPiScript(shared);
  assert.ok(!alone.includes("THIS UNIT RUNS TWO COLLECTORS"));
});

test("the two collectors share no filename, path, service or log tag", () => {
  const magmonUnit = generateSystemdUnit({ assetName: "NM1019", serviceUser: "numed" });
  const envUnit = generateSystemdUnit({ assetName: "NM1019", serviceUser: "numed", variant: "env" });

  assert.match(magmonUnit, /ExecStart=\/usr\/bin\/python3 \/opt\/magmon-gateway-NM1019\.py/);
  assert.match(envUnit, /ExecStart=\/usr\/bin\/python3 \/opt\/env-gateway-NM1019\.py/);
  assert.match(magmonUnit, /SyslogIdentifier=magmon-NM1019/);
  assert.match(envUnit, /SyslogIdentifier=env-NM1019/);

  // Both must still restart forever and run unbuffered — a silent-but-alive
  // collector is the failure mode that took days to spot on the MagMon fleet.
  for (const unit of [magmonUnit, envUnit]) {
    assert.match(unit, /Restart=always/);
    assert.match(unit, /Environment=PYTHONUNBUFFERED=1/);
  }
});

test("each collector reports its own version to its own RPC", () => {
  const env = generateEnvPiScript({ ...shared, modality: MODALITY_MRI, alongsideMagmon: true });
  const magmon = generatePiScript({
    ...shared,
    monitorHost: "10.11.7.42",
    monitorPort: 80,
    monitorUsername: "MMService",
    monitorPassword: "MagnetMonitor",
  });

  assert.match(env, /rpc\/report_env_telemetry/);
  assert.ok(!env.includes("rpc/report_telemetry_batch"));
  assert.match(magmon, /rpc\/report_telemetry_batch/);
  assert.ok(!magmon.includes("rpc/report_env_telemetry"));

  // The env stamp is prefixed so the fleet list can tell the two programs apart
  // at a glance rather than comparing two date strings that mean different things.
  assert.match(ENV_COLLECTOR_VERSION, /^env-/);
  assert.match(env, new RegExp(`ENV_COLLECTOR_VERSION = "${ENV_COLLECTOR_VERSION}"`));
});
