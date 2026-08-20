"use client";

import { useState } from "react";
import { adminSetSiteGeocode, adminClearSiteGeocode, type SiteGeocodeRow } from "@/lib/adminActions";
import { friendlyErrorMessage } from "@/lib/errors";

// Where one unit sits on the map, and how to correct it.
//
// Coordinates are keyed by ADDRESS, not by asset — so this line is shared by
// every unit at the same address, and the wording says so rather than letting
// someone pin Denton and wonder why the other four units moved too.
//
// Self-contained on purpose: AssetsTab already drills forty props, and a
// location editor that owns its own two fields does not need to add eight more.

export default function SiteLocationRow({
  assetId,
  address,
  geocode,
  siblingCount,
  onChanged,
}: {
  assetId: string;
  address: string | null;
  geocode: SiteGeocodeRow | undefined;
  /** How many other units share this address; drives the shared-edit warning. */
  siblingCount: number;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // No address means nothing to resolve. Say that instead of offering an
  // override that admin_set_site_geocode would refuse anyway.
  if (!address?.trim()) {
    return <p className="text-[11px] text-[var(--text-dim)] mt-0.5">No site address — no weather</p>;
  }

  const pinned = geocode?.source === "manual";
  const placed = geocode?.latitude != null && geocode.longitude != null;

  const state = !geocode
    ? "Location not looked up yet"
    : placed
      ? `${geocode.latitude!.toFixed(4)}, ${geocode.longitude!.toFixed(4)} · ${pinned ? "pinned by hand" : "found automatically"}`
      : pinned
        ? "Pinned as having no weather"
        : `Could not be placed automatically${geocode.attempts ? ` (${geocode.attempts} ${geocode.attempts === 1 ? "try" : "tries"})` : ""} — pin it by hand`;

  async function save(clear: boolean) {
    setBusy(true);
    setError(null);
    const res = clear
      ? await adminClearSiteGeocode(assetId)
      : await adminSetSiteGeocode({
          assetId,
          address: address!,
          // Blank fields are a deliberate "no weather here", not a no-op —
          // that is what stops the geocoder retrying a site that has none.
          latitude: lat.trim() === "" ? null : Number(lat),
          longitude: lon.trim() === "" ? null : Number(lon),
        });
    setBusy(false);
    if (res.error) {
      setError(friendlyErrorMessage(res.error));
      return;
    }
    setEditing(false);
    setLat("");
    setLon("");
    onChanged();
  }

  const invalid =
    (lat.trim() === "") !== (lon.trim() === "") ||
    (lat.trim() !== "" && !Number.isFinite(Number(lat))) ||
    (lon.trim() !== "" && !Number.isFinite(Number(lon)));

  return (
    <div className="mt-0.5">
      <p className="text-[11px] text-[var(--text-dim)] flex flex-wrap items-center gap-x-2 gap-y-1">
        <span style={!placed && geocode ? { color: "var(--status-warning)" } : undefined}>{state}</span>
        {!editing && (
          <>
            <button
              onClick={() => {
                setLat(geocode?.latitude?.toString() ?? "");
                setLon(geocode?.longitude?.toString() ?? "");
                setEditing(true);
              }}
              className="underline underline-offset-2 hover:text-[var(--text)]"
            >
              {placed ? "Change" : "Set location"}
            </button>
            {geocode && (
              <button
                onClick={() => save(true)}
                disabled={busy}
                className="underline underline-offset-2 hover:text-[var(--text)]"
                title="Forget the stored position and look the address up again"
              >
                Look up again
              </button>
            )}
          </>
        )}
      </p>

      {editing && (
        <div className="mt-2 rounded-lg border border-[var(--border-soft)] bg-[var(--card)] p-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-[10px] uppercase tracking-wide text-[var(--text-dim)]">
              Latitude
              <input
                className="input mt-1 w-32"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                placeholder="33.2251"
                inputMode="decimal"
              />
            </label>
            <label className="text-[10px] uppercase tracking-wide text-[var(--text-dim)]">
              Longitude
              <input
                className="input mt-1 w-32"
                value={lon}
                onChange={(e) => setLon(e.target.value)}
                placeholder="-97.1972"
                inputMode="decimal"
              />
            </label>
            <button onClick={() => save(false)} disabled={busy || invalid} className="btn-primary">
              {busy ? "Saving…" : "Save"}
            </button>
            <button onClick={() => { setEditing(false); setError(null); }} className="btn-secondary">
              Cancel
            </button>
          </div>

          <p className="text-[11px] text-[var(--text-dim)] mt-2">
            Decimal degrees — negative longitude for the US. Leave both blank to mark this site as
            having no weather, which also stops it being looked up again.
            {siblingCount > 0 &&
              ` This address is shared with ${siblingCount} other ${siblingCount === 1 ? "unit" : "units"}, which will move too.`}
          </p>
          {error && <p className="text-[11px] mt-2" style={{ color: "var(--status-offline)" }}>{error}</p>}
        </div>
      )}

      {!editing && error && (
        <p className="text-[11px] mt-1" style={{ color: "var(--status-offline)" }}>{error}</p>
      )}
    </div>
  );
}
