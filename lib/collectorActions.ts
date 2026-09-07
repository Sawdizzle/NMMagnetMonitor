"use server";

// Building the collector scripts, on the server.
//
// The admin panel used to import lib/piScript directly. That file is 62 kB
// whose bulk is the Python collector itself, held as template strings — and
// because the panel is a client component, the whole generator was bundled and
// shipped to every admin's browser (it appeared in two chunks, 88 kB and
// 144 kB). The browser needs the finished FILE, never the machine that makes
// it.
//
// Authorization is unchanged and still lives in the database: every function
// here goes through adminGetAssetConfig, which is admin_get_asset_config
// resolving the actor and their org through _admin_actor(). If that returns a
// row, the caller is an admin for that exact asset — so reading the asset's
// name and modality afterwards needs no second check.
//
// Zipping deliberately stayed on the client. lib/zip.ts is 107 lines with no
// dependencies, so moving it would save nothing and would force a megabyte of
// archive back through the action boundary as base64.

import { supabaseAdmin } from "./supabaseServer";
import { adminGetAssetConfig, type AdminResult } from "./adminActions";
import { generatePiScript, generateEnvPiScript, generateSystemdUnit } from "./piScript";
import { usesMagmon } from "./modality";
import { activeOrgId } from "./session";

export type CollectorVariant = "magmon" | "env";

export type BuiltScript = {
  script: string;
  unit: string;
  variant: CollectorVariant;
  /** The OS user the files were built for — the panel echoes this back into
   *  its own field so the .py and the unit cannot disagree about User=. */
  serviceUser: string;
  /** Filename stem, so a site running both collectors cannot install one over
   *  the other. Named here because the naming rule belongs with the builder. */
  stem: string;
};

/** What the generators need beyond the asset's own row. */
type Shared = {
  assetName: string;
  gatewayToken: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  intervalMinutes: number;
  serviceUser: string;
};

function env() {
  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  };
}

function render(
  shared: Shared,
  modality: string | null,
  cfg: { monitor_host: string | null; monitor_port: number; monitor_username: string; monitor_password: string },
  variant: CollectorVariant
): { script: string; unit: string; stem: string } {
  const script =
    variant === "env"
      ? generateEnvPiScript({
          ...shared,
          // A magnet that also carries env hardware gets a script that says so:
          // the header is the install instructions a tech reads on the Pi, and
          // on a mixed unit it has to mention the MagMon collector running
          // beside it rather than claim to be the only thing on the box.
          modality: modality ?? "",
          alongsideMagmon: usesMagmon(modality),
        })
      : generatePiScript({
          ...shared,
          monitorHost: cfg.monitor_host ?? "",
          monitorPort: cfg.monitor_port ?? 80,
          monitorUsername: cfg.monitor_username ?? "MMService",
          monitorPassword: cfg.monitor_password ?? "MagnetMonitor",
        });
  return {
    script,
    unit: generateSystemdUnit({ assetName: shared.assetName, serviceUser: shared.serviceUser, variant }),
    stem: variant === "env" ? "nm-env-gateway" : "nm-magmon-gateway",
  };
}

/** Name, modality and service user for assets the caller's org owns. */
async function assetRows(ids?: string[]) {
  const orgId = await activeOrgId();
  if (!orgId) return [];
  let q = supabaseAdmin
    .from("assets")
    .select("id, name, modality, service_user")
    .eq("org_id", orgId)
    .order("name");
  if (ids) q = q.in("id", ids);
  const { data } = await q;
  return (data ?? []) as { id: string; name: string; modality: string | null; service_user: string | null }[];
}

/**
 * One asset's install script and systemd unit.
 *
 * Returns BOTH files rather than one, because they are only ever wanted
 * together and generating them in separate calls is how a unit file ends up
 * built for a different service user than the script beside it.
 */
export async function adminBuildScript(
  assetId: string,
  opts: { intervalMinutes: number; serviceUser?: string; variant?: CollectorVariant }
): Promise<AdminResult<BuiltScript>> {
  const { data, error } = await adminGetAssetConfig(assetId);
  const cfg = data && data[0];
  if (error || !cfg) return { data: null, error: error ?? { message: "Asset config not found." } };

  const asset = (await assetRows([assetId]))[0];
  if (!asset) return { data: null, error: { message: "Asset not found." } };

  // Modality WINS over an explicit request, which is the original precedence
  // and worth keeping: a unit with no MagMon has nothing for that collector to
  // scrape, so asking for one would produce a script that could never connect.
  // A mixed unit is the case `variant` exists for — it says "give me the env
  // collector as well", never "pretend this trailer has a magnet".
  const variant: CollectorVariant =
    opts.variant === "env" || !usesMagmon(asset.modality) ? "env" : "magmon";

  // monitor_host is nullable, and the MagMon collector needs it to reach the
  // device. A null used to flow straight into the template and produce a script
  // that could never connect; say so instead. An environmental asset is
  // SUPPOSED to have no monitor host, so the check applies only to MagMons.
  if (variant === "magmon" && !cfg.monitor_host) {
    return {
      data: null,
      error: {
        message: `"${asset.name}" has no monitor host set. Edit the asset and add the MagMon's address before generating a script.`,
      },
    };
  }

  const serviceUser = opts.serviceUser || asset.service_user || "pi";
  const built = render(
    { assetName: asset.name, gatewayToken: cfg.gateway_token, ...env(), intervalMinutes: opts.intervalMinutes, serviceUser },
    asset.modality,
    cfg,
    variant
  );
  return { data: { ...built, variant, serviceUser }, error: null };
}

export type BundledFile = { name: string; content: string };

/**
 * Every asset's script and unit, for re-imaging a fleet in one go.
 *
 * This used to be one adminGetAssetConfig round trip PER ASSET from the
 * browser, then generation and zipping client-side — seventeen sequential
 * authorizations to build one archive. It is now a single call; the client
 * still does the zipping, which is 107 dependency-free lines.
 */
export async function adminBuildAllScripts(opts: {
  intervalMinutes: number;
}): Promise<AdminResult<{ files: BundledFile[]; skipped: string[] }>> {
  const assets = await assetRows();
  if (assets.length === 0) return { data: { files: [], skipped: [] }, error: null };

  const files: BundledFile[] = [];
  const skipped: string[] = [];

  for (const a of assets) {
    const { data, error } = await adminGetAssetConfig(a.id);
    const cfg = data && data[0];
    if (error || !cfg) {
      skipped.push(a.name);
      continue;
    }
    const variant: CollectorVariant = usesMagmon(a.modality) ? "magmon" : "env";
    // No monitor host = the MagMon script could never reach the device, so
    // count it as a failure rather than emitting a broken file. An
    // environmental asset has no monitor host by design and is exempt.
    if (variant === "magmon" && !cfg.monitor_host) {
      skipped.push(a.name);
      continue;
    }
    const serviceUser = a.service_user || "pi";
    const built = render(
      { assetName: a.name, gatewayToken: cfg.gateway_token, ...env(), intervalMinutes: opts.intervalMinutes, serviceUser },
      a.modality,
      cfg,
      variant
    );
    files.push({ name: `${a.name}/${built.stem}-${a.name}.py`, content: built.script });
    files.push({ name: `${a.name}/${built.stem}-${a.name}.service`, content: built.unit });
  }

  return { data: { files, skipped }, error: null };
}
