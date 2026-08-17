"use client";

import { useMemo } from "react";
import { DemoContext, type DemoConfig } from "@/lib/demoContext";
import type { Brand } from "@/lib/brand";

/**
 * Supplies a brand that was resolved on the SERVER.
 *
 * OrgBrandProvider covers the signed-in app by reading the session. A wall
 * display has no session — it authenticates with a display token — so its brand
 * has to be resolved server-side from the token's org and handed down. Without
 * this, a white-labelled tenant's corridor TV shows the built-in product name.
 *
 * Nested inside OrgBrandProvider (root layout); the nearer provider wins.
 */
export default function BrandProvider({
  brand,
  children,
}: {
  brand: Brand;
  children: React.ReactNode;
}) {
  const value = useMemo<DemoConfig>(
    () => ({ demo: false, basePath: "", brand }),
    [brand]
  );
  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}
