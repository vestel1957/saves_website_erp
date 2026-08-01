type Tone = "default" | "success" | "error" | "warning" | "info" | "brand";

const tones: Record<Tone, string> = {
  default: "bg-surface-2 text-text-secondary",
  success: "bg-success-soft text-success-text",
  error: "bg-error-soft text-error-text",
  warning: "bg-warning-soft text-warning-text",
  info: "bg-info-soft text-info-text",
  brand: "bg-brand-soft text-brand",
};

/** `md` para cuando la pastilla ES el dato de la celda, no una etiqueta al margen. */
const sizes = {
  sm: "px-2 py-0.5 text-[11px]",
  md: "px-2.5 py-1 text-[13px]",
};

/** Pastilla de estado/etiqueta reutilizable. */
export function Badge({ label, tone = "default", size = "sm" }: { label: string; tone?: Tone; size?: keyof typeof sizes }) {
  return (
    <span className={`inline-block rounded-full font-semibold ${sizes[size]} ${tones[tone]}`}>
      {label}
    </span>
  );
}
