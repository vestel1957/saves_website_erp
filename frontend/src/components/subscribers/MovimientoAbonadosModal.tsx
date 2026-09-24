"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";
import { SUB_STATUS_LABEL, SUB_STATUS_TONE } from "@/lib/subscribers";

export type TipoMovimiento = "nuevos" | "retiros";

type Fila = {
  id: string;
  legacyId: number | null;
  abonado: number;
  nombre: string;
  documento: string | null;
  celular: string | null;
  direccion: string | null;
  sede: string | null;
  estado: string | null;
  fecha: string | null;
  motivo: string | null;
  orden: number | null;
};

/** Fecha y hora de Colombia: `createdAt` y `statusChangedAt` van en UTC. */
function fechaCol(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  // Las fechas de contrato/ingreso (altas de antes del sync vivo) son un `date` a
  // medianoche UTC: pintadas en Bogotá se correrían al día anterior.
  if (iso.endsWith("T00:00:00.000Z")) return d.toLocaleDateString("es-CO", { timeZone: "UTC" });
  return d.toLocaleString("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Quiénes son los "Abonados nuevos" o los "Retiros" de la card del panel ejecutivo.
 * Pide `GET /dashboard/abonados` con el MISMO rango y la misma sede de la card, así que
 * el total de la lista es la cifra que se acaba de pinchar.
 */
export function MovimientoAbonadosModal({ tipo, desde, hasta, sede, periodo, onClose }: {
  tipo: TipoMovimiento | null;
  desde: string;
  hasta: string;
  sede: string;
  periodo: string;
  onClose: () => void;
}) {
  const { authFetch } = useAuth();
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [err, setErr] = useState(false);
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    if (!tipo) return;
    let vivo = true;
    setFilas(null);
    setErr(false);
    const qs = new URLSearchParams({ tipo, from: desde, to: hasta, ...(sede ? { sede } : {}) });
    void authFetch(`/dashboard/abonados?${qs}`)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((j) => { if (vivo) setFilas(j.abonados ?? []); })
      .catch(() => { if (vivo) setErr(true); });
    return () => { vivo = false; };
  }, [authFetch, tipo, desde, hasta, sede, intento]);

  const retiros = tipo === "retiros";
  const titulo = retiros ? "Retiros" : "Abonados nuevos";

  return (
    <Modal open={tipo != null} onClose={onClose} title={`${titulo}${filas ? ` · ${filas.length}` : ""}`} maxWidth="max-w-5xl">
      <p className="mb-3 text-[12px] text-text-tertiary">
        {periodo} ·{" "}
        {retiros
          ? "abonados que hoy están RETIRADOS y pasaron a ese estado en el periodo (un retiro que se deshizo no cuenta)."
          : "números de abonado creados en el periodo, estén ya instalados o pendientes de instalar."}
      </p>
      {err ? (
        <LoadError message="No se pudo cargar el listado." onRetry={() => setIntento((n) => n + 1)} />
      ) : (
        <div className="max-h-[65vh] overflow-auto">
          <DataTable<Fila>
            rows={filas ?? []}
            loading={filas == null}
            empty={retiros ? "Sin retiros en el periodo." : "Sin abonados nuevos en el periodo."}
            rowHref={(r) => `/clientes/${r.id}`}
            columns={[
              { key: "nombre", header: "Cliente", render: (r) => (
                <div className="min-w-0">
                  <div className="font-semibold text-text-primary">{r.nombre}</div>
                  <div className="text-[11px] text-text-tertiary">{r.documento ?? "—"}{r.celular ? ` · ${r.celular}` : ""}</div>
                </div>
              ) },
              { key: "abonado", header: "Abonado", render: (r) => <span className="font-mono text-text-secondary">{r.abonado}</span> },
              { key: "fecha", header: retiros ? "Retirado" : "Alta", sortValue: (r) => r.fecha ?? "", render: (r) => <span className="whitespace-nowrap">{fechaCol(r.fecha)}</span> },
              { key: "sede", header: "Sede", render: (r) => r.sede ?? "—" },
              retiros
                ? { key: "motivo", header: "Motivo", render: (r) => <span className="text-[12px] text-text-secondary">{r.motivo ?? "—"}</span> }
                : { key: "direccion", header: "Dirección", render: (r) => <span className="text-[12px] text-text-secondary">{r.direccion ?? "—"}</span> },
              { key: "estado", header: "Estado hoy", render: (r) => r.estado
                ? <Badge label={SUB_STATUS_LABEL[r.estado] ?? r.estado} tone={SUB_STATUS_TONE[r.estado] ?? "default"} />
                : "—" },
            ]}
          />
        </div>
      )}
    </Modal>
  );
}
