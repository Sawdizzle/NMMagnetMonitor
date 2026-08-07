export default function MiniLineChart({
  values,
  width = 100,
  height = 28,
  color = "#5b8def",
}: {
  values: (number | null | undefined)[];
  width?: number;
  height?: number;
  color?: string;
}) {
  const clean = values.filter((v): v is number => v !== null && v !== undefined);

  if (clean.length < 2) {
    return (
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <line x1={0} y1={height - 1} x2={width} y2={height - 1} stroke="currentColor" strokeOpacity={0.15} />
      </svg>
    );
  }

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;
  const stepX = width / (clean.length - 1);

  const points = clean.map((v, i) => {
    const x = i * stepX;
    const y = height - 2 - ((v - min) / range) * (height - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const lastX = (clean.length - 1) * stepX;
  const lastY = height - 2 - ((clean[clean.length - 1] - min) / range) * (height - 4);

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.85}
      />
      <circle cx={lastX} cy={lastY} r={2} fill={color} />
    </svg>
  );
}
