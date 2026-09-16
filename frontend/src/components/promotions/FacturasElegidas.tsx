"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/context/AuthProvider";
import {
  type PendingInvoice, type PromotionDraft,
  alcanzaPorRegla, descuentoSobreFactura,
} from "@/lib/promotions";

const cop = (n: number) => `$${Math.round(Number(n || 0)).toLocaleString("es-CO")}`;
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const mesDe = (iso: string) => {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  return `${MESES[m - 1] ?? "?"} ${y}`;
};

/**
 * A qué facturas del cliente llega la promoción, marcadas una por una.
 *
 * Sólo aparece cuando el público es UN cliente. «También las atrasadas» es de todo o
 * nada; aquí, al que debe cinco se le pueden rebajar tres. Mientras nadie toque una
 * casilla, se marcan solas según lo del paso 1 (`invoiceIds = null`) y la promo sigue
 * esa regla; al tocar una, la lista pasa a ser exacta y manda sobre el tipo y la
 * antigüedad.
 *
 * Las que no se pueden rebajar salen apagadas y con el motivo: al cobrar se saltarían
 * en silencio, que es justo lo que hacía creer que "sólo deja una atrasada".
 */
export function FacturasElegidas({
  subscriberId, draft, onChange,
}: {
  subscriberId: string;
  draft: PromotionDraft;
  onChange: (ids: string[] | null) => void;
}) {
  const { authFetch } = useAuth();
  const [facturas, setFacturas] = useState<PendingInvoice[] | null>(null);

  useEffect(() => {
    let vivo = true;
    setFacturas(null);
    void authFetch(`/promotions/pending-invoices?subscriberId=${encodeURIComponent(subscriberId)}`)
      .then(async (r) => (r.ok ? r.json() : []))
      .then((d) => { if (vivo) setFacturas(Array.isArray(d) ? d : []); })
      .catch(() => { if (vivo) setFacturas([]); });
    return () => { vivo = false; };
  }, [authFetch, subscriberId]);

  const filas = useMemo(() => (facturas ?? []).map((f) => ({
    f,
    ...descuentoSobreFactura(draft.discountFormat, Number(draft.percentage), Number(draft.flatAmount), f),
  })), [facturas, draft.discountFormat, draft.percentage, draft.flatAmount]);

  const aMano = draft.invoiceIds !== null;
  const elegidas = useMemo(() => new Set(
    draft.invoiceIds ?? filas.filter((x) => !x.motivo && !x.tope && alcanzaPorRegla(draft, x.f)).map((x) => x.f.id),
  ), [draft, filas]);

  const posibles = filas.filter((x) => !x.motivo);
  const rebaja = filas.filter((x) => elegidas.has(x.f.id) && !x.motivo).reduce((a, x) => a + x.monto, 0);

  function alternar(id: string) {
    const next = new Set(elegidas);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange([...next]);
  }

  if (!facturas) {
    return <p className="text-[12px] text-text-tertiary">Cargando las facturas del cliente…</p>;
  }
  if (!facturas.length) {
    return (
      <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-text-tertiary">
        Este cliente no debe ninguna factura hoy. La promoción le llegará a las que se le
        facturen dentro de la vigencia, según lo elegido en el paso 1.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-[11px] font-semibold text-text-tertiary">
          ¿A qué facturas se le aplica?
        </span>
        <span className="flex gap-2 text-[11.5px] font-semibold">
          <button type="button" className="tap text-brand hover:underline"
            onClick={() => onChange(posibles.map((x) => x.f.id))}>
            Todas
          </button>
          <button type="button" className="tap text-brand hover:underline" onClick={() => onChange([])}>
            Ninguna
          </button>
          {aMano && (
            <button type="button" className="tap text-text-tertiary hover:underline" onClick={() => onChange(null)}>
              Como el paso 1
            </button>
          )}
        </span>
      </div>

      <ul className="max-h-56 overflow-y-auto rounded-lg border border-border-subtle">
        {filas.map(({ f, monto, motivo, tope }) => {
          const on = elegidas.has(f.id) && !motivo;
          return (
            <li key={f.id} className="border-b border-border-subtle last:border-b-0">
              <label className={`flex items-start gap-2.5 px-3 py-2 ${motivo ? "opacity-60" : "cursor-pointer hover:bg-surface-2"}`}>
                <input type="checkbox" className="mt-0.5 accent-brand"
                  checked={on} disabled={!!motivo} onChange={() => alternar(f.id)} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="text-[13px] font-semibold text-text-primary">
                      {mesDe(f.invoiceDate)}
                      <span className="ml-1.5 font-mono text-[11px] font-normal text-text-tertiary">#{f.tid}</span>
                    </span>
                    <span className="font-mono text-[12.5px] tabular-nums text-text-primary">
                      debe {cop(f.saldo)}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-baseline justify-between gap-x-2 text-[11.5px] text-text-tertiary">
                    <span className="min-w-0 truncate">
                      {f.kind === "FIJA" ? "Cargo" : "Mensualidad"}{f.concepto ? ` · ${f.concepto}` : ""}
                    </span>
                    {motivo
                      ? <span className="text-warning-text">{motivo}</span>
                      : monto > 0 && (
                        <span className="tabular-nums">
                          −{cop(monto)}{tope ? " · todo lo que debe" : ""}
                        </span>
                      )}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <p className="text-[11.5px] text-text-tertiary">
        {elegidas.size === 0 || rebaja === 0
          ? "Marca al menos una factura."
          : <>Rebaja <b className="font-semibold tabular-nums text-text-primary">{cop(rebaja)}</b> en {
              [...elegidas].filter((id) => posibles.some((x) => x.f.id === id)).length
            } factura(s). {aMano ? "Sólo esas: lo del paso 1 ya no cuenta." : "Marcadas según el paso 1."}</>}
      </p>
    </div>
  );
}
