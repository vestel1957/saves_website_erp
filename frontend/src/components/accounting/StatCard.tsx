import { Icon } from "../Icon";

export function StatCard({
  label,
  value,
  icon,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  icon: string;
  hint?: string;
  tone?: "default" | "success" | "error" | "ai";
}) {
  const toneText =
    tone === "success"
      ? "text-success-text"
      : tone === "error"
        ? "text-error-text"
        : tone === "ai"
          ? "text-ai"
          : "text-text-primary";

  return (
    <div className="flex flex-1 flex-col gap-3 rounded-xl border border-border-subtle bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-text-secondary">{label}</span>
        <Icon name={icon} size={16} className="mt-0.5 shrink-0 text-text-tertiary" />
      </div>
      <span className={`break-words text-[20px] font-bold leading-tight sm:text-[24px] sm:leading-none ${toneText}`}>{value}</span>
      {hint && <span className="text-[11px] text-text-tertiary">{hint}</span>}
    </div>
  );
}
