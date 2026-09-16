"use client";

import Link from "next/link";
import { Icon } from "@/components/Icon";

/** Cómo terminó esa visita. Lo decide el servidor (`AgendaService.miHistorial`). */
export type ResultadoVisita = "CERRADA" | "ANULADA" | "NO_ATENDIDA";

export type VisitaHechaT = {
  id: string; code: number | null; type: string; status: string;
  resultado: ResultadoVisita;
  cerradaEl: string | null; apartadaEl: string | null;
  puntaje: number | null;
  cliente: string | null; abonado: number | null;
  direccion: string | null; barrio: string | null;
  noAtendida: { fecha: string; motivo: string | null; por: string | null } | null;
  /** Qué quedó guardado de esa visita. Es lo que el técnico viene a buscar. */
  documentacion: { seguimiento: number; fotos: number; material: number; firma: boolean };
};

export type MiHistorial = {
  resolved: boolean; desde: string; hasta: string; hoy: string; tecnico?: string;
  total: number;
  /** La consulta llegó al tope de filas: hay más trabajo del que se está enseñando. */
  truncado: boolean;
  dias: { fecha: string; cuantas: number; ordenes: VisitaHechaT[] }[];
};

const MARCA: Record<ResultadoVisita, { icono: string; clase: string; texto: string }> = {
  CERRADA: { icono: "check", clase: "bg-success-soft text-success-text", texto: "Cerrada" },
  ANULADA: { icono: "ban", clase: "bg-error-soft text-error-text", texto: "Anulada" },
  NO_ATENDIDA: { icono: "alert-triangle", clase: "bg-warning-soft text-warning-text", texto: "No se pudo atender" },
};

/** Un dato de documentación. Sin él, saber si hay foto obliga a abrir la orden. */
function Sello({ icono, texto }: { icono: string; texto: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-medium text-text-secondary">
      <Icon name={icono} size={11} /> {texto}
    </span>
  );
}

/**
 * Una visita YA HECHA, en el historial del técnico.
 *
 * Es hermana de `VisitaAgendada` y a propósito NO es la misma: lo que hace falta de
 * una visita pasada no es el puesto ni el botón de llamar, sino cómo terminó y QUÉ
 * quedó documentado —cuántas fotos, si firmó el cliente, qué material se gastó—.
 * Toda la tarjeta lleva al detalle de la orden, que es donde se ve esa documentación
 * entera (el turno deja abrir las cerradas siempre: ver `support/turno.ts`).
 */
export function VisitaHecha({ o }: { o: VisitaHechaT }) {
  const m = MARCA[o.resultado] ?? MARCA.CERRADA;
  const d = o.documentacion;
  const sinNada = !d.seguimiento && !d.fotos && !d.material && !d.firma;
  return (
    <Link
      href={`/soporte/${o.id}`}
      className="tap flex items-start gap-2.5 rounded-lg border border-border-subtle bg-surface p-3 transition-colors hover:border-border-strong"
    >
      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${m.clase}`}>
        <Icon name={m.icono} size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13.5px] font-semibold text-text-primary">{o.type}</span>
          <span className="font-mono text-[10.5px] text-text-tertiary">#{o.code ?? "—"}</span>
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${m.clase}`}>{m.texto}</span>
          {/* Una visita que no se pudo atender y que DESPUÉS se cerró aparece dos
              veces (dos días, dos viajes). Se dice aquí para que no parezca un
              duplicado ni una orden que quedó a medias. */}
          {o.resultado === "NO_ATENDIDA" && (o.status === "RESUELTO" || o.status === "ANULADA") && (
            <span className="text-[10.5px] text-text-tertiary">· se cerró después</span>
          )}
          {o.puntaje != null && (
            <span className="inline-flex items-center gap-1 rounded bg-brand-soft px-1.5 py-0.5 text-[9.5px] font-bold text-brand">
              <Icon name="star" size={10} /> {o.puntaje}
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
        {/* El motivo por el que no se pudo: es lo primero que se pregunta al mirar
            atrás, y está guardado desde que la apartó. */}
        {o.resultado === "NO_ATENDIDA" && o.noAtendida?.motivo && (
          <span className="mt-1 block rounded bg-warning-soft px-2 py-1 text-[11.5px] text-warning-text">
            {o.noAtendida.motivo}
          </span>
        )}
        <span className="mt-1.5 flex flex-wrap items-center gap-1">
          {d.fotos > 0 && <Sello icono="camera" texto={`${d.fotos} ${d.fotos === 1 ? "foto" : "fotos"}`} />}
          {d.seguimiento > 0 && <Sello icono="message-square" texto={`${d.seguimiento} ${d.seguimiento === 1 ? "nota" : "notas"}`} />}
          {d.material > 0 && <Sello icono="boxes" texto={`${d.material} ${d.material === 1 ? "material" : "materiales"}`} />}
          {d.firma && <Sello icono="file-signature" texto="Firmada" />}
          {sinNada && <span className="text-[11px] italic text-text-tertiary">Sin documentación guardada</span>}
        </span>
      </span>
      <Icon name="chevron-right" size={16} className="mt-1 shrink-0 text-text-tertiary" />
    </Link>
  );
}
