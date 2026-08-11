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
  size?: number;
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
      {/* MRI gantry face with the bore cut out (evenodd → transparent bore).
          bleed: full-tile square instead of the rounded gantry — the OS icon
          mask rounds the corners. */}
      <path
        fill={body}
        fillRule="evenodd"
        d={
          bleed
            ? "M0 0 H24 V24 H0 Z M18.21 11.5 A6.21 6.21 0 1 0 5.79 11.5 A6.21 6.21 0 1 0 18.21 11.5 Z"
            : "M7.5 2 H16.5 A5 5 0 0 1 21.5 7 V16 A5 5 0 0 1 16.5 21 H7.5 A5 5 0 0 1 2.5 16 V7 A5 5 0 0 1 7.5 2 Z M17.4 11.5 A5.4 5.4 0 1 0 6.6 11.5 A5.4 5.4 0 1 0 17.4 11.5 Z"
        }
      />
      {/* live monitoring pulse across the bore. bleed scales the bore + pulse
          up ~15% (about their shared center 12,11.5) so the inner mark isn't
          dwarfed once the teal runs edge-to-edge. */}
      <path
        fill={pulse}
        d={
          bleed
            ? "M6.25 10.81 L9.01 10.81 L10.16 8.63 L11.54 13.46 L12.69 10.81 L17.75 10.81 L17.75 12.19 L12.69 12.19 L11.54 14.84 L10.16 10.01 L9.01 12.19 L6.25 12.19 Z"
            : "M7 10.9 L9.4 10.9 L10.4 9 L11.6 13.2 L12.6 10.9 L17 10.9 L17 12.1 L12.6 12.1 L11.6 14.4 L10.4 10.2 L9.4 12.1 L7 12.1 Z"
        }
      />
    </svg>
  );
}
