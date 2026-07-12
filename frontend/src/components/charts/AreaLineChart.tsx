import { smoothPath, niceMax, colorAt, compact, type Point } from "./helpers";
import { ChartEmpty } from "./ChartCard";

export type LineSeries = { name: string; color?: string; points: number[] };

/**
 * Responsive multi-series area/line chart. Pure SVG (no client JS) so it can be
 * rendered directly from a server component. Uses a fixed viewBox + w-full so it
 * scales crisply; strokes use non-scaling-stroke to stay sharp at any width.
 */
export function AreaLineChart({
  series,
  labels,
  height = 230,
  area = true,
  yFormat = compact,
  maxTicks = 4,
}: {
  series: LineSeries[];
  labels: string[];
  height?: number;
  area?: boolean;
  yFormat?: (n: number) => string;
  maxTicks?: number;
}) {
  const W = 660;
  const H = height;
  const padL = 46;
  const padR = 14;
  const padT = 14;
  const padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const allValues = series.flatMap((s) => s.points);
  const hasData = allValues.length > 0 && labels.length > 0;
  if (!hasData) return <ChartEmpty />;

  const rawMax = Math.max(...allValues, 0);
  const max = niceMax(rawMax) || 1;
  const n = labels.length;
  const xAt = (i: number) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (v: number) => padT + innerH - (v / max) * innerH;

  const ticks = Array.from({ length: maxTicks + 1 }, (_, i) => (max / maxTicks) * i);
  // Thin x-labels so they don't collide on mobile.
  const labelStep = Math.ceil(n / 7);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" preserveAspectRatio="xMidYMid meet">
      {/* gridlines + y labels */}
      {ticks.map((t, i) => {
        const y = yAt(t);
        return (
          <g key={i}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y}
              y2={y}
              className="stroke-border-subtle"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <text x={padL - 8} y={y + 3} textAnchor="end" className="fill-text-tertiary" fontSize={10}>
              {yFormat(t)}
            </text>
          </g>
        );
      })}

      {/* x labels */}
      {labels.map((lb, i) =>
        i % labelStep === 0 ? (
          <text key={i} x={xAt(i)} y={H - 8} textAnchor="middle" className="fill-text-tertiary" fontSize={10}>
            {lb}
          </text>
        ) : null,
      )}

      {series.map((s, si) => {
        const color = s.color ?? colorAt(si);
        const pts = s.points.map((v, i) => ({ x: xAt(i), y: yAt(v) }));
        const line = smoothPath(pts);
        const gid = `area-grad-${si}`;
        return (
          <g key={si}>
            {area && si === 0 && pts.length > 1 && (
              <>
                <defs>
                  <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <path d={`${line} L ${pts[pts.length - 1].x},${padT + innerH} L ${pts[0].x},${padT + innerH} Z`} fill={`url(#${gid})`} />
              </>
            )}
            <path
              d={line}
              fill="none"
              stroke={color}
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {/* end dot */}
            {pts.length > 0 && (
              <circle cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r={3.2} fill={color} />
            )}
            {/* native hover tooltips per point */}
            {pts.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={9} fill="transparent">
                <title>{`${s.name ? s.name + " · " : ""}${labels[i]}: ${yFormat(s.points[i])}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

export type { Point };
