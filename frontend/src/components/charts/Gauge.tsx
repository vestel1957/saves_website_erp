/**
 * Radial progress gauge for a single percentage (e.g. % cumplimiento SST).
 * Color shifts with the value unless an explicit color is given. Pure SVG.
 */
export function Gauge({
  pct,
  size = 168,
  thickness = 16,
  label,
  color,
}: {
  pct: number;
  size?: number;
  thickness?: number;
  label?: string;
  color?: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const len = (clamped / 100) * circ;

  const auto =
    clamped >= 80 ? "var(--color-success)" : clamped >= 60 ? "var(--color-warning)" : "var(--color-error)";
  const stroke = color ?? auto;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="h-auto w-[150px] sm:w-[168px]" role="img">
      <circle cx={cx} cy={cy} r={r} fill="none" className="stroke-surface-2" strokeWidth={thickness} />
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={stroke}
        strokeWidth={thickness}
        strokeLinecap="round"
        strokeDasharray={`${len} ${circ - len}`}
        transform={`rotate(-90 ${cx} ${cy})`}
      />
      <text x={cx} y={cy - 1} textAnchor="middle" className="fill-text-primary" fontSize={30} fontWeight={700}>
        {Math.round(clamped)}%
      </text>
      {label && (
        <text x={cx} y={cy + 18} textAnchor="middle" className="fill-text-tertiary" fontSize={11}>
          {label}
        </text>
      )}
    </svg>
  );
}
