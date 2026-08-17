import "server-only";

import { viewingDemoTenant } from "@/lib/session";

/**
 * Persistent "this is demo data" bar for the SIGNED-IN app.
 *
 * The public /demo tree has carried a banner since it existed (DemoShell), but
 * the demo company is also an ordinary tenant you can sign into and switch to,
 * and there it rendered with the same chrome as a real fleet: MM-1001 at
 * "Riverbend Imaging Center" looks exactly like NM1003 at a real site. On a
 * screen-share, a screenshot or a wall display that is a genuine hazard —
 * someone reads an invented helium level as a magnet they own.
 *
 * A SERVER component on purpose. The obvious alternative — a flag on the client
 * session — is wrong here: that session is an optimistic localStorage copy that
 * lags an org switch by a round-trip, so switching into the demo would paint
 * simulated data with no banner for as long as the reconcile takes. This
 * renders from the cookie the server just resolved, so the banner and the data
 * can never disagree.
 *
 * Renders nothing (not even a wrapper) for production tenants and signed-out
 * visitors, so the real app is untouched.
 */
export default async function DemoTenantBanner() {
  if (!(await viewingDemoTenant())) return null;

  return (
    <div className="demo-banner print-hide" role="note">
      <span className="demo-badge" aria-hidden="true">
        <span className="cd" />
        Demo
      </span>
      <span>
        <strong>Demo Company — for demonstration only.</strong> Every unit, site and reading
        below is simulated. Nothing here is a production asset, and its alerts are never
        emailed or pushed to anyone.
      </span>
    </div>
  );
}
