"use client";

// The Alerts tab: threshold rules, who gets the email, the sender identity, and
// the recent-events list.
//
// Split out of app/admin/page.tsx. The rule form's six pieces of state and its
// five handlers were held by the page and drilled down; they are local now.
// The three sections below already loaded their own data and are unchanged.

import { useCallback, useEffect, useState } from "react";
import { type Asset } from "@/lib/supabase";
import { actionError } from "@/lib/errors";
import { NO_TELEMETRY_KINDS } from "@/lib/health";
import {
  adminUpsertAlertRule,
  adminDeleteAlertRule,
  adminListAlertRecipients,
  adminUpsertAlertRecipient,
  adminDeleteAlertRecipient,
  adminSendTestAlert,
  adminGetAlertIdentity,
  adminSetAlertIdentity,
  adminSetAlertFrom,
  adminSetPlatformAlertFrom,
  adminListAlertEvents,
} from "@/lib/adminActions";
import type { AlertIdentity } from "@/lib/adminActions";
import {
  Field,
  formatAuditTime,
  type AlertRule,
  type AlertRecipient,
  type AlertEventRow,
  type Toast,
} from "./shared";

const ALERT_METRICS: { key: string; label: string; unit: string; group: string }[] = [
  { key: "he_lvl", label: "Helium level", unit: "%", group: "Magnet (MagMon)" },
  { key: "he_press", label: "Helium pressure", unit: "", group: "Magnet (MagMon)" },
  { key: "h2o_flow", label: "Water flow", unit: "gpm", group: "Magnet (MagMon)" },
  { key: "h2o_temp", label: "Water temp", unit: "°F", group: "Magnet (MagMon)" },
  { key: "shield", label: "Shield temp", unit: "", group: "Magnet (MagMon)" },
  { key: "cs1", label: "CS1 / compressor", unit: "", group: "Magnet (MagMon)" },
  { key: "s1_temp_f", label: "Section 1 (Engineering) temp", unit: "°F", group: "Environment" },
  { key: "s1_rh", label: "Section 1 (Engineering) humidity", unit: "%RH", group: "Environment" },
  { key: "s2_temp_f", label: "Section 2 (Tech / Patient) temp", unit: "°F", group: "Environment" },
  { key: "s2_rh", label: "Section 2 (Tech / Patient) humidity", unit: "%RH", group: "Environment" },
  { key: "s3_temp_f", label: "Section 3 (Equipment) temp", unit: "°F", group: "Environment" },
  { key: "s3_rh", label: "Section 3 (Equipment) humidity", unit: "%RH", group: "Environment" },
  // ups_on_battery is 1/0. The fleet already carries "= 1" as its outage rule,
  // which is what raises POWER OUTAGE; it is listed so it can be seen and
  // edited rather than being an invisible row only the database knows about.
  { key: "ups_on_battery", label: "On UPS battery (1 = outage)", unit: "", group: "Power" },
  { key: "ups_batt_pct", label: "UPS battery remaining", unit: "%", group: "Power" },
  { key: "ups_input_v", label: "UPS input voltage", unit: "V", group: "Power" },
];

const ALERT_METRIC_GROUPS = [...new Set(ALERT_METRICS.map((m) => m.group))];
const ALERT_COMPARATORS = ["<", "<=", ">", ">=", "=", "!="];

