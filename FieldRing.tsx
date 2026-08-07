import { STATUS_COLORS, type HealthStatus } from "@/lib/health";

export default function FieldRing({
  status,
  size = 44,
}: {
  status: HealthStatus;
  size?: number;
}) {
  const color = STATUS_COLORS[status];
  const pulsing = status === "online";
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" fill="none" aria-hidden="true" role="presentation">
      <circle
        cx="22"
        cy="22"
        r="20"
        stroke={color}
        strokeOpacity="0.25"
        strokeWidth="1.5"
      />
      <circle
        cx="22"
        cy="22"
        r="14"
        stroke={color}
        strokeOpacity="0.5"
        strokeWidth="1.5"
      />
      <circle cx="22" cy="22" r="4.5" fill={color}>
        {pulsing && (
          <animate
            attributeName="opacity"
            values="1;0.4;1"
            dur="2.4s"
            repeatCount="indefinite"
          />
        )}
      </circle>
    </svg>
  );
}
