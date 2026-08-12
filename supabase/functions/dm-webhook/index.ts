import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Receiver for InHand Device Manager (DM) "Webhook Push" alert rules.
//
// DM sends a POST here whenever a gateway alert fires. We care about two Alert
// Types configured as fleet-wide rules in DM (Gateways → Add Alert Rule →
// All Gateways → Webhook Push, pointed at this function's URL):
//   * "Gateway Offline"  (set to fire after ~N min, matching offline_threshold)
//   * "Gateway Online"   (the recovery edge, so we can resolve)
//
// The point: DM detects the router's death CLOUD-SIDE (its heartbeat to DM
// stopped), independent of the Pi's telemetry link. So a gateway-offline event
// means the iR305's cellular link is down and the magnet itself is probably
// fine — a different situation from a silent Pi/collector behind a healthy
// router. We stamp assets.router_online from these events; evaluate_alerts then
// splits the two: router down -> our own 'router_offline' event (below), router
// up but telemetry silent -> the existing generic 'offline' (collector fault).
//
// NOTE: not every asset is on an iR305. Unmapped assets keep router_online NULL
// and simply fall through to the generic offline path — this webhook only ever
// touches assets it can positively match to a DM gateway.
//
// SELF-REVEALING: we do not yet know DM's exact payload field names, so EVERY
// POST is logged verbatim to dm_webhook_events first. The first real event tells
// us what DM calls the device id / event type / timestamp; then tighten the
// extract() candidate lists below to match and the parser is exact.
//
// AUTH: DM's webhook config has a "Key" field. We don't know if DM sends it as a
// header, query param, or body field, so we accept it from any of those and
// compare to the stored dm_webhook_key. We log unauthenticated hits (authed=
// false) but never mutate asset state from them.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Shared key lives in app_settings (service-role only, like the VAPID keys),
  // with an env fallback. Set via: insert into app_settings(key,value)
  // values('dm_webhook_key','<secret>').
  const { data: keyRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "dm_webhook_key")
    .maybeSingle();
  const KEY = (keyRow?.value as string | undefined) ?? Deno.env.get("DM_WEBHOOK_KEY") ?? "";

  const url = new URL(req.url);
  const headers = Object.fromEntries(req.headers); // captured for diagnosis
  const rawText = await req.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = { _unparsed: rawText };
  }

  // ---- verify the shared Key --------------------------------------------
  // DM's exact placement of the "Key" is still unknown, so check every header
  // and query param whose value equals our key, plus common body fields. The
  // full header set is logged (below) so a failed test reveals where DM put it.
  const headerKeyMatch = Object.entries(headers).some(
    ([k, v]) => stripBearer(v) === KEY && !["cookie"].includes(k.toLowerCase()),
  );
  const presentedKey =
    (headerKeyMatch ? KEY : undefined) ??
    url.searchParams.get("key") ??
    url.searchParams.get("token") ??
    firstString(payload, ["key", "token", "secret", "sign", "signature"]) ??
    "";
  const authed = KEY.length > 0 && presentedKey === KEY;

  // ---- best-effort parse (tighten once DM's real fields are known) --------
  const eventRaw = extract(payload, [
    "alertType", "alarmType", "eventType", "event", "type", "alert", "status", "state",
  ]);
  // An opaque, stable id (serial / imei) if DM sends one …
  const deviceId = extract(payload, [
    "sn", "serialNumber", "serial", "deviceId", "device_id", "gatewayId",
    "gateway_id", "gwId", "deviceSn", "device_sn", "imei",
  ]);
  // … and the human gateway name, which per Shawn embeds the asset (e.g.
  // "Numed NM1006", "Union Hospital - IN - NM1021").
  const deviceName = extract(payload, [
    "name", "gatewayName", "gateway_name", "deviceName", "device_name", "label", "alias",
  ]);
  // DM's alert body carries a human "content" sentence that also embeds the
  // gateway name/serial (e.g. "…your gateway (name: NM1021, serial number: …)").
  // Fold it into the haystack so fuzzy asset matching has the best chance.
  const content = extract(payload, ["content", "message", "desc", "description"]);
  const eventType = classify(eventRaw, rawText);
  const matchKey = deviceId ?? deviceName; // stable id we persist as router_device_id
  const haystack = [deviceId, deviceName, content].filter(Boolean).join(" ").trim();

  // ---- match the gateway to one of our assets ----------------------------
  // 1) exact: a previously-stamped router_device_id.
  // 2) fuzzy: the asset's name appears as a whole token inside the gateway's
  //    id/name — then self-heal by stamping router_device_id for next time.
  let matched: { id: string; name: string } | null = null;
  let matchMode = "none";
  if (haystack) {
    const candidates = [deviceId, deviceName].filter(Boolean) as string[];
    const { data: exactRows } = await supabase
      .from("assets")
      .select("id, name")
      .in("router_device_id", candidates)
      .limit(1);
    const exact = exactRows?.[0] ?? null;
    if (exact) {
      matched = exact;
      matchMode = "exact";
    } else {
      const { data: all } = await supabase.from("assets").select("id, name");
      matched =
        (all ?? []).find((a) => nameInHaystack(a.name, haystack)) ?? null;
      if (matched) {
        matchMode = "fuzzy";
        // Self-heal the mapping — but only for authenticated calls, so an
        // unauthenticated POST can never write router_device_id by guessing
        // gateway names. (The alert mutations below are already gated.)
        if (authed && matchKey) {
          await supabase
            .from("assets")
            .update({ router_device_id: matchKey })
            .eq("id", matched.id)
            .is("router_device_id", null); // don't clobber a manual mapping
        }
      }
    }
  }

  // ---- always log the raw payload (schema discovery + audit) --------------
  const note = !authed
    ? "unauthenticated (key mismatch or dm_webhook_key unset) — logged only"
    : !haystack
    ? "authed but no device id/name parsed — extend extract() candidates"
    : !matched
    ? `authed; gateway '${haystack}' matched no asset (name not embedded?)`
    : `authed; matched ${matched.name} (${matchMode}); event=${eventType}`;

  await supabase.from("dm_webhook_events").insert({
    event_type: eventType,
    device_id: matchKey ?? null,
    matched_asset: matched?.id ?? null,
    authed,
    payload: { ...payload, _headers: headers }, // _headers logged for key-location diagnosis
    note,
  });

  if (!authed) return json({ ok: false, error: "unauthorized" }, 401);
  if (!matched) return json({ ok: true, handled: false, note });

  const now = new Date().toISOString();

  // ---- drive router status + the router_offline event lifecycle -----------
  if (eventType === "offline") {
    await supabase
      .from("assets")
      .update({ router_online: false, router_status_at: now })
      .eq("id", matched.id);

    // Open a distinct router_offline event if none is open. The webhook owns
    // this lifecycle (real-time), so it fires before the once-a-minute cron.
    const { data: open } = await supabase
      .from("alert_events")
      .select("id")
      .eq("asset_id", matched.id)
      .eq("kind", "router_offline")
      .is("resolved_at", null)
      .maybeSingle();
    if (!open) {
      await supabase.from("alert_events").insert({
        asset_id: matched.id,
        kind: "router_offline",
        message:
          `${matched.name}: iR305 offline — cellular/router link down per InHand DM. ` +
          `Magnet is likely fine; check carrier/SIM/antenna. Data resumes when the link recovers.`,
      });
    }
    // A generic collector 'offline' already open for this unit is superseded.
    await supabase
      .from("alert_events")
      .update({ resolved_at: now })
      .eq("asset_id", matched.id)
      .eq("kind", "offline")
      .is("resolved_at", null);

    return json({ ok: true, handled: true, asset: matched.name, mode: matchMode, event: "offline" });
  }

  if (eventType === "online") {
    await supabase
      .from("assets")
      .update({ router_online: true, router_status_at: now })
      .eq("id", matched.id);
    await supabase
      .from("alert_events")
      .update({ resolved_at: now })
      .eq("asset_id", matched.id)
      .eq("kind", "router_offline")
      .is("resolved_at", null);

    return json({ ok: true, handled: true, asset: matched.name, mode: matchMode, event: "online" });
  }

  // Other DM alert types (traffic, SIM switch, link backup, …) are logged but
  // not acted on yet.
  return json({ ok: true, handled: false, asset: matched.name, event: eventType });
});

