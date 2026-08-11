// Brand strings are resolved per-render from the demo context (see
// lib/demoContext.tsx) so the same components render Numed's real branding on
// the live app and a neutral, white-label identity under /demo. The point of
// demo mode is to redact anything Numed-specific, so the demo brand carries no
// company name — it reads as a product a prospect could adopt as their own.

export type Brand = {
  // The product name shown in the nav and dashboard heading. Descriptive, not
  // company-specific, so it is safe to show in both modes.
  productName: string;
  // Small uppercase eyebrow above the dashboard/login heading.
  eyebrow: string;
  // One-line description used in docs intro copy and metadata.
  tagline: string;
};

export const realBrand: Brand = {
  productName: "Magnet Monitor",
  eyebrow: "Numed · Remote Monitoring",
  tagline: "Remote monitoring for GE MagMon magnet monitors",
};

export const demoBrand: Brand = {
  productName: "Magnet Monitor",
  eyebrow: "Live Demo · Remote Monitoring",
  tagline: "Remote monitoring for cryogen-cooled magnet systems",
};
