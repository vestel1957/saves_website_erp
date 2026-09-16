"use client";

import Link from "next/link";
import { Icon } from "@/components/Icon";
import { TICKET_PRIORITY_TONE } from "@/lib/support";
import { EtiquetaAtrasada, type OrdenAgendada } from "@/components/soporte/VisitaAgendada";
import { AvisoEquipo } from "@/components/soporte/AvisoEquipo";

const TONO_BADGE: Record<string, string> = {
  error: "bg-error-soft text-error-text",
  warning: "bg-warning-soft text-warning-text",
  info: "bg-info-soft text-info-text",
  success: "bg-success-soft text-success-text",
  default: "bg-surface-2 text-text-secondary",
};

/**
 * La visita que le toca al técnico AHORA, y solo esa.
 *
 * Con el turno obligatorio (2026-08-04, retirado el 28, restituido el 2026-09-02 y
 * **fijo para el técnico desde el 2026-09-10**) esta tarjeta es la única de la
 * pantalla: ve una visita y hasta que no la cierra no aparece la siguiente. El
 * candado de verdad está en el backend (`support/turno.ts`), así que esto no es un
 * adorno de interfaz.
 *
 * **Ya no lleva "No se pudo atender"** (2026-09-10, del requerimiento: «los técnicos
 * no podrán saltarse órdenes una vez documentadas; si no pueden realizar una orden,
 * deberán comunicarse con la persona encargada del agendamiento»). Era el último
 * camino por el que sacaba una visita de su día por su cuenta. En su lugar queda
 * dicho a quién avisar; quien agenda la mueve o la reasigna y con eso se destapa.
 * El endpoint también se le cerró (`AgendaService.noSePudoAtender`): quitar el botón
 * y dejar la puerta abierta no es quitar nada.
 *
 * Lleva dirección, barrio y teléfono a la vista y no detrás de un clic: es lo que
 * necesita antes de arrancar, y abrir la orden para leerlo le cuesta datos en la calle.
 *
 * El contador de arriba ("2 de 6") no es adorno: es lo único que impide que una
 * pantalla con una sola tarjeta se lea como "esto es todo lo que hay". Lleva el puesto
 * de la visita dentro de la jornada, que con el turno vuelve a ser una instrucción y
 * no una sugerencia — es el orden en que se atienden.
 */
export function VisitaDeHoy({
  o,
  posicion,
  total,
  libre = false,
}: {
  o: OrdenAgendada;
  /** Cuál es de la jornada, contando las que ya cerró. Sin esto no se pinta el contador. */
  posicion?: number;
  total?: number;
  /**
   * El técnico está exento del turno (`Staff.agendaLibre`): esta tarjeta deja de ser
   * "la única que puedes abrir" y pasa a ser por dónde le toca empezar. Sólo cambia
   * el rótulo — decirle "tu visita ahora" a quien tiene el día entero delante y puede
   * elegir sería describirle una regla que a él no le rige.
   */
  libre?: boolean;
}) {
  const tono = TICKET_PRIORITY_TONE[o.priority ?? ""] ?? "default";

  return (
    <div className="flex flex-col gap-3 rounded-xl border-2 border-brand/50 bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 rounded-full bg-brand px-3 py-1 text-[11.5px] font-bold uppercase tracking-wide text-on-brand">
          <Icon name="arrow-right" size={13} /> {libre ? "Empieza por aquí" : "Tu visita ahora"}
        </span>
        {posicion && total ? (
          <span className="text-[12px] font-semibold text-text-secondary">
            {posicion} de {total}
          </span>
        ) : null}
      </div>

      <div>
        <div className="flex flex-wrap items-center gap-1.5">
          <h2 className="text-[17px] font-bold text-text-primary">{o.type}</h2>
          <span className="font-mono text-[11px] text-text-tertiary">#{o.code ?? "—"}</span>
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${TONO_BADGE[tono]}`}>
            {o.priority ?? "—"}
          </span>
          {o.status === "REALIZANDO" && (
            <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[9px] font-bold uppercase text-warning-text">
              En curso
            </span>
          )}
          {o.atrasada && <EtiquetaAtrasada desde={o.agendadaPara} />}
          {/* Con qué caja se va a esta casa. Aquí es donde más falta hace: es la
              visita que el técnico está a punto de hacer. */}
          <AvisoEquipo equipo={o.equipo} />
        </div>
        {o.cliente && (
          <p className="mt-1 text-[14px] font-semibold text-text-primary">
            {o.cliente}
            {o.abonado ? <span className="font-normal text-text-tertiary"> · {o.abonado}</span> : null}
          </p>
        )}
        {(o.direccion || o.barrio) && (
          <p className="mt-1 flex items-start gap-1.5 text-[13px] text-text-secondary">
            <Icon name="map-pin" size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
            <span>
              {o.direccion ?? ""}
              {o.barrio ? ` (${o.barrio})` : ""}
            </span>
          </p>
        )}
      </div>

      {/* Llamar y "cómo llegar" van ARRIBA del botón de abrir: son lo que necesita
          antes de tocar la puerta, no después. */}
      <div className="flex flex-wrap gap-2">
        {o.telefono && (
          <a
            href={`tel:${o.telefono}`}
            className="tap inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-border-default px-3 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-2"
          >
            <Icon name="phone" size={14} /> Llamar
          </a>
        )}
        {o.subscriberId && (
          <Link
            href={`/mapa/ruta?abonado=${o.subscriberId}&volver=${encodeURIComponent("/mi-agenda")}`}
            className="tap inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-border-default px-3 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-2"
          >
            <Icon name="map-pin" size={14} /> Cómo llegar
          </Link>
        )}
      </div>

      <Link
        href={`/soporte/${o.id}`}
        className="tap inline-flex min-h-[46px] items-center justify-center gap-2 rounded-lg bg-brand px-4 text-[14px] font-bold text-on-brand transition-opacity hover:opacity-90 sm:self-start sm:px-8"
      >
        <Icon name="clipboard-check" size={16} /> Abrir la orden
      </Link>

      {/* A quién avisar cuando no se puede hacer. No es un botón: la visita ya no
          sale del día por decisión del técnico (2026-09-10). */}
      <p className="flex items-start gap-1.5 text-[11.5px] text-text-tertiary">
        <Icon name="info" size={13} className="mt-0.5 shrink-0" />
        <span>
          ¿No puedes hacer esta visita? Comunícate con la persona encargada del
          agendamiento para que la reprograme.
        </span>
      </p>
    </div>
  );
}
