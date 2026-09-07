import type { NextConfig } from "next";

// Response headers that do not vary per request.
//
// The Content-Security-Policy is NOT here — it carries a per-request nonce and
// so has to be built in proxy.ts. Everything below is constant, and a constant
// header belongs in the config where it can be read at a glance rather than
// recomputed on every request.
//
// Added after a 2026-09-06 audit found the app sending none of these: no HSTS,
// no framing rule, no referrer policy. Nothing was leaking — authorization is
// enforced server-side and in the database throughout — but the admin panel and
// every tenant dashboard were freely embeddable in a third-party frame, and
// this is the layer a hospital's security review asks about first.
const SECURITY_HEADERS = [
  {
    // Two years, subdomains included, and preload-eligible. Safe here because
    // the app is https-only in production; the cookie is already `secure`.
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    // The legacy companion to frame-ancestors, for anything that predates CSP.
    // Both say the same thing: this app is never framed. A wall display is
    // opened full-screen on the screen itself, not embedded in someone's
    // portal, so there is no case to keep open.
    key: "X-Frame-Options",
    value: "DENY",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  {
    // Send the origin cross-site, the full path same-site. Asset pages carry a
    // unit's uuid in the URL and there is no reason for that to travel to
    // raspberrypi.com because someone followed a link out of the runbook.
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    // Nothing here needs any of these. Denying them outright means a future
    // dependency cannot quietly start asking.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  // The version banner is free reconnaissance and buys nothing.
  poweredByHeader: false,

  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
