import { smoothPath } from "./helpers";

/** Tiny inline trend line (no axes) for embedding inside KPI cards. */
export function Sparkline({
  points,
  width = 120,
  height = 36,
  color = "var(--color-brand)",
  area = true,
}: {
  points: number[];
  width?: number;
  height?: number;
  color?: string;
  area?: boolean;
}) {
  if (points.length < 2) return <div style={{ height }} />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const pad = 3;
  const xAt = (i: number) => pad + (i / (points.length - 1)) * (width - pad * 2);
  const yAt = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const pts = points.map((v, i) => ({ x: xAt(i), y: yAt(v) }));
  const line = smoothPath(pts);
  const gid = `spark-${Math.round(points[0])}-${points.length}-${Math.round(max)}`;

  // Alto fijo: con `h-auto` el navegador respetaba la proporción 120×36 y en una
  // tarjeta ancha la mini-línea se estiraba hasta ocupar 100px de alto.
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      style={{ height }}
      preserveAspectRatio="none"
      role="img"
    >
      {area && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={`${line} L ${pts[pts.length - 1].x},${height} L ${pts[0].x},${height} Z`} fill={`url(#${gid})`} />
        </>
      )}
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
