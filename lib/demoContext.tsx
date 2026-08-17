"use client";

import { createContext, useContext } from "react";
import { type Brand, realBrand, demoBrand } from "./brand";

// Demo mode is carried through the tree by context rather than a global flag so
// the live app and the /demo tree can render the same components side by side.
// Everything a component needs to behave correctly in either mode is here:
//   - demo:     are we in the demo environment? (drives the data source + UI)
//   - basePath: prefix for internal links ("" live, "/demo" in the demo tree)
//   - brand:    the resolved brand strings for this mode
export type DemoConfig = {
  demo: boolean;
  basePath: string;
  brand: Brand;
};

// Default is the live app. Real pages don't wrap in a provider, so useDemo()
// outside the demo tree resolves to this — live branding, no /demo prefix.
const DEFAULT: DemoConfig = { demo: false, basePath: "", brand: realBrand };

// Exported so the live app can supply the active org's brand through the same
// context the components already read (components/OrgBrandProvider.tsx).
export const DemoContext = createContext<DemoConfig>(DEFAULT);

export function DemoProvider({ children }: { children: React.ReactNode }) {
  return (
    <DemoContext.Provider value={{ demo: true, basePath: "/demo", brand: demoBrand }}>
      {children}
    </DemoContext.Provider>
  );
}

export function useDemo(): DemoConfig {
  return useContext(DemoContext);
}
