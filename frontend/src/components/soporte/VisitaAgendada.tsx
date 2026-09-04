"use client";

import Link from "next/link";
import { Icon } from "@/components/Icon";
import { TICKET_PRIORITY_TONE, TICKET_STATUS_LABEL } from "@/lib/support";

export type OrdenAgendada = {
  id: string; code: number | null; type: string; priority: string | null; status: string;
  seq: number | null; agendadaPor: string | null;
  /**
   * El puesto de la visita en la jornada, contando lo atrasado. Se pinta este y no
   * `seq`: `seq` numera dentro de un día y la jornada de hoy puede traer arrastradas
   * de días anteriores con su propia numeración — salían dos visitas como la "1".
   */
  puesto: number | null;
  /** Día para el que la agendó la cajera (ISO). */
  agendadaPara: string | null;
  /** Viene de un día anterior y sigue abierta: el sistema la arrastra al día de hoy. */
  atrasada: boolean;
  cliente: string | null; abonado: number | null; subscriberId: string | null;
  direccion: string | null; telefono: string | null; barrio: string | null; sede: string | null;
};
export type MiAgenda = {
  resolved: boolean; fecha: string; hoy: string; tecnico?: string;
  ordenes: OrdenAgendada[]; proximas: number;
  /**
   * La visita EN TURNO: la única que el técnico puede abrir ahora (2026-09-02). La
   * decide el backend con la misma regla que aplica su candado (`support/turno.ts`),
   * y no la pantalla eligiendo "la primera pendiente": si aquí se recalculara, el día
   * que las dos no coincidieran se le ofrecería una visita que la API le rechaza.
   * `null` = no le queda nada abierto hoy, y entonces no hay nada bloqueado.
   */
  enTurno: string | null;
  /**
   * Este técnico está EXENTO del turno (`Staff.agendaLibre`, 2026-09-02): ve su día
   * entero y puede abrir cualquiera de sus visitas.
   *
   * Viaja aparte y no como `enTurno: null` porque los dos casos se pintan al revés:
   * sin turno pendiente la pantalla felicita por el día terminado, y al exento con
   * seis visitas por delante eso sería mentirle.
   */
  turnoLibre?: boolean;
};

const TONO_BADGE: Record<string, string> = {
  error: "bg-error-soft text-error-text",
  warning: "bg-warning-soft text-warning-text",
  info: "bg-info-soft text-info-text",
  success: "bg-success-soft text-success-text",
  default: "bg-surface-2 text-text-secondary",
};

/**
 * "Atrasada · 6 ago": lo que viene arrastrado de un día anterior.
 *
 * Se dice SIEMPRE con el día original. Una visita que lleva desde el jueves sin
 * hacerse no puede llegar disfrazada de trabajo de hoy: quien la mira tiene que
 * poder llamar al cliente sabiendo cuánto lleva esperando.
 */
export function EtiquetaAtrasada({ desde }: { desde: string | null }) {
  const dia = desde
    ? new Date(`${desde.slice(0, 10)}T12:00:00`).toLocaleDateString("es-CO", { day: "2-digit", month: "short" })
    : null;
  return (
    <span className="inline-flex items-center gap-1 rounded bg-error-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-error-text">
      <Icon name="alert-triangle" size={10} />
      Atrasada{dia ? ` · ${dia}` : ""}
    </span>
  );
}

/** ¿Esta visita ya está hecha? Las cerradas no se quitan de la lista, se marcan. */
export const visitaLista = (o: OrdenAgendada) => o.status === "RESUELTO" || o.status === "ANULADA";

/**
 * Una visita de la agenda, con su número de orden de atención.
 *
 * El número es la instrucción — la razón de existir del agendamiento es que el
 * técnico vaya en ese orden. Las que ya cerró se tachan en vez de desaparecer: ver
 * las tres hechas y que la siguiente sea la 4 es justo lo que le dice por dónde va.
 */
export function VisitaAgendada({ o }: { o: OrdenAgendada }) {
  const lista = visitaLista(o);
  const tono = TICKET_PRIORITY_TONE[o.priority ?? ""] ?? "default";
  return (
    <Link
      href={`/soporte/${o.id}`}
      className={`flex items-start gap-2.5 rounded-lg border bg-surface p-3 transition-colors hover:border-border-strong ${
        lista ? "border-border-subtle opacity-60" : "border-border-subtle"
      }`}
    >
      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${
        lista ? "bg-success-soft text-success-text" : "bg-brand text-on-brand"
      }`}>
        {lista ? <Icon name="check" size={14} /> : o.puesto ?? o.seq ?? "•"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={`text-[13.5px] font-semibold text-text-primary ${lista ? "line-through" : ""}`}>{o.type}</span>
          <span className="font-mono text-[10.5px] text-text-tertiary">#{o.code ?? "—"}</span>
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${TONO_BADGE[tono]}`}>{o.priority ?? "—"}</span>
          {o.status === "REALIZANDO" && (
            <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[9px] font-bold uppercase text-warning-text">En curso</span>
          )}
          {lista && (
            <span className="rounded bg-success-soft px-1.5 py-0.5 text-[9px] font-bold uppercase text-success-text">
              {TICKET_STATUS_LABEL[o.status] ?? o.status}
            </span>
          )}
        </span>
        {o.cliente && (
          <span className="mt-0.5 block truncate text-[12px] text-text-secondary">
            {o.cliente}{o.abonado ? ` · ${o.abonado}` : ""}
          </span>
        )}
        {(o.direccion || o.barrio) && (
          <span className="mt-0.5 flex items-start gap-1 text-[11.5px] text-text-tertiary">
            <Icon name="map-pin" size={11} className="mt-0.5 shrink-0" />
            <span className="truncate">{o.direccion ?? ""}{o.barrio ? ` (${o.barrio})` : ""}</span>
          </span>
        )}
      </span>
      {o.telefono && !lista && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.location.href = `tel:${o.telefono}`; }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); window.location.href = `tel:${o.telefono}`; } }}
          className="tap flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-default text-text-secondary hover:bg-surface-2"
          aria-label={`Llamar a ${o.cliente ?? "el cliente"}`}
        >
          <Icon name="phone" size={15} />
        </span>
      )}
    </Link>
  );
}
