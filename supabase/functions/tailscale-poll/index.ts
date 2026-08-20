import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Polls the Tailscale API for the liveness of each MagMon collector Pi and
// stamps assets.tailscale_online — the Pi-side analog of the iR305/DM signal.
//
// WHY POLL (not webhook): Tailscale's webhooks are admin/audit events only
// (node created/deleted, key expiry, ACL changes) — there is no node
// online/offline push. So a scheduled poll (pg_cron → this function) reads
// device lastSeen from the API instead.
//
// WHAT IT MEANS: on Tailscale the node IS the Pi (tailscaled runs on it), so
// node up + telemetry silent -> the collector/MagMon/egress is the fault (SSH in
// over Tailscale to fix it); node down -> Pi powered off / site network down.
// The chip itself is informational, but evaluate_alerts READS this reachability
// to classify a stale unit: Tailscale-up + telemetry-stale opens the
// 'reporting_stalled' alert (gateway/DNS/egress fault, e.g. NM1020 2026-08-13),
// while not-reachable opens plain 'offline'. Both notify.
//
// MATCHING — the tailnet is MIXED. Besides the Pis it holds Windows machines
// named after the same assets (site laptops, MRI console PCs like
// "nm1019-laptop", "ca1012-seaton-sw", "yoakum-nm1007"), plus a NAS and other
// linux boxes. Treating a laptop's connectivity as the magnet's would be flat
// wrong, so we match ONLY os === "linux" devices whose name/hostname embeds an
// asset code (separator-normalized, so "nm-1006"/"nm1021-pi" match NM1006/NM1021).
// We self-heal tailscale_device_id on first match so later polls are exact.

