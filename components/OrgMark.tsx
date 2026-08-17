"use client";

import type { CSSProperties } from "react";
import { useDemo } from "@/lib/demoContext";
import BrandMark from "./BrandMark";

/**
 * The mark for whichever company is being viewed: their uploaded logo if they
 * have one, otherwise the built-in MRI BrandMark.
 *
 * Exists so the fallback lives in ONE place. The alternative — `brand.logoUrl ?
 * <img/> : <BrandMark/>` at each of the three call sites — is the shape that
 * rots: a fourth surface gets added later with only half the branch, and one
 * screen keeps showing the Numed mark for a white-labelled tenant.
 *
 * Reads the logo from the same DemoContext that already carries the brand
 * strings, so it is correct on all three paths without being passed anything:
 * the signed-in app (OrgBrandProvider, from the session), a wall display
 * (BrandProvider, from orgBrand()), and /demo (DemoShell, which has no logo and
 * so keeps the neutral built-in mark).
 *
 * NOT used by app/icon.tsx or app/apple-icon.tsx. Those are next/og routes that
 * rasterize a single global favicon/app icon — there is one manifest for the
 * whole deployment, so there is no per-tenant icon to generate. They keep
 * BrandMark directly.
 */
export default function OrgMark({
  size = 24,
  bleed = false,
  style,
}: {
  size?: number | string;
  bleed?: boolean;
  style?: CSSProperties;
}) {
  const { brand } = useDemo();
  const logoUrl = brand.logoUrl;

  if (!logoUrl) return <BrandMark size={size} bleed={bleed} style={style} />;

  return (
    // Plain <img>, not next/image, deliberately. The mark renders at 24-48px
    // from a stable, cacheable URL on Supabase's CDN, so the optimizer would
    // add a per-deployment remotePatterns entry and metered image-optimization
    // requests to save a single cached fetch. Not worth it at this size.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logoUrl}
      alt=""
      aria-hidden="true"
      width={typeof size === "number" ? size : undefined}
      height={typeof size === "number" ? size : undefined}
      style={{
        width: typeof size === "number" ? `${size}px` : size,
        height: typeof size === "number" ? `${size}px` : size,
        // contain, not cover: a logo is not a photo. Cropping a wordmark to fill
        // a square is how you lose half a company's name.
        objectFit: "contain",
        ...style,
      }}
    />
  );
}
