"use client";

import { useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Select } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";
import { useRequest } from "@/lib/useRequest";
import { formatearDistancia } from "@/lib/geo";
import { fmtDate } from "@/lib/format";

type Caso = {
  id: string;
  code: number | null;
  type: string | null;
  tecnico: string | null;
  fecha: string | null;
  distanciaM: number | null;
  precisionM: number | null;
  justificacion: string | null;
  cierre: { lat: number; lng: number } | null;
  cliente: { id: string; abonado: number; nombre: string | null; punto: { lat: number; lng: number } | null } | null;
};

type Informe = {
  dias: number;
  modo: "off" | "observar" | "exigir";
  radioM: number;
  resumen: { fuera: number; dentro: number; sinDato: number };
  casos: Caso[];
};

const MODO_TEXTO: Record<Informe["modo"], { label: string; tone: "warning" | "success" | "default"; ayuda: string }> = {
  observar: {
    label: "Observando",
    tone: "warning",
    ayuda:
      "La cerca NO bloquea todavía: solo registra. Estos son los cierres que se habrían frenado. Cuando el número te parezca razonable, pásala a Exigir.",
  },
  exigir: {
    label: "Exigiendo",
    tone: "success",
    ayuda:
      "La cerca bloquea. Estos cierres se hicieron fuera de rango justificando el motivo.",
  },
  off: {
    label: "Desactivada",
    tone: "default",
    ayuda: "La cerca está apagada; no se comprueba nada al cerrar órdenes.",
  },
};

export default function GeocercaPage() {
  const { loading: authLoading } = useAuth();
  const [dias, setDias] = useState("30");

  const inf = useRequest<Informe>(() => `/support/geofence-report?dias=${dias}`, [dias], {
    saltar: authLoading,
  });

  if (authLoading || (inf.cargando && !inf.data)) return <PageSkeleton />;
  if (inf.error) return <LoadError message={inf.error} onRetry={inf.refrescar} />;
  if (!inf.data) return null;

  const d = inf.data;
  const modo = MODO_TEXTO[d.modo];
  const comprobados = d.resumen.fuera + d.resumen.dentro;
  const pctFuera = comprobados ? Math.round((100 * d.resumen.fuera) / comprobados) : 0;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHeading
          icon="map-pin"
          title="Geo-cerca de cierres"
          subtitle="Órdenes de campo cerradas lejos del domicilio del cliente"
        />
        <div className="flex items-center gap-2">
          <Badge tone={modo.tone} label={modo.label} />
          <Select value={dias} onChange={(e) => setDias(e.target.value)} className="w-auto">
            <option value="7">7 días</option>
            <option value="30">30 días</option>
            <option value="90">90 días</option>
          </Select>
        </div>
      </div>

      <p className="mb-3 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
        {modo.ayuda} Radio actual: <strong>{d.radioM} m</strong> (más el margen de error que reporte
        cada GPS).
      </p>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tarjeta
          titulo="Fuera de rango"
          valor={d.resumen.fuera}
          detalle={comprobados ? `${pctFuera}% de los cierres comprobados` : "sin cierres comprobados"}
          tono="error"
        />
        <Tarjeta titulo="Dentro de rango" valor={d.resumen.dentro} detalle="cierres correctos" tono="success" />
        <Tarjeta
          titulo="Sin comprobar"
          valor={d.resumen.sinDato}
          detalle="órdenes remotas, exentos o clientes sin coordenada"
          tono="neutral"
        />
      </div>

      {d.casos.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-10 text-center">
          <Icon name="check" size={22} className="text-success-text" />
          <p className="mt-2 text-[13px] text-text-secondary">
            Ningún cierre fuera de rango en este periodo.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
          <table className="w-full min-w-[820px] text-[12.5px]">
            <thead className="border-b border-border-subtle bg-surface-2 text-left text-text-tertiary">
              <tr>
                <th className="px-3 py-2 font-semibold">Orden</th>
                <th className="px-3 py-2 font-semibold">Tipo</th>
                <th className="px-3 py-2 font-semibold">Técnico</th>
                <th className="px-3 py-2 font-semibold">Cliente</th>
                <th className="px-3 py-2 text-right font-semibold">Distancia</th>
                <th className="px-3 py-2 font-semibold">Motivo dado</th>
                <th className="px-3 py-2 font-semibold">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {d.casos.map((c) => (
                <tr key={c.id} className="border-b border-border-subtle last:border-0">
                  <td className="px-3 py-2">
                    <Link href={`/soporte/${c.id}`} className="font-semibold text-brand hover:underline">
                      #{c.code ?? "—"}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-text-secondary">{c.type ?? "—"}</td>
                  <td className="px-3 py-2 text-text-primary">{c.tecnico ?? "—"}</td>
                  <td className="px-3 py-2">
                    {c.cliente ? (
                      <Link href={`/clientes/${c.cliente.id}`} className="text-text-primary hover:text-brand hover:underline">
                        {c.cliente.nombre ?? `#${c.cliente.abonado}`}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="font-bold text-error-text">
                      {c.distanciaM != null ? formatearDistancia(Math.round(c.distanciaM)) : "—"}
                    </span>
                    {/* La precisión es la diferencia entre "hizo trampa" y "el GPS
                        no agarraba". Sin ella la distancia sola acusa a ciegas. */}
                    {c.precisionM != null && (
                      <span className="block text-[11px] text-text-tertiary">
                        GPS ±{Math.round(c.precisionM)} m
                      </span>
                    )}
                  </td>
                  <td className="max-w-[260px] px-3 py-2 text-text-secondary">
                    {c.justificacion ?? (
                      <span className="text-text-tertiary">— (no se pidió: modo observación)</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-text-tertiary">{c.fecha ? fmtDate(c.fecha) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Tarjeta({
  titulo,
  valor,
  detalle,
  tono,
}: {
  titulo: string;
  valor: number;
  detalle: string;
  tono: "error" | "success" | "neutral";
}) {
  const color =
    tono === "error" ? "text-error-text" : tono === "success" ? "text-success-text" : "text-text-primary";
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4">
      <p className="text-[12px] text-text-tertiary">{titulo}</p>
      <p className={`text-[24px] font-bold leading-tight ${color}`}>{valor.toLocaleString("es-CO")}</p>
      <p className="text-[11.5px] text-text-tertiary">{detalle}</p>
    </div>
  );
}
