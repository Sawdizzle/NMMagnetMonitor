import type { WeatherIconKey } from "@/lib/weatherTypes";

// The seven shapes the NWS icon slugs collapse into (see iconKey in
// lib/weather.ts), drawn inline rather than pulled from api.weather.gov: the
// NWS icon endpoint is deprecated, the images are raster, and a monitoring
// dashboard should not go fetch a third-party PNG per card.
//
// Everything is stroked in currentColor so a caller can tint the whole icon —
// amber for a hot afternoon, plain dim text otherwise — with one CSS property.

const SUN = "M12 4.4V2.6M12 21.4v-1.8M19.6 12h1.8M2.6 12h1.8M17.4 6.6l1.3-1.3M5.3 18.7l1.3-1.3M17.4 17.4l1.3 1.3M5.3 5.3l1.3 1.3";
const CLOUD = "M7.5 18.5h9a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6-.7 3.4 3.4 0 0 0 .3 7.7Z";

export default function WeatherIcon({
  icon,
  size = 16,
  title,
}: {
  icon: WeatherIconKey;
  size?: number;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {shape(icon)}
    </svg>
  );
}

function shape(icon: WeatherIconKey) {
  switch (icon) {
    case "clear-day":
      return (
        <>
          <circle cx="12" cy="12" r="4.2" />
          <path d={SUN} />
        </>
      );
    case "clear-night":
      // A crescent, not a disc — the same glyph as clear-day would read as noon.
      return <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />;
    case "partly-day":
      return (
        <>
          <circle cx="9" cy="8.5" r="3" />
          <path d="M9 2.9v-1.3M14.6 8.5h1.3M2.1 8.5h1.3M13 4.5l.9-.9M4.1 13.4l.9-.9M4.1 3.6l.9.9" />
          <path d={CLOUD} />
        </>
      );
    case "partly-night":
      return (
        <>
          <path d="M15.5 8.6A5.4 5.4 0 0 1 9.8 3a5.4 5.4 0 1 0 6.7 6.7Z" />
          <path d={CLOUD} />
        </>
      );
    case "cloudy":
      return <path d={CLOUD} />;
    case "rain":
      return (
        <>
          <path d="M7.5 15.5h9a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6-.7 3.4 3.4 0 0 0 .3 7.7Z" />
          <path d="M9 18.5l-.8 2.4M12.4 18.5l-.8 2.4M15.8 18.5l-.8 2.4" />
        </>
      );
    case "snow":
      return (
        <>
          <path d="M7.5 15.5h9a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6-.7 3.4 3.4 0 0 0 .3 7.7Z" />
          <path d="M8.8 19.4h.01M12 20.8h.01M15.2 19.4h.01M12 18h.01" />
        </>
      );
    case "storm":
      return (
        <>
          <path d="M7.5 15.5h9a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6-.7 3.4 3.4 0 0 0 .3 7.7Z" />
          <path d="M13 17.5l-3 3.4h3l-1.2 2.6" />
        </>
      );
    case "fog":
      return (
        <>
          <path d="M7.5 13.5h9a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6-.7 3.4 3.4 0 0 0 .3 7.7Z" />
          <path d="M5 17h14M7 20.5h10" />
        </>
      );
    default:
      // No usable slug — a thermometer says "this is a temperature" and claims
      // nothing about the sky.
      return (
        <>
          <path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0Z" />
          <path d="M12 17.2v-4" />
        </>
      );
  }
}
