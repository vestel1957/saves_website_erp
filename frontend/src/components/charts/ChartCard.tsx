import type { ReactNode } from "react";
import { Icon } from "../Icon";

/** Card chrome shared by every chart on the dashboards: title row with an
 *  optional icon + trailing slot (legend, filter, value), and a body. */
export function ChartCard({
  title,
  subtitle,
  icon,
  action,
  className = "",
  bodyClassName = "",
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: string;
  action?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex min-w-0 flex-col gap-4 rounded-xl border border-border-subtle bg-surface p-4 sm:p-5 ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon && (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2">
              <Icon name={icon} size={16} className="text-text-secondary" />
            </div>
          )}
          <div className="min-w-0">
            <h3 className="truncate text-[13px] font-bold text-text-primary sm:text-[14px]">{title}</h3>
            {subtitle && <p className="truncate text-[11px] text-text-tertiary">{subtitle}</p>}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className={`min-w-0 ${bodyClassName}`}>{children}</div>
    </div>
  );
}

/** Small colored legend chip used under multi-series charts. */
export function LegendItem({ color, label, value }: { color: string; label: string; value?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="text-[11px] text-text-secondary">{label}</span>
      {value && <span className="text-[11px] font-semibold text-text-primary">{value}</span>}
    </div>
  );
}

/** Empty-state shown when a series has no data yet (new install, no movements). */
export function ChartEmpty({ message = "Sin datos para mostrar" }: { message?: string }) {
  return (
    <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-1.5 text-center">
      <Icon name="bar-chart-3" size={22} className="text-text-tertiary opacity-60" />
      <p className="text-[12px] text-text-tertiary">{message}</p>
    </div>
  );
}
