import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0d13",
        }}
      >
        <svg width="120" height="120" viewBox="0 0 44 44" fill="none">
          <circle cx="22" cy="22" r="20" stroke="#5b8def" strokeOpacity="0.35" strokeWidth="2.2" />
          <circle cx="22" cy="22" r="14" stroke="#5b8def" strokeOpacity="0.7" strokeWidth="2.2" />
          <circle cx="22" cy="22" r="6.5" fill="#5b8def" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
