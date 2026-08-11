import { Suspense } from "react";
import type { Metadata } from "next";
import TvWall from "@/components/TvWall";

// Public, chrome-free wall display. No auth gate: it reads the same
// anon-readable fleet views as the dashboard, so a service-center TV can be
// pointed here and left running (see components/TvWall.tsx for URL options).
export const metadata: Metadata = {
  title: "Magnet Monitor — TV Display",
};

export default function TvPage() {
  return (
    <Suspense fallback={null}>
      <TvWall />
    </Suspense>
  );
}
