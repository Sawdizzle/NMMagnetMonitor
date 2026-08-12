"use client";

// "Enable push" control for the dashboard. Registers the service worker, asks
// for notification permission, subscribes via the browser Push API using the
// server's VAPID public key, and stores the subscription. One device at a time;
// the button reflects this device's state. Hidden where push isn't supported.
//
// iOS note: web push only works when the app is installed to the Home Screen
// (iOS 16.4+), not in a Safari tab — that's an Apple restriction, not a bug.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";

type PushState = "loading" | "unsupported" | "default" | "denied" | "subscribed";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  // Back the view with a concrete ArrayBuffer so it types as Uint8Array<ArrayBuffer>,
  // which applicationServerKey (BufferSource) accepts — a bare Uint8Array is
  // Uint8Array<ArrayBufferLike> under TS 5.7+ and is rejected.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export default function PushToggle() {
  const { session } = useAuth();
  const [state, setState] = useState<PushState>("loading");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  const refresh = useCallback(async () => {
    if (!supported) return setState("unsupported");
    if (Notification.permission === "denied") return setState("denied");
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      setState(sub ? "subscribed" : "default");
    } catch {
      setState("default");
    }
  }, [supported]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const enable = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "denied" : "default");
        setMsg("Notifications weren’t allowed.");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const { data: vapid, error } = await supabase.rpc("get_vapid_public_key");
      if (error || !vapid) {
        setMsg("Push isn’t configured on the server yet.");
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid as string),
      });
      const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      const { error: saveErr } = await supabase.rpc("save_push_subscription", {
        p_endpoint: j.endpoint,
        p_p256dh: j.keys.p256dh,
        p_auth: j.keys.auth,
        p_username: session?.username ?? null,
        p_user_agent: navigator.userAgent,
      });
      if (saveErr) {
        setMsg("Couldn’t save the subscription.");
        return;
      }
      setState("subscribed");
      setMsg("Push enabled on this device.");
    } catch {
      setMsg("Couldn’t enable push on this device.");
    } finally {
      setBusy(false);
    }
  }, [session]);

  const disable = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await supabase.rpc("delete_push_subscription", { p_endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setState("default");
      setMsg("Push disabled on this device.");
    } catch {
      setMsg("Couldn’t disable push.");
    } finally {
      setBusy(false);
    }
  }, []);

  if (state === "unsupported" || state === "loading") return null;

  const bell = (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M10 19a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );

  return (
    <span className="inline-flex items-center gap-2">
      {state === "denied" ? (
        <span className="text-xs text-[var(--text-dim)]" title="Allow notifications for this site in your browser settings to enable push.">
          Push blocked
        </span>
      ) : state === "subscribed" ? (
        <button
          type="button"
          onClick={disable}
          disabled={busy}
          className="btn-secondary inline-flex items-center gap-1.5 shrink-0"
          style={{ color: "var(--status-online)" }}
          title="Alerts push to this device — click to turn off"
        >
          {bell}
          {busy ? "…" : "Push on"}
        </button>
      ) : (
        <button
          type="button"
          onClick={enable}
          disabled={busy}
          className="btn-secondary inline-flex items-center gap-1.5 shrink-0"
          title="Get alert notifications on this device"
        >
          {bell}
          {busy ? "Enabling…" : "Enable push"}
        </button>
      )}
      {msg && <span className="text-xs text-[var(--text-dim)] hidden sm:inline">{msg}</span>}
    </span>
  );
}
