import { colorAt } from "./helpers";
import { ChartEmpty } from "./ChartCard";

export type HBarRow = { label: string; value: number; color?: string; hint?: string };

/**
 * Horizontal ranked-bar list — ideal for "top N" rankings (products by value,
 * expenses by category) and aging buckets. Bars are sized vs the largest row.
 * Rendered with HTML/flex (not SVG) so labels wrap and stay legible on mobile.
 */
export function HBarList({
  rows,
  valueFormat = (n) => n.toLocaleString("es-CO"),
  monochrome = false,
  accent = "var(--color-brand)",
}: {
  rows: HBarRow[];
  valueFormat?: (n: number) => string;
  monochrome?: boolean;
  accent?: string;
}) {
  if (!rows.length || rows.every((r) => r.value === 0)) return <ChartEmpty />;
  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <div className="flex flex-col gap-3">
      {rows.map((r, i) => {
        const pct = Math.max((r.value / max) * 100, 1.5);
        const color = r.color ?? (monochrome ? accent : colorAt(i));
        return (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-[12px] font-medium text-text-secondary" title={r.label}>
                {r.label}
              </span>
              <span className="shrink-0 text-[12px] font-bold text-text-primary tabular-nums">
                {valueFormat(r.value)}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
            </div>
            {r.hint && <span className="text-[10px] text-text-tertiary">{r.hint}</span>}
          </div>
        );
      })}
    </div>
  );
}
