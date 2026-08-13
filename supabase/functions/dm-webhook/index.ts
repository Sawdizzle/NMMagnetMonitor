import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Receiver for InHand Device Manager (DM) "Webhook Push" alert rules.
//
// DM sends a POST here whenever a gateway alert fires (fleet-wide Gateway
// Offline / Gateway Online rules → Webhook Push, URL carries ?key=<dm_webhook_key>).
//
// The point: DM detects the router's death CLOUD-SIDE (its heartbeat to DM
// stopped), independent of the Pi's telemetry link. We stamp assets.router_online
// from these events; it's shown as an INFORMATIONAL chip on the dashboard/asset
// page (iR305 up/down) so an operator can see why a unit is quiet. It never opens
// an alert_event — only the asset's own telemetry-offline emails/pushes.
//
// NOTE: not every asset is on an iR305. Unmapped assets keep router_online NULL.
// This webhook only ever touches assets it can positively match to a DM gateway.
//
// Every POST is logged verbatim to dm_webhook_events (incl. headers) for audit.
//
// AUTH: the shared key rides the URL (?key=), since DM does not transmit its own
// "Key" field on the wire. We also accept it in any header/body field as a
// fallback, compared to the stored dm_webhook_key.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

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

  // ---- verify the shared Key (URL ?key=, else any header/body) -----------
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

  // ---- parse (field names confirmed from a real DM push) -----------------
  const eventRaw = extract(payload, [
    "alertType", "alarmType", "eventType", "event", "type", "alert", "status", "state",
  ]);
  const deviceId = extract(payload, [
    "sn", "serialNumber", "serial", "deviceId", "device_id", "gatewayId",
    "gateway_id", "gwId", "deviceSn", "device_sn", "imei",
  ]);
  const deviceName = extract(payload, [
    "name", "gatewayName", "gateway_name", "deviceName", "device_name", "label", "alias",
  ]);
  const content = extract(payload, ["content", "message", "desc", "description"]);
  const eventType = classify(eventRaw, rawText);
  const matchKey = deviceId ?? deviceName; // stable id we persist as router_device_id
  const haystack = [deviceId, deviceName, content].filter(Boolean).join(" ").trim();

  // ---- match the gateway to one of our assets ----------------------------
  let matched: { id: string; name: string } | null = null;
  let matchMode = "none";
  if (haystack) {
    const candidates = [deviceId, deviceName].filter(Boolean) as string[];
    const { data: exactRows } = candidates.length
      ? await supabase.from("assets").select("id, name").in("router_device_id", candidates).limit(1)
      : { data: null };
    const exact = exactRows?.[0] ?? null;
    if (exact) {
      matched = exact;
      matchMode = "exact";
    } else {
      const { data: all } = await supabase.from("assets").select("id, name");
      matched = (all ?? []).find((a) => nameInHaystack(a.name, haystack)) ?? null;
      if (matched) {
        matchMode = "fuzzy";
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
    payload: { ...payload, _headers: headers },
    note,
  });

  if (!authed) return json({ ok: false, error: "unauthorized" }, 401);
  if (!matched) return json({ ok: true, handled: false, note });

  const now = new Date().toISOString();

  // ---- stamp router_online (informational status only) --------------------
  // Connectivity is shown as a chip on the dashboard/asset page — it never opens
  // an alert_event, so iR305 up/down never emails or pushes. Only the asset's own
  // telemetry-offline (evaluate_alerts) does.
  if (eventType === "offline" || eventType === "online") {
    await supabase
      .from("assets")
      .update({ router_online: eventType === "online", router_status_at: now })
      .eq("id", matched.id);
    return json({ ok: true, handled: true, asset: matched.name, mode: matchMode, event: eventType });
  }

  // Other DM alert types (traffic, SIM switch, link backup, …) are logged but
  // not acted on.
  return json({ ok: true, handled: false, asset: matched.name, event: eventType });
});

// True if the asset name appears as a whole token in the gateway id/name.
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

// Normalize whatever DM sends into 'online' | 'offline' | other. Decide from the
// alertType field first; fall back to scanning the body only if there's none.
function classify(eventRaw: string | undefined, rawText: string): string {
  const primary = (eventRaw ?? "").toLowerCase();
  if (primary) {
    if (/off\s*-?\s*line|disconnect|drop|down/.test(primary)) return "offline";
    if (/abnormal/.test(primary)) return primary; // flapping — not a clean recovery
    if (/on\s*-?\s*line|recover|reconnect|up\b/.test(primary)) return "online";
    return primary;
  }
  const hay = rawText.toLowerCase();
  if (/off\s*-?\s*line|disconnect/.test(hay)) return "offline";
  if (/on\s*-?\s*line|recover/.test(hay)) return "online";
  return "unknown";
}

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
