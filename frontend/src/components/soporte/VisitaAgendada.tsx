"use client";

import Link from "next/link";
import { Icon } from "@/components/Icon";
import { TICKET_PRIORITY_TONE, TICKET_STATUS_LABEL } from "@/lib/support";

export type OrdenAgendada = {
  id: string; code: number | null; type: string; priority: string | null; status: string;
  seq: number | null; agendadaPor: string | null;
  cliente: string | null; abonado: number | null; subscriberId: string | null;
  direccion: string | null; telefono: string | null; barrio: string | null; sede: string | null;
};
export type MiAgenda = {
  resolved: boolean; fecha: string; hoy: string; tecnico?: string;
  ordenes: OrdenAgendada[]; proximas: number;
};

const TONO_BADGE: Record<string, string> = {
  error: "bg-error-soft text-error-text",
  warning: "bg-warning-soft text-warning-text",
  info: "bg-info-soft text-info-text",
  success: "bg-success-soft text-success-text",
  default: "bg-surface-2 text-text-secondary",
};

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
        {lista ? <Icon name="check" size={14} /> : o.seq ?? "•"}
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
