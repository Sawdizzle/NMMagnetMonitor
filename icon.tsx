import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
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
        <svg width="320" height="320" viewBox="0 0 44 44" fill="none">
          <circle cx="22" cy="22" r="20" stroke="#5b8def" strokeOpacity="0.3" strokeWidth="2" />
          <circle cx="22" cy="22" r="14" stroke="#5b8def" strokeOpacity="0.6" strokeWidth="2" />
          <circle cx="22" cy="22" r="6" fill="#5b8def" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
