import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { DISPLAY_COOKIE } from "@/lib/session";

// One-time activation for a wall-mounted screen:
//   https://…/tv/display?token=<display token>
//
// Open it once on the TV; it exchanges the token in the URL for a long-lived
// httpOnly cookie and redirects to /tv. The token never stays in the address
// bar afterwards, so it isn't sitting in browser history or on screen for
// anyone walking past.
//
// A year, because that is the point — a corridor screen should not drop to a
// login form because a 30-day session lapsed. Revoke it from the admin panel if
// the TV is moved or lost.
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) redirect("/tv?display=missing");

  const { data, error } = await supabaseAdmin.rpc("resolve_display_token", { p_token: token });
  const row = Array.isArray(data) ? data[0] : data;
  // A revoked or unknown token must not silently fall through to the normal
  // login gate — say so, or a screen that has been revoked looks like a bug.
  if (error || !row) redirect("/tv?display=invalid");

  (await cookies()).set({
    name: DISPLAY_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });

  redirect("/tv");
}
