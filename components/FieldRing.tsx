import { ALARM_COLORS, type AlarmLevel } from "@/lib/faults";

/**
 * The unlabelled status ring on a fleet card and the asset header.
 *
 * Coloured by the folded ALARM level, not by connectivity. It used to take a
 * HealthStatus — which answers only "did the unit phone home?" — so a unit that
 * was reporting perfectly while its compressor was off and its coldhead sat at
 * 58 K drew a green ring. That is the loudest signal on the card and it was
 * saying the opposite of the fault pills directly beneath it, while the TV wall
 * showed the same unit in red. The colour now comes from the same
 * computeAssetAlarm() the wall display and the fleet table use.
 *
 * `live` stays connectivity, and only drives the pulse: colour says how the
 * magnet IS, the heartbeat says whether we are still hearing from it. A unit in
 * alarm that is still reporting keeps pulsing — in red.
 */
export default function FieldRing({
  level,
  live,
  size = 44,
}: {
  level: AlarmLevel;
  live: boolean;
  size?: number;
}) {
  const color = ALARM_COLORS[level];
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
        {live && (
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
