import type { Metadata } from "next";
import TvGated from "@/components/TvGated";

// Gated, chrome-free wall display. Requires a signed-in account with TV access
// (admins always qualify; viewers are granted it in the admin panel). Sign the
// wall TV in once with a remembered session and it stays. The public,
// unauthenticated version lives at /demo/tv (simulated data). The auth gate +
// Suspense live in TvGated (a client component) so this server page can still
// own the metadata below.
export const metadata: Metadata = {
  title: "Magnet Monitor — TV Display",
};

export default function TvPage() {
  return <TvGated />;
}
