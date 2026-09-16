type Tone = "default" | "success" | "error" | "warning" | "info" | "brand";

const tones: Record<Tone, string> = {
  default: "bg-surface-2 text-text-secondary",
  success: "bg-success-soft text-success-text",
  error: "bg-error-soft text-error-text",
  warning: "bg-warning-soft text-warning-text",
  info: "bg-info-soft text-info-text",
  brand: "bg-brand-soft text-brand",
};

/**
 * El mismo mapa, abierto para quien pinta una marca que NO es esta pastilla.
 *
 * La agenda y las vistas de soporte dibujan un rótulo de 9–10 px en versalitas y no una
 * píldora de 11: lo que comparten con `Badge` es el PAR de colores de cada tono, no la
 * forma. Copiarlo significaba que añadir un tono o corregir un contraste había que
 * hacerlo en varios archivos y en alguno se olvidaría.
 *
 * Va como `Record<string, string>` a propósito: quien lo usa indexa con el tono que le
 * devuelve un mapa de prioridades, que es un `string` cualquiera, y `default` es
 * justamente la respuesta a lo que no reconoce.
 */
export const TONOS_BADGE: Readonly<Record<string, string>> = tones;

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
