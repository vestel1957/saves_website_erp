"use client";

import { Icon } from "@/components/Icon";
import {
  DIAS_CORTOS, cruzaElDia, diaISO, inicioDeSemana, mismoDia, nombreDeMes, rejillaDeMes,
  sumarDias, sumarMeses, type Evento,
} from "./calendario";

/**
 * El calendario pequeño de la barra lateral: saltar a cualquier día sin perder de
 * vista el mes.
 *
 * No duplica la navegación de arriba (esa mueve la vista un paso: mes a mes, semana a
 * semana). Ésta sirve para lo otro: «llévame al 27», que con las flechas son tres
 * clics y aquí es uno. Es el mismo par que tienen Google y Apple, y por lo mismo.
 *
 * El punto bajo el número dice que ese día tiene algo. Se pinta sólo con lo que YA
 * está cargado —la ventana que se está viendo—, así que en los meses de al lado no
 * aparece: prometer un punto por cada día del año costaría una consulta por cada
 * movimiento del ratón.
 */
export function MiniCalendario({
  mes,
  seleccionado,
  eventos,
  onMes,
  onDia,
}: {
  /** El mes que enseña el mini (puede ir por libre del que se está mirando). */
  mes: Date;
  seleccionado: Date;
  eventos: Evento[];
  onMes: (siguiente: Date) => void;
  onDia: (dia: Date) => void;
}) {
  const dias = rejillaDeMes(mes);
  const hoy = new Date();
  const semanaSeleccionada = inicioDeSemana(seleccionado).getTime();

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-2">
      <div className="mb-1 flex items-center justify-between gap-1">
        <button
          type="button"
          aria-label="Mes anterior"
          onClick={() => onMes(sumarMeses(mes, -1))}
          className="foco tap rounded-lg p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <span className="text-[12px] font-bold capitalize text-text-primary">{nombreDeMes(mes)}</span>
        <button
          type="button"
          aria-label="Mes siguiente"
          onClick={() => onMes(sumarMeses(mes, 1))}
          className="foco tap rounded-lg p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
        >
          <Icon name="chevron-right" size={14} />
        </button>
      </div>

      <div className="grid grid-cols-7">
        {DIAS_CORTOS.map((d) => (
          <span key={d} className="py-0.5 text-center text-[9.5px] font-bold uppercase text-text-tertiary">
            {d.charAt(0)}
          </span>
        ))}
        {dias.map((d) => {
          const esHoy = mismoDia(d, hoy);
          const activo = mismoDia(d, seleccionado);
          const delMes = d.getMonth() === mes.getMonth();
          const tiene = eventos.some((e) => cruzaElDia(e, d));
          // La semana entera se resalta: en vista de semana, saber en cuál se está es
          // más útil que saber qué día se pulsó, que ya lo dice el círculo.
          const enLaSemana = inicioDeSemana(d).getTime() === semanaSeleccionada;
          return (
            <button
              type="button"
              key={diaISO(d)}
              onClick={() => onDia(d)}
              className={`foco relative flex h-[26px] items-center justify-center text-[11.5px] font-semibold tabular-nums transition-colors ${
                enLaSemana ? "bg-surface-2" : ""
              } ${
                activo
                  ? "text-on-brand"
                  : delMes
                    ? esHoy
                      ? "text-brand"
                      : "text-text-secondary hover:text-text-primary"
                    : "text-text-tertiary/60"
              }`}
            >
              {activo && <span aria-hidden className="absolute h-[22px] w-[22px] rounded-full bg-brand" />}
              <span className="relative">{d.getDate()}</span>
              {tiene && !activo && (
                <span aria-hidden className="absolute bottom-[2px] h-[3px] w-[3px] rounded-full bg-brand" />
              )}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => { onMes(new Date()); onDia(sumarDias(hoy, 0)); }}
        className="foco mt-1 w-full rounded-lg px-2 py-1 text-[11.5px] font-semibold text-text-tertiary hover:bg-surface-2 hover:text-brand"
      >
        Ir a hoy
      </button>
    </div>
  );
}
