import type { Metadata } from "next";
import { Suspense } from "react";
import TvGated from "@/components/TvGated";
import TvWall from "@/components/TvWall";
import { getDisplayScope } from "@/lib/session";

// Chrome-free wall display. Two ways in:
//
//   * a signed-in account with TV access (admins always qualify), or
//   * a DISPLAY TOKEN — activate once via /tv/display?token=…, which swaps it
//     for a year-long httpOnly cookie.
//
// The token path exists because a corridor TV used to run on a human's 30-day
// session: it carried that person's identity and access, and dropped to a login
// form when it lapsed, with nobody watching. A display token is read-only,
// bound to one org, and revocable from the admin panel.
//
// The public simulated version is still /demo/tv.
export const metadata: Metadata = {
  title: "Magnet Monitor — TV Display",
};

export default async function TvPage({
  searchParams,
}: {
  searchParams: Promise<{ display?: string }>;
}) {
  const display = await getDisplayScope();
  const { display: activation } = await searchParams;

  // A valid display cookie renders the wall directly — no auth gate, because
  // the token IS the credential and /api/fleet accepts it.
  if (display) {
    return (
      <Suspense fallback={null}>
        <TvWall />
      </Suspense>
    );
  }

  // A revoked or unknown display link must not silently become a login form —
  // someone standing at a wall TV needs to know the link is dead, not wonder
  // why the screen is asking for a PIN.
  return (
    <>
      {activation && (
        <div
          role="status"
          className="px-4 py-2 text-sm text-center"
          style={{ background: "var(--card)", color: "var(--status-offline)" }}
        >
          {activation === "invalid"
            ? "That display link is no longer valid — it was revoked, or the address was mistyped. Create a new one in Admin → Displays."
            : "No display link was provided. Open the full link from Admin → Displays."}
        </div>
      )}
      <TvGated />
    </>
  );
}
