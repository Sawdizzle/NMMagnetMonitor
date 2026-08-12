import type { CSSProperties } from "react";

/**
 * The Magnet Monitor brand mark: an MRI scanner — the rounded gantry face with
 * its cylindrical bore (the superconducting magnet we actually monitor) — with
 * a live pulse tracing across the bore (that we're watching it).
 *
 * Built entirely from FILLED shapes — no stroke-only paths. next/og's satori
 * renderer (used by app/icon.tsx and app/apple-icon.tsx) does not reliably
 * rasterize stroked paths and renders them as an empty/black tile, so every
 * element carries a `fill`. The bore is an evenodd cut-out (transparent), so it
 * shows whatever dark surface sits behind it. The same markup renders
 * identically in the browser DOM for the header, keeping one source of truth.
 *
 * `bleed` swaps the rounded gantry face for a full-viewBox teal square (bore
 * still punched out). Used by the app-icon routes so the mark fills the tile
 * edge-to-edge and the platform's own icon mask supplies the corner rounding —
 * no dark "safe-area" border, and no dark corner slivers from mismatched radii.
 */
export default function BrandMark({
  size = 24,
  body = "#22d3ee", // --accent (scanner gantry)
  pulse = "#4ade80", // --status-online (live signal)
  bleed = false,
  style,
}: {
  size?: number | string;
  body?: string;
  pulse?: string;
  bleed?: boolean;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={style}
    >
      {/* MRI gantry face — the teal runs edge-to-edge, with the bore cut out
          (evenodd → transparent bore). Non-bleed keeps rounded corners for the
          in-DOM header/tiles; bleed is a full square so the OS icon mask
          supplies the corner rounding. Both share the same centered bore. */}
      <path
        fill={body}
        fillRule="evenodd"
        d={
          (bleed
            ? "M0 0 H24 V24 H0 Z"
            : "M5 0 H19 A5 5 0 0 1 24 5 V19 A5 5 0 0 1 19 24 H5 A5 5 0 0 1 0 19 V5 A5 5 0 0 1 5 0 Z") +
          " M18.5 12 A6.5 6.5 0 1 0 5.5 12 A6.5 6.5 0 1 0 18.5 12 Z"
        }
      />
      {/* live monitoring pulse — a tidy EKG trace centered in the bore. */}
      <path
        fill={pulse}
        d="M7.6 11.45 L9.8 11.45 L10.6 9.85 L11.5 13.25 L12.3 11.45 L16.4 11.45 L16.4 12.55 L12.3 12.55 L11.5 14.35 L10.6 10.95 L9.8 12.55 L7.6 12.55 Z"
      />
    </svg>
  );
}