// True if the asset name appears as a whole token in the gateway id/name.
// Asset names are distinctive (NM1006, CA1012, …), so a word-boundary match is
// safe and avoids "NM100" matching "NM1006".
function nameInHaystack(assetName: string, haystack: string): boolean {
  const esc = assetName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!esc) return false;
  return new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, "i").test(haystack);
}

// Recursively find the first value for any of `keys` (case-insensitive).
function extract(obj: unknown, keys: string[]): string | undefined {
  const want = keys.map((k) => k.toLowerCase());
  const seen = new Set<unknown>();
  const walk = (v: unknown): string | undefined => {
    if (!v || typeof v !== "object" || seen.has(v)) return undefined;
    seen.add(v);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (want.includes(k.toLowerCase()) && (typeof val === "string" || typeof val === "number")) {
        const s = String(val).trim();
        if (s) return s;
      }
    }
    for (const val of Object.values(v as Record<string, unknown>)) {
      const found = walk(val);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(obj);
}

// Normalize whatever DM sends into 'online' | 'offline' | other. Decide from
// the alertType field first (DM sends e.g. 'gateway_offline'/'gateway_online');
// only fall back to scanning the whole body if there's no alertType — otherwise
// a "back online after being offline" content sentence could misclassify.
function classify(eventRaw: string | undefined, rawText: string): string {
  const primary = (eventRaw ?? "").toLowerCase();
  if (primary) {
    if (/off\s*-?\s*line|disconnect|drop|down/.test(primary)) return "offline";
    if (/abnormal/.test(primary)) return primary; // flapping — not a clean recovery
    if (/on\s*-?\s*line|recover|reconnect|up\b/.test(primary)) return "online";
    return primary; // hourly_traffic_excess, sim_switch, link_backup, …
  }
  const hay = rawText.toLowerCase();
  if (/off\s*-?\s*line|disconnect/.test(hay)) return "offline";
  if (/on\s*-?\s*line|recover/.test(hay)) return "online";
  return "unknown";
}

// First top-level string value among `keys` (case-insensitive), for body-carried keys.
function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  const want = keys.map((k) => k.toLowerCase());
  for (const [k, v] of Object.entries(obj)) {
    if (want.includes(k.toLowerCase()) && typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function stripBearer(h: string | null | undefined): string | undefined {
  if (!h) return undefined;
  return h.replace(/^Bearer\s+/i, "").trim() || undefined;
}

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), {
    status: s,
    headers: { "Content-Type": "application/json" },
  });
}
