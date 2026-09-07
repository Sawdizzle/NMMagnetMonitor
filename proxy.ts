import { NextResponse, type NextRequest } from "next/server";

// The Content-Security-Policy, built per request because it carries a nonce.
//
// Next 16 calls this file `proxy.ts`, not `middleware.ts` — see
// node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md,
// which is also where the nonce pattern below comes from.
//
// A nonce is worth the extra machinery here rather than settling for
// `script-src 'unsafe-inline'`. Next injects inline scripts to carry the RSC
// payload, so a policy without either a nonce or 'unsafe-inline' would blank
// the app; but 'unsafe-inline' permits ANY inline script, which is most of what
// a CSP is for. Nonces need dynamic rendering, and every HTML route in this app
// is already dynamic (the only static outputs are the two icons and the
// manifest, which carry no scripts), so the requirement costs nothing.
//
// `strict-dynamic` means 'self' is ignored for scripts: only a script carrying
// this request's nonce runs, plus whatever that script loads. Next stamps the
// nonce onto its own tags when it sees this header.

/**
 * Where the browser is allowed to reach Supabase.
 *
 * Two things still go straight from the browser to the database rather than
 * through this app's own routes: PushToggle saves and deletes a push
 * subscription, and a white-labelled company's logo is an <img> served from
 * Storage. Everything else was moved behind /api during the multi-tenant
 * cutover, which is why this is the only external origin in connect-src.
 */
const SUPABASE_ORIGIN = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin;
  } catch {
    // Missing at build time in a bare checkout. Better to emit a policy that
    // simply has no Supabase origin than to crash every request.
    return "";
  }
})();

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  const csp = [
    "default-src 'self'",
    // 'unsafe-eval' in development only: React uses eval to rebuild
    // server-side error stacks in the browser. Neither React nor Next needs it
    // in production.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Styles keep 'unsafe-inline' and take NO nonce, deliberately. The fleet
    // cards colour themselves through inline style attributes — the status rail
    // and every severity tint are `style={{ "--sc": ... }}` — and a nonce would
    // make the browser ignore 'unsafe-inline' and blank all of it. Inline
    // styles are a far smaller risk than inline scripts, and this is the
    // trade that keeps the app looking like itself.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    // data: and blob: are load-bearing: the org mark falls back to an inline
    // SVG, and generated collector scripts are downloaded through a blob URL.
    `img-src 'self' data: blob:${SUPABASE_ORIGIN ? " " + SUPABASE_ORIGIN : ""}`,
    `connect-src 'self'${SUPABASE_ORIGIN ? " " + SUPABASE_ORIGIN : ""}`,
    // The push notification service worker.
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  // Set on the REQUEST so Next can read it and stamp the nonce onto its own
  // script tags, and on the RESPONSE so the browser enforces it.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Skip the static asset paths. They are served straight from disk, carry no
  // scripts, and generating a nonce for each one would be pure overhead on the
  // busiest requests the app serves.
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|sw\\.js).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
