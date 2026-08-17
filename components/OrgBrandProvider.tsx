"use client";

import { useMemo } from "react";
import { DemoContext, type DemoConfig } from "@/lib/demoContext";
import { realBrand } from "@/lib/brand";
import { useAuth } from "@/lib/auth";

/**
 * Supplies the ACTIVE ORG's brand to the live app.
 *
 * Phase 0 moved product_name / eyebrow / tagline onto `orgs` so a company could
 * be turned up without a deploy, but nothing read them — the eyebrow said
 * "NUMED · REMOTE MONITORING" even while viewing Demo Company. The brand now
 * rides along with the session (resolve_session returns it), and this hands it
 * to the same DemoContext the components already read, so no component changed.
 *
 * Falls back to realBrand when signed out or when the session has no active org,
 * which keeps the login screen looking like itself.
 *
 * Deliberately wraps INSIDE AuthProvider and OUTSIDE the /demo tree: DemoShell
 * nests its own DemoProvider, and the nearer provider wins, so /demo keeps its
 * neutral white-label identity regardless of who is signed in.
 */
export default function OrgBrandProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();

  const value = useMemo<DemoConfig>(
    () => ({
      demo: false,
      basePath: "",
      brand: session?.brand ?? realBrand,
    }),
    [session?.brand]
  );

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}