// A node whose control-plane lastSeen is older than this reads as offline.
const ONLINE_WITHIN_MIN = 15;

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ---- config (service-role only, like the VAPID / DM keys) --------------
  const { data: cfg } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["ts_oauth_client_id", "ts_oauth_secret", "ts_tailnet"]);
  const get = (k: string) => cfg?.find((c) => c.key === k)?.value as string | undefined;
  const clientId = get("ts_oauth_client_id");
  const clientSecret = get("ts_oauth_secret");
  const tailnet = get("ts_tailnet") || "-";
  if (!clientId || !clientSecret) {
    return json({ error: "Tailscale OAuth creds not set (ts_oauth_client_id/ts_oauth_secret)" }, 500);
  }

  // ---- OAuth client-credentials token ------------------------------------
  const tokenResp = await fetch("https://api.tailscale.com/api/v2/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret }),
  });
  if (!tokenResp.ok) {
    return json({ error: `Tailscale token exchange failed (${tokenResp.status})`, body: await tokenResp.text() }, 502);
  }
  const accessToken = (await tokenResp.json()).access_token as string;

  // ---- device list -------------------------------------------------------
  const devResp = await fetch(
    `https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(tailnet)}/devices`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!devResp.ok) {
    return json({ error: `Tailscale devices fetch failed (${devResp.status})`, body: await devResp.text() }, 502);
  }
  const devices = ((await devResp.json()).devices ?? []) as TsDevice[];

  const nowMs = Date.now();
  const { data: allAssets } = await supabase
    .from("assets")
    .select("id, name, tailscale_device_id, org_id");
  if (!allAssets) return json({ error: "could not load assets" }, 500);

  // Demo units have no Pi. Their names are matched against the real tailnet by
  // nameEmbedsAsset() below, which is a substring test — an unlucky collision
  // between an invented unit code and a real node would stamp a simulated asset
  // with a real machine's liveness, and the demo would start reporting a
  // connectivity state it has no hardware to have. Drop them before matching.
  const { data: demoOrgs } = await supabase.from("orgs").select("id").eq("is_demo", true);
  const demoOrgIds = new Set((demoOrgs ?? []).map((o) => o.id as string));
  const assets = allAssets.filter((a) => !demoOrgIds.has(a.org_id as string));

  // ---- resolve each asset to at most one linux Pi ------------------------
  // Prefer an exact device-id match; else the most-recently-seen linux device
  // whose name/hostname embeds the asset code.
  type Resolved = { assetId: string; name: string; device: TsDevice; online: boolean };
  const resolved: Resolved[] = [];
  const linux = devices.filter((d) => (d.os ?? "").toLowerCase() === "linux");

  for (const a of assets) {
    let dev: TsDevice | undefined;
    if (a.tailscale_device_id) {
      dev = devices.find((d) => d.id === a.tailscale_device_id || d.nodeId === a.tailscale_device_id);
    }
    if (!dev) {
      const matches = linux.filter((d) => nameEmbedsAsset(a.name, d));
      if (matches.length) {
        matches.sort((x, y) => lastSeenMs(y) - lastSeenMs(x));
        dev = matches[0];
      }
    }
    if (!dev) continue; // no Tailscale node for this asset — leave state untouched
    const online = nowMs - lastSeenMs(dev) <= ONLINE_WITHIN_MIN * 60_000;
    resolved.push({ assetId: a.id, name: a.name, device: dev, online });
  }

  // ---- stamp tailscale_online (informational status only) -----------------
  // This is a chip on the dashboard/asset page — it never opens an alert_event,
  // so a Pi's Tailscale node going up/down never emails or pushes. Only the
  // asset's own telemetry-offline (evaluate_alerts) alerts.
  const nowIso = new Date(nowMs).toISOString();
  let up = 0, down = 0;
  for (const r of resolved) {
    await supabase
      .from("assets")
      .update({
        tailscale_online: r.online,
        tailscale_status_at: nowIso,
        tailscale_device_id: r.device.id, // self-heal to exact for next poll
        // The MagicDNS name, which is the part a human can actually type. Several
        // sites reuse the same private monitor_host (NM1027/NM1029 are both
        // 192.168.14.199), so naming the Pi is the only way to build a command
        // that can reach one specific unit. Falls back to the bare hostname.
        tailscale_hostname: r.device.name ?? r.device.hostname ?? null,
      })
      .eq("id", r.assetId);
    r.online ? up++ : down++;
  }

  return json({
    ok: true,
    devices: devices.length,
    linux: linux.length,
    matched: resolved.length,
    online: up,
    offline: down,
    units: resolved.map((r) => ({ asset: r.name, host: r.device.hostname, online: r.online })),
  });
});

type TsDevice = {
  id?: string;
  nodeId?: string;
  name?: string; // MagicDNS FQDN, e.g. "nm1021-pi.taild41944.ts.net"
  hostname?: string; // e.g. "raspberrypi" or "NM-1006"
  os?: string;
  lastSeen?: string; // RFC3339
};

function lastSeenMs(d: TsDevice): number {
  const t = d.lastSeen ? Date.parse(d.lastSeen) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// Separator-insensitive: does the asset code appear as a bounded token inside
// the device's hostname or MagicDNS label? Normalizing strips the dashes so
// "nm-1006"/"nm1021-pi" match NM1006/NM1021; the digit-boundary check stops
// NM100 from matching NM1006. Uses only the first DNS label (not the .ts.net
// domain) so domain digits can't create false hits.
function nameEmbedsAsset(assetName: string, d: TsDevice): boolean {
  const a = norm(assetName);
  if (a.length < 3) return false;
  const firstLabel = (d.name ?? "").split(".")[0];
  const hay = norm(`${d.hostname ?? ""} ${firstLabel}`);
  let i = hay.indexOf(a);
  while (i !== -1) {
    const before = i > 0 ? hay[i - 1] : "";
    const after = i + a.length < hay.length ? hay[i + a.length] : "";
    if (!/[0-9]/.test(before) && !/[0-9]/.test(after)) return true; // not glued to more digits
    i = hay.indexOf(a, i + 1);
  }
  return false;
}

function norm(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), {
    status: s,
    headers: { "Content-Type": "application/json" },
  });
}