export default function AlertsPanel({
  assets,
  alertRules,
  isDemoOrg,
  reload,
  notify,
  fail,
  askConfirm,
}: {
  assets: Asset[];
  alertRules: AlertRule[];
  isDemoOrg: boolean;
  reload: () => void;
  notify: (msg: string, kind?: Toast["kind"]) => void;
  fail: (msg: string) => void;
  askConfirm: (message: string, danger?: boolean) => Promise<boolean>;
}) {
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleScope, setRuleScope] = useState<string>(""); // "" = all assets (fleet default)
  const [ruleField, setRuleField] = useState<string>(ALERT_METRICS[1].key);
  const [ruleComparator, setRuleComparator] = useState<string>(">");
  // A STRING, not a number, so the field can genuinely be empty. It used to
  // default to 3, which is a meaningless limit on every metric and quietly
  // became a real rule if nobody noticed. Parsed and validated on save.
  const [ruleThreshold, setRuleThreshold] = useState<string>("");
  const [ruleEnabled, setRuleEnabled] = useState<boolean>(true);

  function resetRuleForm() {
    setEditingRuleId(null);
    setRuleScope("");
    setRuleField(ALERT_METRICS[1].key);
    setRuleComparator(">");
    setRuleThreshold("");
    setRuleEnabled(true);
  }

  function handleEditRule(r: AlertRule) {
    setEditingRuleId(r.id);
    setRuleScope(r.asset_id ?? "");
    setRuleField(r.field);
    setRuleComparator(r.comparator);
    setRuleThreshold(String(Number(r.threshold)));
    setRuleEnabled(r.enabled);
  }

  async function handleSaveRule(e: React.FormEvent) {
    e.preventDefault();
    // An empty or non-numeric threshold is refused rather than coerced:
    // Number("") is 0, which on most of these metrics is a rule that fires
    // constantly or never, and either way not one anybody meant to write.
    const threshold = Number(ruleThreshold.trim());
    if (ruleThreshold.trim() === "" || !Number.isFinite(threshold)) {
      return fail("Enter a threshold value for this rule.");
    }
    const { error } = await adminUpsertAlertRule({
      ruleId: editingRuleId,
      assetId: ruleScope || null,
      field: ruleField,
      comparator: ruleComparator,
      threshold,
      enabled: ruleEnabled,
    });
    if (error) return fail(actionError("Could not save alert rule", error));
    notify(editingRuleId ? "Alert rule updated." : "Alert rule added.");
    resetRuleForm();
    reload();
  }

  async function handleToggleRule(r: AlertRule) {
    const { error } = await adminUpsertAlertRule({
      ruleId: r.id,
      assetId: r.asset_id,
      field: r.field,
      comparator: r.comparator,
      threshold: Number(r.threshold),
      enabled: !r.enabled,
    });
    if (error) return fail(actionError("Could not update alert rule", error));
    reload();
  }

  async function handleDeleteRule(r: AlertRule) {
    const metric = ALERT_METRICS.find((m) => m.key === r.field)?.label ?? r.field;
    if (!(await askConfirm(`Delete this alert rule (${metric} ${r.comparator} ${Number(r.threshold)})?`, true))) return;
    const { error } = await adminDeleteAlertRule(r.id);
    if (error) return fail(actionError("Could not delete alert rule", error));
    notify("Alert rule deleted.");
    if (editingRuleId === r.id) resetRuleForm();
    reload();
  }
  return (
    <>
      <AlertsTab
        assets={assets}
        alertRules={alertRules}
        editingRuleId={editingRuleId}
        ruleScope={ruleScope}
        setRuleScope={setRuleScope}
        ruleField={ruleField}
        setRuleField={setRuleField}
        ruleComparator={ruleComparator}
        setRuleComparator={setRuleComparator}
        ruleThreshold={ruleThreshold}
        setRuleThreshold={setRuleThreshold}
        ruleEnabled={ruleEnabled}
        setRuleEnabled={setRuleEnabled}
        handleSaveRule={handleSaveRule}
        resetRuleForm={resetRuleForm}
        handleToggleRule={handleToggleRule}
        handleEditRule={handleEditRule}
        handleDeleteRule={handleDeleteRule}
      />
      <AlertRecipientsSection isDemoOrg={isDemoOrg} notify={notify} fail={fail} askConfirm={askConfirm} />
      <AlertSenderSection notify={notify} fail={fail} />
      <AlertEventsSection />
    </>
  );
}

/* ---------------------------------------------------------------- Alerts tab */

