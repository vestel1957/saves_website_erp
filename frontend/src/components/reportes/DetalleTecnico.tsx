"use client";

import Link from "next/link";
import { DataTable } from "@/components/ui/DataTable";
import { nfmt } from "@/lib/reportes";

/**
 * Detalle de rendimiento de una persona: en qué tipo de trabajo falla y qué
 * órdenes concretas trajeron queja.
 *
 * Es solo presentación —recibe los datos ya cargados— porque lo pintan dos
 * pantallas que los piden a endpoints distintos: el tablero de /reportes usa
 * `/reports/tecnicos/:id` (área gerencia) y la ficha del empleado usa
 * `/staff/:id/rendimiento` (permiso de RRHH). Duplicar el markup habría hecho
 * que las dos vistas se separaran en el primer retoque.
 *
 * El desglose por tipo es lo que hace útil el porcentaje: casi nunca "el
 * técnico" está mal entero — está mal en UN tipo de trabajo (bien en revisiones,
 * flojo en instalaciones). Eso se corrige con acompañamiento puntual.
 */

export const pctTxt = (n: number | null) => (n == null ? "—" : `${n}%`);

/**
 * Qué tan mal está una re-visita comparada con la mediana del equipo.
 *
 * La comparación va en PUNTOS porcentuales y no en veces: con una mediana de
 * 10%, "el doble" son 10 puntos y "el triple" 20, y a esa escala cualquiera con
 * pocas órdenes salta al rojo por una sola queja. La diferencia absoluta es más
 * estable.
 *
 * Devuelve un nivel y no un color porque lo consumen dos vistas que lo pintan
 * distinto (una con clases de texto, otra con el `tone` de una tarjeta). La
 * regla, que es lo que importa, queda definida una sola vez.
 */
export type NivelRevisita = "malo" | "regular" | "bueno" | "neutro";

export function nivelRevisita(pct: number | null, mediana: number | null, muestraSuficiente: boolean): NivelRevisita {
  if (pct == null || mediana == null || !muestraSuficiente) return "neutro";
  const d = pct - mediana;
  if (d >= 5) return "malo";
  if (d >= 2) return "regular";
  if (d <= -3) return "bueno";
  return "neutro";
}

export type CasoRevisita = {
  id: string;
  code: number | null;
  tipo: string;
  fecha: string;
  abonado: string | null;
  cliente: string | null;
  queja: string | null;
  quejaFecha: string | null;
};

export type FilaPorTipo = {
  tipo: string;
  cerradas: number;
  revisitas: number;
  revisitaPct: number | null;
  /** Puntos que sumó este tipo de trabajo en el periodo. */
  puntos: number;
};

export function DetalleTecnico({
  porTipo,
  casos,
  ventanaDias,
}: {
  porTipo: FilaPorTipo[];
  casos: CasoRevisita[];
  /** Ventana de la re-visita, para nombrarla en el texto de "sin casos". */
  ventanaDias?: number;
}) {
  return (
    <div className="flex flex-col gap-4">
      {porTipo.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Por tipo de trabajo</div>
          <DataTable rows={porTipo} empty="Sin órdenes cerradas." columns={[
            { key: "t", header: "Tipo de trabajo", render: (r: FilaPorTipo) => r.tipo },
            { key: "c", header: "Cerradas", align: "right", render: (r: FilaPorTipo) => nfmt(r.cerradas) },
            { key: "pts", header: "Puntos", align: "right", render: (r: FilaPorTipo) => (
              <span title={r.cerradas ? `${Math.round((10 * (r.puntos ?? 0)) / r.cerradas) / 10} puntos por orden` : undefined}>
                {nfmt(r.puntos ?? 0)}
              </span>
            ) },
            { key: "v", header: "Volvieron", align: "right", render: (r: FilaPorTipo) => nfmt(r.revisitas) },
            { key: "p", header: "Re-visita", align: "right", render: (r: FilaPorTipo) => (
              <span className={r.revisitaPct == null ? "text-text-tertiary" : r.revisitaPct >= 20 ? "text-error-text font-semibold" : r.revisitaPct >= 12 ? "text-warning-text font-semibold" : "text-success-text"}>
                {pctTxt(r.revisitaPct)}
              </span>
            ) },
          ]} />
        </div>
      )}

      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Órdenes que trajeron queja</div>
        {!casos.length ? (
          <p className="text-[12px] text-success-text">
            Ninguna orden suya trajo queja del cliente{ventanaDias ? ` dentro de los ${ventanaDias} días siguientes` : ""} en el periodo.
          </p>
        ) : (
          <DataTable rows={casos} empty="Sin casos." columns={[
            { key: "code", header: "Orden", render: (r: CasoRevisita) => <Link href={`/soporte/${r.id}`} className="font-mono text-brand hover:underline">#{r.code ?? "—"}</Link> },
            { key: "tipo", header: "Trabajo hecho", render: (r: CasoRevisita) => r.tipo },
            { key: "fecha", header: "Fecha", render: (r: CasoRevisita) => new Date(r.fecha).toLocaleDateString("es-CO") },
            { key: "cliente", header: "Cliente", render: (r: CasoRevisita) => r.cliente ?? (r.abonado ? `Abonado ${r.abonado}` : "—") },
            { key: "queja", header: "Volvió por", render: (r: CasoRevisita) => <span className="text-warning-text">{r.queja}</span> },
            { key: "qf", header: "Días después", align: "right", render: (r: CasoRevisita) =>
              r.quejaFecha ? Math.round((new Date(r.quejaFecha).getTime() - new Date(r.fecha).getTime()) / 86400000) : "—" },
          ]} />
        )}
      </div>
    </div>
  );
}
