type Tone = "default" | "success" | "error" | "warning" | "info" | "brand";

const tones: Record<Tone, string> = {
  default: "bg-surface-2 text-text-secondary",
  success: "bg-success-soft text-success-text",
  error: "bg-error-soft text-error-text",
  warning: "bg-warning-soft text-warning-text",
  info: "bg-info-soft text-info-text",
  brand: "bg-brand-soft text-brand",
};

/** Pastilla de estado/etiqueta reutilizable. */
export function Badge({ label, tone = "default" }: { label: string; tone?: Tone }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>
      {label}
    </span>
  );
}
