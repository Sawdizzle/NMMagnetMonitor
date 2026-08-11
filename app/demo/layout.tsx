import type { Metadata } from "next";
import DemoShell from "@/components/DemoShell";
import { demoBrand } from "@/lib/brand";

// Neutral metadata for the demo tree — no "Numed" in the tab title. The root
// layout still owns <html>/<body> and the AuthProvider; this only reskins the
// /demo subtree and wraps it in the demo chrome.
export const metadata: Metadata = {
  title: `${demoBrand.productName} — Live Demo`,
  description: demoBrand.tagline,
  // Override the root manifest so a PWA install from /demo stays neutral.
  manifest: "/demo/manifest.webmanifest",
};

export default function DemoLayout({ children }: { children: React.ReactNode }) {
  return <DemoShell>{children}</DemoShell>;
}
