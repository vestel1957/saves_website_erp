"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { useAuth } from "@/context/AuthProvider";
import { CierreArqueo, type CierreDetalle } from "@/components/treasury/CierreArqueo";

export type { CierreDetalle };

const fecha = (d: string | null) => (d ? new Date(d).toLocaleDateString("es-CO") : "—");

/**
 * Detalle de un cierre: de qué está hecho el arqueo y qué movimientos lo componen.
 *
 * Antes el cierre era una caja negra —solo totales y un PDF—, así que un descuadre no
 * se podía investigar, que es justo para lo que existe un arqueo.
 *
 * El contenido vive en `CierreArqueo`: la cajera lo ve a pantalla completa en
 * /tesoreria/cierres, y aquí va dentro del modal para quien administra.
 */
export function CierreDetalleModal({ closeId, open, onClose }: {
  closeId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { authFetch } = useAuth();
  const [d, setD] = useState<CierreDetalle | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open || !closeId) return;
    setD(null); setErr("");
    void authFetch(`/treasury/cash-closes/${closeId}`)
      .then(async (r) => {
        if (!r.ok) { setErr(`No se pudo cargar el cierre (${r.status}).`); return; }
        setD(await r.json());
      })
      .catch(() => setErr("No se pudo cargar el cierre."));
  }, [open, closeId, authFetch]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={d ? `Cierre · ${d.account?.holder ?? `Caja #${d.cashAccountId}`} · ${fecha(d.date)}` : "Cierre de caja"}
      maxWidth="max-w-4xl"
    >
      {err && <div className="rounded-lg bg-error-soft px-3 py-2 text-sm text-error-text">{err}</div>}
      {!d && !err && <div className="py-8 text-center text-sm text-text-secondary">Cargando…</div>}

      {d && <CierreArqueo d={d} />}
    </Modal>
  );
}
