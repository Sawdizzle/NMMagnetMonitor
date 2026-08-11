import { Suspense } from "react";
import type { Metadata } from "next";
import Protected from "@/components/Protected";
import TvWall from "@/components/TvWall";

// Gated, chrome-free wall display. Requires a signed-in account with TV access
// (admins always qualify; viewers are granted it in the admin panel). Sign the
// wall TV in once with a remembered session and it stays. The public,
// unauthenticated version lives at /demo/tv (simulated data).
export const metadata: Metadata = {
  title: "Magnet Monitor — TV Display",
};

export default function TvPage() {
  return (
    <Protected requireTv>
      {() => (
        <Suspense fallback={null}>
          <TvWall />
        </Suspense>
      )}
    </Protected>
  );
}
