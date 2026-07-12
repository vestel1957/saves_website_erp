import { niceMax, colorAt, compact } from "./helpers";
import { ChartEmpty } from "./ChartCard";

export type BarDatum = { label: string; value: number; color?: string };

/**
 * Vertical bar chart with rounded tops, gridlines and value-on-hover. Supports a
 * single series. Pure SVG / server-renderable.
 */
export function BarChart({
  data,
  height = 230,
  yFormat = compact,
  maxTicks = 4,
  accent = "var(--color-brand)",
}: {
  data: BarDatum[];
  height?: number;
  yFormat?: (n: number) => string;
  maxTicks?: number;
  accent?: string;
}) {
  const W = 660;
  const H = height;
  const padL = 46;
  const padR = 14;
  const padT = 14;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  if (!data.length || data.every((d) => d.value === 0)) return <ChartEmpty />;

  const max = niceMax(Math.max(...data.map((d) => d.value), 0)) || 1;
  const n = data.length;
  const slot = innerW / n;
  const bw = Math.min(slot * 0.62, 46);
  const yAt = (v: number) => padT + innerH - (v / max) * innerH;
  const ticks = Array.from({ length: maxTicks + 1 }, (_, i) => (max / maxTicks) * i);
  const labelStep = Math.ceil(n / 9);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" preserveAspectRatio="xMidYMid meet">
      {ticks.map((t, i) => {
        const y = yAt(t);
        return (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y} y2={y} className="stroke-border-subtle" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <text x={padL - 8} y={y + 3} textAnchor="end" className="fill-text-tertiary" fontSize={10}>
              {yFormat(t)}
            </text>
          </g>
        );
      })}

      {data.map((d, i) => {
        const x = padL + i * slot + (slot - bw) / 2;
        const y = yAt(d.value);
        const h = padT + innerH - y;
        const color = d.color ?? accent;
        return (
          <g key={i}>
            <rect x={x} y={y} width={bw} height={Math.max(h, 0)} rx={4} fill={color}>
              <title>{`${d.label}: ${yFormat(d.value)}`}</title>
            </rect>
            {i % labelStep === 0 && (
              <text x={x + bw / 2} y={H - 9} textAnchor="middle" className="fill-text-tertiary" fontSize={10}>
                {d.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export { colorAt };
