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

export type RangoFechasValor = {
  preset: PresetRango; desde: string; hasta: string;
  /** "HH:MM" (hora de Colombia) con que empieza `desde` y acaba `hasta`. Vacío = el día entero. */
  horaDesde?: string; horaHasta?: string;
};

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

const PRESETS_VALIDOS: PresetRango[] = ["hoy", "semana", "mes", "mesPasado", "trimestre", "anio", "personalizado"];
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * El rango tal como se guarda en la URL de un listado (`?periodo=semana`, o
 * `?periodo=personalizado&desde=…&hasta=…`).
 *
 * Los atajos se guardan por NOMBRE y no por fechas: quien dejó puesto "Hoy" el
 * lunes quiere ver hoy el martes, no el lunes otra vez. Solo el personalizado
 * lleva las fechas. Un enlace con `desde`/`hasta` y sin periodo (el del cierre de
 * caja) se lee como personalizado. Lo que no se reconoce cae en `porDefecto`.
 */
export function rangoDeUrl(valores: Record<string, string>, porDefecto: PresetRango = "mes"): RangoFechasValor {
  const { periodo, desde, hasta } = valores;
  // Las horas valen con cualquier periodo ("Hoy de 8:00 a 12:00"); lo que no es HH:MM se ignora.
  const horas = {
    horaDesde: HORA.test(valores.horaDesde ?? "") ? valores.horaDesde : "",
    horaHasta: HORA.test(valores.horaHasta ?? "") ? valores.horaHasta : "",
  };
  const conFechas = !!desde && !!hasta && FECHA.test(desde) && FECHA.test(hasta);
  if ((periodo === "personalizado" || !periodo) && conFechas) return { preset: "personalizado", desde, hasta, ...horas };
  if (periodo && periodo !== "personalizado" && PRESETS_VALIDOS.includes(periodo as PresetRango)) {
    return { ...rangoDePreset(periodo as PresetRango), ...horas };
  }
  return { ...rangoDePreset(porDefecto), ...horas };
}

/** Lo contrario de `rangoDeUrl`. El periodo por defecto no se escribe; las horas, si hay, siempre. */
export function rangoAUrl(
  r: RangoFechasValor | null,
  porDefecto: PresetRango = "mes",
): { periodo: string; desde: string; hasta: string; horaDesde: string; horaHasta: string } {
  const horas = { horaDesde: r?.horaDesde ?? "", horaHasta: r?.horaHasta ?? "" };
  if (!r || r.preset === porDefecto) return { periodo: "", desde: "", hasta: "", ...horas };
  if (r.preset === "personalizado") return { periodo: "personalizado", desde: r.desde, hasta: r.hasta, ...horas };
  return { periodo: r.preset, desde: "", hasta: "", ...horas };
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

/** Texto legible del rango: "1 ago – 6 ago 2026", o con horas "14 sept 08:00 – 14 sept 12:00 2026". */
export function etiquetaRango(r: { desde: string; hasta: string; horaDesde?: string; horaHasta?: string }): string {
  const fmt = (s: string) =>
    new Date(`${s}T00:00:00.000Z`).toLocaleDateString("es-CO", { day: "numeric", month: "short", timeZone: "UTC" });
  const anio = r.hasta.slice(0, 4);
  if (!r.horaDesde && !r.horaHasta) return `${fmt(r.desde)} – ${fmt(r.hasta)} ${anio}`;
  return `${fmt(r.desde)} ${r.horaDesde || "00:00"} – ${fmt(r.hasta)} ${r.horaHasta || "23:59"} ${anio}`;
}

/** Los atajos que ve una pantalla si no pide otra cosa: los de siempre. */
const POR_DEFECTO: PresetRango[] = ["mes", "mesPasado", "trimestre", "anio", "personalizado"];

export function RangoFechas({
  value,
  onChange,
  className = "",
  presets = POR_DEFECTO,
  conHora = false,
}: {
  value: RangoFechasValor;
  onChange: (next: RangoFechasValor) => void;
  className?: string;
  /** Qué atajos enseñar y en qué orden. Se acota por pantalla: "Hoy" es imprescindible
   *  en tesorería y ruido en un informe anual. */
  presets?: PresetRango[];
  /** Enseña "de HH:MM a HH:MM": sólo donde el listado sabe filtrar por hora. */
  conHora?: boolean;
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
              // Cambiar de atajo conserva las horas: "de 8 a 12" se sigue queriendo al pasar de Hoy a Semana.
              onClick={() => onChange({ ...rangoDePreset(o.value, value), horaDesde: value.horaDesde, horaHasta: value.horaHasta })}
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
      {conHora && (
        <div className="flex items-center gap-1.5" title="Hora en que se registró (hora de Colombia). Vacío = el día entero.">
          <span className="text-[12px] text-text-tertiary">de</span>
          <Input
            type="time"
            value={value.horaDesde ?? ""}
            onChange={(e) => onChange({ ...value, horaDesde: e.target.value })}
            className="w-28"
            aria-label="Hora desde"
          />
          <span className="text-[12px] text-text-tertiary">a</span>
          <Input
            type="time"
            value={value.horaHasta ?? ""}
            onChange={(e) => onChange({ ...value, horaHasta: e.target.value })}
            className="w-28"
            aria-label="Hora hasta"
          />
        </div>
      )}
    </div>
  );
}
