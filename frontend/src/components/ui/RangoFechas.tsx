"use client";

import { Input } from "./Field";

/**
 * Selector de rango de fechas: atajos de siempre + fechas a mano.
 *
 * Nació para el panel ejecutivo, que abría con los totales HISTÓRICOS ("facturado
 * desde siempre") y por eso no servía para mirar cómo va el mes. Vive aquí y no en la
 * pantalla porque el mismo control encaja en cualquier informe con un "desde/hasta".
 *
 * Los atajos se calculan en la hora del navegador (Colombia), no en la del servidor,
 * y viajan a la API como texto 'YYYY-MM-DD' — sin hora, no hay zona que corra el día.
 */
export type PresetRango = "hoy" | "semana" | "mes" | "mesPasado" | "trimestre" | "anio" | "personalizado";

export type RangoFechasValor = { preset: PresetRango; desde: string; hasta: string };

const ymd = (d: Date) => d.toLocaleDateString("en-CA");

/** Rango de cada atajo. `personalizado` conserva lo que ya hubiera elegido el usuario. */
export function rangoDePreset(preset: PresetRango, actual?: RangoFechasValor): RangoFechasValor {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = hoy.getMonth();
  switch (preset) {
    // Tesorería se pregunta por el DÍA y por la SEMANA mucho más que por el año: un
    // arqueo, una consulta de "lo de hoy", lo que lleva la semana. Los atajos no se
    // enseñan en todas las pantallas (ver `presets`).
    case "hoy":
      return { preset, desde: ymd(hoy), hasta: ymd(hoy) };
    case "semana": {
      // Semana en curso, de lunes a hoy (getDay: 0 = domingo).
      const dia = hoy.getDay();
      const lunes = new Date(y, m, hoy.getDate() - (dia === 0 ? 6 : dia - 1));
      return { preset, desde: ymd(lunes), hasta: ymd(hoy) };
    }
    case "mesPasado":
      return { preset, desde: ymd(new Date(y, m - 1, 1)), hasta: ymd(new Date(y, m, 0)) };
    case "trimestre":
      return { preset, desde: ymd(new Date(y, m - 2, 1)), hasta: ymd(hoy) };
    case "anio":
      return { preset, desde: ymd(new Date(y, 0, 1)), hasta: ymd(hoy) };
    case "personalizado":
      return { preset, desde: actual?.desde ?? ymd(new Date(y, m, 1)), hasta: actual?.hasta ?? ymd(hoy) };
    case "mes":
    default:
      return { preset: "mes", desde: ymd(new Date(y, m, 1)), hasta: ymd(hoy) };
  }
}

const OPCIONES: { value: PresetRango; label: string }[] = [
  { value: "hoy", label: "Hoy" },
  { value: "semana", label: "Semana" },
  { value: "mes", label: "Este mes" },
  { value: "mesPasado", label: "Mes pasado" },
  { value: "trimestre", label: "3 meses" },
  { value: "anio", label: "Este año" },
  { value: "personalizado", label: "Personalizado" },
];

/** Texto legible del rango: "1 ago – 6 ago 2026". */
export function etiquetaRango(r: { desde: string; hasta: string }): string {
  const fmt = (s: string) =>
    new Date(`${s}T00:00:00.000Z`).toLocaleDateString("es-CO", { day: "numeric", month: "short", timeZone: "UTC" });
  const anio = r.hasta.slice(0, 4);
  return `${fmt(r.desde)} – ${fmt(r.hasta)} ${anio}`;
}

/** Los atajos que ve una pantalla si no pide otra cosa: los de siempre. */
const POR_DEFECTO: PresetRango[] = ["mes", "mesPasado", "trimestre", "anio", "personalizado"];

export function RangoFechas({
  value,
  onChange,
  className = "",
  presets = POR_DEFECTO,
}: {
  value: RangoFechasValor;
  onChange: (next: RangoFechasValor) => void;
  className?: string;
  /** Qué atajos enseñar y en qué orden. Se acota por pantalla: "Hoy" es imprescindible
   *  en tesorería y ruido en un informe anual. */
  presets?: PresetRango[];
}) {
  const opciones = presets
    .map((p) => OPCIONES.find((o) => o.value === p))
    .filter((o): o is { value: PresetRango; label: string } => !!o);
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <div role="group" aria-label="Periodo" className="inline-flex flex-wrap rounded-lg border border-border-subtle bg-surface-2 p-0.5">
        {opciones.map((o) => {
          const activo = o.value === value.preset;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={activo}
              onClick={() => onChange(rangoDePreset(o.value, value))}
              className={`tap whitespace-nowrap rounded-md px-2.5 py-1.5 text-[12px] font-semibold transition-colors ${
                activo ? "bg-surface text-brand shadow-sm" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {value.preset === "personalizado" && (
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            value={value.desde}
            max={value.hasta}
            onChange={(e) => onChange({ ...value, desde: e.target.value })}
            className="w-36"
            title="Desde"
            aria-label="Desde"
          />
          <span className="text-[12px] text-text-tertiary">a</span>
          <Input
            type="date"
            value={value.hasta}
            min={value.desde}
            onChange={(e) => onChange({ ...value, hasta: e.target.value })}
            className="w-36"
            title="Hasta"
            aria-label="Hasta"
          />
        </div>
      )}
    </div>
  );
}