function AlertsTab(props: {
  assets: Asset[];
  alertRules: AlertRule[];
  editingRuleId: string | null;
  ruleScope: string;
  setRuleScope: (v: string) => void;
  ruleField: string;
  setRuleField: (v: string) => void;
  ruleComparator: string;
  setRuleComparator: (v: string) => void;
  ruleThreshold: string;
  setRuleThreshold: (v: string) => void;
  ruleEnabled: boolean;
  setRuleEnabled: (v: boolean) => void;
  handleSaveRule: (e: React.FormEvent) => void;
  resetRuleForm: () => void;
  handleToggleRule: (r: AlertRule) => void;
  handleEditRule: (r: AlertRule) => void;
  handleDeleteRule: (r: AlertRule) => void;
}) {
  const { assets, alertRules, editingRuleId } = props;
  return (
    <section className="mb-10">
      <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-2">Alert rules</h2>
      <p className="text-xs text-[var(--text-dim)] mb-3">
        A rule scoped to <strong>All assets</strong> is the fleet default. Scope a rule to a single asset to
        override the fleet default for just that unit. The evaluator runs every minute; maintenance units are exempt.
      </p>
      <p className="text-xs text-[var(--text-dim)] mb-3">
        A rule only ever applies where the reading exists — a channel a unit
        does not report is skipped rather than treated as zero, so a fleet-wide
        environmental rule is safe to add before every unit has the sensors.
        <strong className="text-[var(--text-muted)]"> Temperature and humidity limits are deliberately unset</strong>;
        add them once the right numbers are known. Power outage is already
        covered fleet-wide by <span className="font-mono-data">On UPS battery = 1</span>.
      </p>
      <form onSubmit={props.handleSaveRule} className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-5 flex flex-wrap items-end gap-4 mb-4">
        <Field label="Scope">
          <select value={props.ruleScope} onChange={(e) => props.setRuleScope(e.target.value)} className="input">
            <option value="">All assets</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Metric">
          <select value={props.ruleField} onChange={(e) => props.setRuleField(e.target.value)} className="input">
            {ALERT_METRIC_GROUPS.map((g) => (
              <optgroup key={g} label={g}>
                {ALERT_METRICS.filter((m) => m.group === g).map((m) => (
                  <option key={m.key} value={m.key}>{m.label}{m.unit ? ` (${m.unit})` : ""}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Condition">
          <select value={props.ruleComparator} onChange={(e) => props.setRuleComparator(e.target.value)} className="input w-20 font-mono-data">
            {ALERT_COMPARATORS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Threshold">
          <input
            type="number"
            step="any"
            value={props.ruleThreshold}
            onChange={(e) => props.setRuleThreshold(e.target.value)}
            placeholder="—"
            className="input w-28 font-mono-data"
          />
        </Field>
        <label className="flex items-center gap-2 text-xs text-[var(--text-dim)]">
          <input type="checkbox" checked={props.ruleEnabled} onChange={(e) => props.setRuleEnabled(e.target.checked)} />
          Enabled
        </label>
        <button type="submit" className="btn-primary">{editingRuleId ? "Save rule" : "Add rule"}</button>
        {editingRuleId && (
          <button type="button" onClick={props.resetRuleForm} className="btn-secondary">Cancel</button>
        )}
      </form>

      <div className="rounded-xl border border-[var(--border-soft)] overflow-hidden">
        {alertRules.map((r) => {
          const metric = ALERT_METRICS.find((m) => m.key === r.field);
          return (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[var(--border)] last:border-0">
              <div>
                <p className="font-medium">
                  {metric?.label ?? r.field}{" "}
                  <span className="font-mono-data text-sm text-[var(--text-muted)]">{r.comparator} {Number(r.threshold)}</span>
                  {!r.enabled && <span className="ml-2 text-xs text-[var(--text-dim)]">(disabled)</span>}
                </p>
                <p className="text-xs text-[var(--text-dim)]">
                  {r.asset_name ? `Override — ${r.asset_name}` : "All assets"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => props.handleToggleRule(r)} className="btn-secondary">{r.enabled ? "Disable" : "Enable"}</button>
                <button onClick={() => props.handleEditRule(r)} className="btn-secondary">Edit</button>
                <button onClick={() => props.handleDeleteRule(r)} className="btn-secondary" style={{ color: "var(--status-offline)" }}>Delete</button>
              </div>
            </div>
          );
        })}
        {alertRules.length === 0 && <p className="px-4 py-6 text-center text-[var(--text-dim)]">No alert rules yet.</p>}
      </div>
    </section>
  );
}


/* -------------------------------------------------- Alert recipients section */

function AlertRecipientsSection({
  isDemoOrg,
  notify,
  fail,
  askConfirm,
}: {
  isDemoOrg: boolean;
  notify: (msg: string) => void;
  fail: (msg: string) => void;
  askConfirm: (message: string, danger?: boolean) => Promise<boolean>;
}) {
  const [recipients, setRecipients] = useState<AlertRecipient[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [address, setAddress] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await adminListAlertRecipients();
    setRecipients((data as AlertRecipient[]) ?? []);
  }, []);
  useEffect(() => {
    // load() is async: every setState in it runs after an await, on a
    // later tick, not synchronously during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  function reset() {
    setEditingId(null);
    setChannel("email");
    setAddress("");
    setEnabled(true);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await adminUpsertAlertRecipient({
      id: editingId,
      channel,
      address,
      enabled,
    });
    if (error) return fail(actionError("Could not save recipient", error));
    notify(editingId ? "Recipient updated." : "Recipient added.");
    reset();
    load();
  }
  function edit(r: AlertRecipient) {
    setEditingId(r.id);
    setChannel(r.channel);
    setAddress(r.address);
    setEnabled(r.enabled);
  }
  async function toggle(r: AlertRecipient) {
    const { error } = await adminUpsertAlertRecipient({
      id: r.id,
      channel: r.channel,
      address: r.address,
      enabled: !r.enabled,
    });
    if (error) return fail(actionError("Could not update recipient", error));
    load();
  }
  async function remove(r: AlertRecipient) {
    if (!(await askConfirm(`Remove ${r.address} from alert recipients?`, true))) return;
    const { error } = await adminDeleteAlertRecipient(r.id);
    if (error) return fail(actionError("Could not remove recipient", error));
    notify("Recipient removed.");
    if (editingId === r.id) reset();
    load();
  }
  // Send a single test email to this recipient via the notify-alerts function's
  // admin-gated test mode, so a new address can be verified end-to-end.
  //
  // Goes through a server action so the browser never handles a credential —
  // the session cookie's token is forwarded server-side and validated by
  // _admin_actor. This was the last call site keeping Session.pin alive.
  async function test(r: AlertRecipient) {
    if (r.channel !== "email") return fail("Test currently supports email recipients only.");
    setTestingId(r.id);
    try {
      const { data, error } = await adminSendTestAlert(r.address);
      if (error) return fail(actionError("Test failed", error));
      if (data?.message) notify(data.message);
    } finally {
      setTestingId(null);
    }
  }

  return (
    <section className="mb-10">
      <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-2">Recipients</h2>
      <p className="text-xs text-[var(--text-dim)] mb-3">
        Who gets notified when an alert opens. Email is delivered via Resend once the notifier is enabled; the SMS
        channel is stored but not yet wired.
      </p>
      {/* Recipients stay editable here — the block is in the notifier, which is
          the only place it can't be worked around — but saying so up front beats
          letting someone add an address and wait for mail that never comes. */}
      {isDemoOrg && (
        <p className="text-xs mb-3 rounded-lg px-3 py-2 border border-[var(--border-soft)] text-[var(--text-dim)]">
          This is a demo company. Its alerts are <strong>never emailed or pushed</strong>, whatever is
          listed here — the units behind them are simulated.
        </p>
      )}
      <form onSubmit={save} className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-5 flex flex-wrap items-end gap-4 mb-4">
        <Field label="Channel">
          <select value={channel} onChange={(e) => setChannel(e.target.value as "email" | "sms")} className="input">
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </select>
        </Field>
        <Field label={channel === "email" ? "Email address" : "Phone (E.164)"}>
          <input
            required
            type={channel === "email" ? "email" : "text"}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={channel === "email" ? "name@example.com" : "+15125550123"}
            className="input min-w-[16rem] font-mono-data"
          />
        </Field>
        <label className="flex items-center gap-2 text-xs text-[var(--text-dim)]">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <button type="submit" className="btn-primary">{editingId ? "Save recipient" : "Add recipient"}</button>
        {editingId && (
          <button type="button" onClick={reset} className="btn-secondary">Cancel</button>
        )}
      </form>

      <div className="rounded-xl border border-[var(--border-soft)] overflow-hidden">
        {recipients.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[var(--border)] last:border-0">
            <div>
              <p className="font-medium font-mono-data">
                {r.address}
                {!r.enabled && <span className="ml-2 text-xs text-[var(--text-dim)]">(disabled)</span>}
              </p>
              <p className="text-xs text-[var(--text-dim)] uppercase tracking-wide">{r.channel}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => test(r)}
                disabled={testingId === r.id}
                className="btn-secondary"
                title="Send a test email to this address"
              >
                {testingId === r.id ? "Sending…" : "Test"}
              </button>
              <button onClick={() => toggle(r)} className="btn-secondary">{r.enabled ? "Disable" : "Enable"}</button>
              <button onClick={() => edit(r)} className="btn-secondary">Edit</button>
              <button onClick={() => remove(r)} className="btn-secondary" style={{ color: "var(--status-offline)" }}>Remove</button>
            </div>
          </div>
        ))}
        {recipients.length === 0 && (
          <p className="px-4 py-6 text-center text-[var(--text-dim)]">No recipients yet — add one to receive alert emails.</p>
        )}
      </div>
    </section>
  );
}


/* ---------------------------------------------------- Sender identity section */

// Who the alert emails come FROM, and how they read.
//
// The split here is deliberate. Everything a company admin can edit is
// cosmetic-but-meaningful — the display name is what a recipient actually reads
// in an inbox list, and Reply-To decides where an answer lands — and none of it
// requires a DNS record. The ADDRESS is superadmin-only, because it must be a
// Resend-verified sender: point it at an unverified domain and every send fails
// silently, once a minute, forever.
//
// Sending as alerts@customer.org was considered and rejected: SPF/DKIM for that
// From would have to be published in the CUSTOMER's DNS, and a DMARC-enforcing
// hospital junks anything without them.

function AlertSenderSection({
  notify,
  fail,
}: {
  notify: (msg: string) => void;
  fail: (msg: string) => void;
}) {
  const [identity, setIdentity] = useState<AlertIdentity | null>(null);
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [prefix, setPrefix] = useState("");
  const [orgFrom, setOrgFrom] = useState("");
  const [platformFrom, setPlatformFrom] = useState("");

  const load = useCallback(async () => {
    const { data } = await adminGetAlertIdentity();
    if (!data) return;
    setIdentity(data);
    setFromName(data.from_name ?? "");
    setReplyTo(data.reply_to ?? "");
    setPrefix(data.subject_prefix ?? "");
    setOrgFrom(data.from_addr ?? "");
    setPlatformFrom(data.platform_from ?? "");
  }, []);
  useEffect(() => {
    // load() is async: every setState in it runs after an await, on a
    // later tick, not synchronously during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function saveIdentity(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await adminSetAlertIdentity({ fromName, replyTo, subjectPrefix: prefix });
    if (error) return fail(actionError("Could not save sender identity", error));
    notify("Sender identity updated.");
    load();
  }

  async function saveOrgFrom(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await adminSetAlertFrom(orgFrom);
    if (error) return fail(actionError("Could not save sending address", error));
    notify(orgFrom.trim() ? "Company sending address updated." : "Cleared — using the platform address.");
    load();
  }

  async function savePlatformFrom(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await adminSetPlatformAlertFrom(platformFrom);
    if (error) return fail(actionError("Could not save platform address", error));
    notify(platformFrom.trim() ? "Platform sending address updated." : "Cleared — falling back to the ALERT_FROM secret.");
    load();
  }

  const loaded = identity !== null;
  const effectiveName = fromName.trim() || identity?.from_name_default || "";
  const effectivePrefix = prefix.trim() || identity?.subject_prefix_default || "MagMon";
  // Mirrors composeFrom() in the notify-alerts function, including the quoting
  // rule — a company name with a comma ("Numed, Inc") has to be quoted or the
  // header parses as two addresses, and an admin should see that here.
  const effectiveAddr = identity?.from_addr || "onboarding@resend.dev (Resend test sender)";
  const needsQuotes = /[()<>@,;:\\".[\]]/.test(effectiveName);
  const previewFrom = effectiveName
    ? `${needsQuotes ? `"${effectiveName}"` : effectiveName} <${effectiveAddr}>`
    : effectiveAddr;

  return (
    <section className="mb-10">
      <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-2">Sender identity</h2>
      <p className="text-xs text-[var(--text-dim)] mb-3">
        How your alert emails appear in a recipient&apos;s inbox. The sending address is shared across
        companies and set by Numed; the name and reply address are yours.
      </p>

      <form onSubmit={saveIdentity} className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-5">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Sender name">
            <input
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder={identity?.from_name_default ?? ""}
              maxLength={78}
              className="input min-w-[18rem]"
              disabled={!loaded}
            />
          </Field>
          <Field label="Reply-To">
            <input
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              placeholder="biomed@yourhospital.org"
              className="input min-w-[16rem] font-mono-data"
              disabled={!loaded}
            />
          </Field>
          <Field label="Subject prefix">
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder={identity?.subject_prefix_default ?? "MagMon"}
              maxLength={40}
              className="input min-w-[12rem]"
              disabled={!loaded}
            />
          </Field>
          <button type="submit" className="btn-primary" disabled={!loaded}>Save</button>
        </div>

        <p className="text-xs text-[var(--text-dim)] mt-3">
          Leave any field blank to use the placeholder shown. With no Reply-To, replies go to an
          unmonitored mailbox.
        </p>

        {loaded && (
          <div className="mt-4 rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] p-4 text-xs font-mono-data leading-relaxed">
            <div className="text-[var(--text-dim)] uppercase tracking-wide mb-2 font-sans">Preview</div>
            <div><span className="text-[var(--text-dim)]">From:&nbsp;&nbsp;&nbsp;&nbsp;</span>{previewFrom}</div>
            <div>
              <span className="text-[var(--text-dim)]">Reply-To:</span>{" "}
              {replyTo.trim() || <span className="text-[var(--text-dim)]">(none)</span>}
            </div>
            <div><span className="text-[var(--text-dim)]">Subject:&nbsp;</span>{effectivePrefix}: NM1035 h2o_temp &gt; 75 (now 100.5)</div>
            <div><span className="text-[var(--text-dim)]">Subject:&nbsp;</span>{effectivePrefix}: 3 alerts — NM1027, NM1020 +1 more</div>
          </div>
        )}
      </form>

      {identity?.is_superadmin && (
        <div className="mt-4 rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-5">
          <h3 className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-1">
            Sending address · Numed only
          </h3>
          <p className="text-xs text-[var(--text-dim)] mb-4">
            Must be a <strong>Resend-verified sender</strong> — verify the domain in Resend first, or every
            send fails. Plain address only, no name: the name above is attached at send time. The platform
            address is the default every company inherits; the per-company override is for a customer who
            has verified their own domain.
          </p>
          <div className="flex flex-wrap items-end gap-6">
            <form onSubmit={savePlatformFrom} className="flex items-end gap-3">
              <Field label="Platform default (all companies)">
                <input
                  value={platformFrom}
                  onChange={(e) => setPlatformFrom(e.target.value)}
                  placeholder="alerts@numedmagnetdata.com"
                  className="input min-w-[20rem] font-mono-data"
                />
              </Field>
              <button type="submit" className="btn-secondary">Save</button>
            </form>
            <form onSubmit={saveOrgFrom} className="flex items-end gap-3">
              <Field label="Override for this company">
                <input
                  value={orgFrom}
                  onChange={(e) => setOrgFrom(e.target.value)}
                  placeholder="(inherit the platform default)"
                  className="input min-w-[20rem] font-mono-data"
                />
              </Field>
              <button type="submit" className="btn-secondary">Save</button>
            </form>
          </div>
          <p className="text-xs text-[var(--text-dim)] mt-4">
            With both blank, sending falls back to the <span className="font-mono-data">ALERT_FROM</span>{" "}
            secret and then to <span className="font-mono-data">onboarding@resend.dev</span>, which only ever
            delivers to your own Resend account — no customer will receive anything.
          </p>
        </div>
      )}

      <p className="text-xs text-[var(--text-dim)] mt-3">
        Use a recipient&apos;s <strong>Test</strong> button above to confirm a change actually delivers.
      </p>
    </section>
  );
}


/* ------------------------------------------------------ Recent alerts section */

function AlertEventsSection() {
  const [events, setEvents] = useState<AlertEventRow[]>([]);
  const load = useCallback(async () => {
    const { data } = await adminListAlertEvents(100);
    setEvents((data as AlertEventRow[]) ?? []);
  }, []);
  useEffect(() => {
    // load() is async: every setState in it runs after an await, on a
    // later tick, not synchronously during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const openCount = events.filter((e) => !e.resolved_at).length;

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)]">
          Recent alerts
          {openCount > 0 && <span className="alert-count">{openCount} active</span>}
        </h2>
        <button onClick={load} className="btn-secondary">Refresh</button>
      </div>
      <p className="text-xs text-[var(--text-dim)] mb-3">
        Opened and resolved automatically by the evaluator each minute. Active first, showing the most recent {events.length}.
      </p>
      <div className="rounded-xl border border-[var(--border-soft)] overflow-hidden">
        {events.map((e) => {
          const isOpen = !e.resolved_at;
          const color = isOpen
            ? NO_TELEMETRY_KINDS.has(e.kind)
              ? "var(--status-offline)"
              : "var(--status-warning)"
            : "var(--text-dim)";
          return (
            <div
              key={e.id}
              className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-[var(--border)] last:border-0"
              style={{ opacity: isOpen ? 1 : 0.68 }}
            >
              <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm">{e.message}</p>
                <p className="text-xs text-[var(--text-dim)]">
                  {isOpen ? "open" : "resolved"} · {formatAuditTime(isOpen ? e.triggered_at : (e.resolved_at as string))}
                  {e.notified_at ? " · notified" : ""}
                </p>
              </div>
            </div>
          );
        })}
        {events.length === 0 && (
          <p className="px-4 py-6 text-center text-[var(--text-dim)]">No alerts recorded yet.</p>
        )}
      </div>
    </section>
  );
}

