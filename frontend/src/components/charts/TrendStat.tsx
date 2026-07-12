import { Icon } from "../Icon";
import { Sparkline } from "./Sparkline";

type Tone = "default" | "success" | "error" | "warning" | "ai";

const toneText: Record<Tone, string> = {
  default: "text-text-primary",
  success: "text-success-text",
  error: "text-error-text",
  warning: "text-warning-text",
  ai: "text-ai",
};

const toneColor: Record<Tone, string> = {
  default: "var(--color-brand)",
  success: "var(--color-success)",
  error: "var(--color-error)",
  warning: "var(--color-warning)",
  ai: "var(--color-ai)",
};

/**
 * KPI card with an optional delta badge and an embedded sparkline — the richer
 * replacement for the flat StatCard on the dashboards.
 */
export function TrendStat({
  label,
  value,
  icon,
  tone = "default",
  delta,
  deltaLabel,
  spark,
  hint,
}: {
  label: string;
  value: string;
  icon: string;
  tone?: Tone;
  /** signed percentage change; sign drives the up/down arrow + color */
  delta?: number;
  deltaLabel?: string;
  spark?: number[];
  hint?: string;
}) {
  const up = (delta ?? 0) >= 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-xl border border-border-subtle bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 text-[12px] font-semibold leading-snug text-text-secondary">{label}</span>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2">
          <Icon name={icon} size={15} className="text-text-tertiary" />
        </div>
      </div>

      <div className="flex items-end justify-between gap-2">
        <span className={`break-words text-[22px] font-bold leading-none ${toneText[tone]}`}>{value}</span>
        {typeof delta === "number" && (
          <span
            className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-bold ${
              up ? "bg-success-soft text-success-text" : "bg-error-soft text-error-text"
            }`}
          >
            <Icon name={up ? "arrow-up" : "arrow-down"} size={11} />
            {Math.abs(delta).toFixed(1)}%
          </span>
        )}
      </div>

      {spark && spark.length > 1 ? (
        <Sparkline points={spark} color={toneColor[tone]} />
      ) : (
        (hint || deltaLabel) && <span className="text-[11px] text-text-tertiary">{hint ?? deltaLabel}</span>
      )}
      {spark && spark.length > 1 && (deltaLabel || hint) && (
        <span className="-mt-1 text-[10px] text-text-tertiary">{deltaLabel ?? hint}</span>
      )}
    </div>
  );
}
