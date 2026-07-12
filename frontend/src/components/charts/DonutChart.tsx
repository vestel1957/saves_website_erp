import { colorAt } from "./helpers";
import { ChartEmpty, LegendItem } from "./ChartCard";

export type Slice = { label: string; value: number; color?: string };

/**
 * Donut / distribution chart with a center total and an inline legend. Pure SVG.
 */
export function DonutChart({
  data,
  size = 168,
  thickness = 22,
  centerLabel,
  centerValue,
  valueFormat = (n) => n.toLocaleString("es-CO"),
}: {
  data: Slice[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
  valueFormat?: (n: number) => string;
}) {
  const total = data.reduce((a, b) => a + b.value, 0);
  if (total <= 0) return <ChartEmpty />;

  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
      <svg viewBox={`0 0 ${size} ${size}`} className="h-auto w-[150px] shrink-0 sm:w-[168px]" role="img">
        <circle cx={cx} cy={cy} r={r} fill="none" className="stroke-surface-2" strokeWidth={thickness} />
        {data.map((d, i) => {
          const frac = d.value / total;
          const len = frac * circ;
          const color = d.color ?? colorAt(i);
          const el = (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={color}
              strokeWidth={thickness}
              strokeDasharray={`${len} ${circ - len}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
              transform={`rotate(-90 ${cx} ${cy})`}
            >
              <title>{`${d.label}: ${valueFormat(d.value)} (${Math.round(frac * 100)}%)`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
        {(centerValue || centerLabel) && (
          <>
            <text x={cx} y={cy - 1} textAnchor="middle" className="fill-text-primary" fontSize={19} fontWeight={700}>
              {centerValue}
            </text>
            {centerLabel && (
              <text x={cx} y={cy + 15} textAnchor="middle" className="fill-text-tertiary" fontSize={10}>
                {centerLabel}
              </text>
            )}
          </>
        )}
      </svg>

      <div className="grid w-full grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-1">
        {data.map((d, i) => (
          <LegendItem
            key={i}
            color={d.color ?? colorAt(i)}
            label={d.label}
            value={`${valueFormat(d.value)} · ${Math.round((d.value / total) * 100)}%`}
          />
        ))}
      </div>
    </div>
  );
}
