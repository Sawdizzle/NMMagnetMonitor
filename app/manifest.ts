import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "NM Magnet Monitor",
    short_name: "MagMon",
    description: "Remote monitoring for GE MagMon magnet monitors — Numed",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0d13",
    theme_color: "#0a0d13",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png", purpose: "maskable" },
    ],
  };
}
