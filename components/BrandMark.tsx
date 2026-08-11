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
 */
export default function BrandMark({
  size = 24,
  body = "#22d3ee", // --accent (scanner gantry)
  pulse = "#4ade80", // --status-online (live signal)
  style,
}: {
  size?: number;
  body?: string;
  pulse?: string;
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
      {/* MRI gantry face with the bore cut out (evenodd → transparent bore) */}
      <path
        fill={body}
        fillRule="evenodd"
        d="M7.5 2 H16.5 A5 5 0 0 1 21.5 7 V16 A5 5 0 0 1 16.5 21 H7.5 A5 5 0 0 1 2.5 16 V7 A5 5 0 0 1 7.5 2 Z M17.4 11.5 A5.4 5.4 0 1 0 6.6 11.5 A5.4 5.4 0 1 0 17.4 11.5 Z"
      />
      {/* live monitoring pulse across the bore */}
      <path
        fill={pulse}
        d="M7 10.9 L9.4 10.9 L10.4 9 L11.6 13.2 L12.6 10.9 L17 10.9 L17 12.1 L12.6 12.1 L11.6 14.4 L10.4 10.2 L9.4 12.1 L7 12.1 Z"
      />
    </svg>
  );
}
