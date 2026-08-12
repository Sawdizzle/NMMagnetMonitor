import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// One-off: generate a VAPID keypair (Web Crypto, P-256) and store it in
// app_settings (vapid_public / vapid_private — server-only, no public policy).
// Idempotent: returns the existing public key if keys are already present, so
// re-invoking never rotates them. The private key never leaves the server; the
// public key is safe to embed in the client (it's the applicationServerKey).
const b64url = (u8: Uint8Array) =>
  btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: existing } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "vapid_public")
    .maybeSingle();
  if (existing?.value) return json({ publicKey: existing.value, existed: true });

  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)); // 65B 0x04||X||Y
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const publicKey = b64url(rawPub);
  const privateKey = jwk.d as string; // base64url 32-byte scalar — VAPID private

  const { error } = await supabase.from("app_settings").upsert([
    { key: "vapid_public", value: publicKey },
    { key: "vapid_private", value: privateKey },
  ]);
  if (error) return json({ error: error.message }, 500);
  return json({ publicKey, existed: false });
});

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
}
