import type { MetadataRoute } from "next";
import { demoBrand } from "@/lib/brand";

// A neutral PWA manifest for the demo subtree, so installing /demo as an app
// never surfaces "Numed". The root app/manifest.ts keeps the real branding for
// the live app; the demo layout's metadata points at this route instead. Icons
// reuse the generated brand mark (an MRI scanner — no wordmark, already neutral).
const manifest: MetadataRoute.Manifest = {
  name: `${demoBrand.productName} — Live Demo`,
  short_name: demoBrand.productName,
  description: demoBrand.tagline,
  start_url: "/demo",
  display: "standalone",
  background_color: "#0a0d13",
  theme_color: "#0a0d13",
  icons: [
    { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/apple-icon", sizes: "180x180", type: "image/png", purpose: "maskable" },
  ],
};

export function GET() {
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json" },
  });
}
