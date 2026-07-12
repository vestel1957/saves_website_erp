import { Icon } from "../Icon";

type WOStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

const STEPS = [
  { label: "Pendiente", icon: "clipboard-list" },
  { label: "En progreso", icon: "play" },
  { label: "Terminada", icon: "check" },
] as const;

/**
 * Barra de progreso por pasos (Pendiente → En progreso → Terminada) compartida
 * por el detalle y las tarjetas de la lista de órdenes de trabajo. `compact`
 * reduce el tamaño y oculta las etiquetas (para la lista).
 */
export function WorkOrderStepper({ status, compact = false }: { status: WOStatus; compact?: boolean }) {
  if (status === "CANCELLED") {
    return (
      <span className="inline-flex items-center gap-1.5 font-semibold text-rose-600" style={{ fontSize: compact ? 12 : 13 }}>
        <Icon name="x" size={compact ? 14 : 16} /> Cancelada
      </span>
    );
  }

  const idx = status === "COMPLETED" ? 2 : status === "IN_PROGRESS" ? 1 : 0;
  const circle = compact ? "h-6 w-6" : "h-8 w-8";
  const iconSz = compact ? 12 : 15;
  const conn = compact ? "w-5" : "w-8 sm:w-12";

  return (
    <div className="flex items-center">
      {STEPS.map((s, i) => {
        const done = i < idx;
        const current = i === idx;
        return (
          <div key={s.label} className="flex items-center">
            <div className="flex flex-col items-center gap-1">
              <span
                className={`flex ${circle} items-center justify-center rounded-full border-2 ${
                  done
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : current
                    ? "border-brand bg-brand-soft text-brand"
                    : "border-border-default bg-surface text-text-tertiary"
                }`}
              >
                <Icon name={done ? "check" : s.icon} size={iconSz} />
              </span>
              {!compact && (
                <span className={`text-[10px] font-semibold ${current ? "text-text-primary" : "text-text-tertiary"}`}>{s.label}</span>
              )}
            </div>
            {i < STEPS.length - 1 && (
              <span className={`mx-1.5 ${compact ? "" : "mb-4"} h-0.5 ${conn} ${i < idx ? "bg-emerald-500" : "bg-border-default"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
