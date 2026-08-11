"use client";

import Link from "next/link";
import { DemoProvider } from "@/lib/demoContext";
import AppNav from "@/components/AppNav";

// Chrome shared by every /demo page: it turns on demo mode for the subtree
// (DemoProvider → fixtures + neutral brand + /demo link prefixing), renders the
// demo-flavored nav, and shows a persistent banner so a screen-share or
// screenshot is unmistakably a demo. No auth gate — /demo is public.
export default function DemoShell({ children }: { children: React.ReactNode }) {
  return (
    <DemoProvider>
      <AppNav />
      <div className="demo-banner print-hide" role="note">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
          <path d="M12 11v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="12" cy="7.75" r="1" fill="currentColor" />
        </svg>
        <span>
          You&rsquo;re viewing a live demo with simulated data — no real sites or telemetry.{" "}
          <Link href="/" className="demo-banner-cta">
            Exit demo →
          </Link>
        </span>
      </div>
      {children}
    </DemoProvider>
  );
}
