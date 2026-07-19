"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";

type Movimiento = {
  id: string;
  date: string;
  type: "INCOME" | "EXPENSE" | "TRANSFER";
  category: string;
  transfer: boolean;
  /** Es una de las patas 'Saldo <fecha>' del arrastre, no un movimiento del día. */
  arrastre: boolean;
  /** Cuenta como efectivo del cajón (y por tanto se barre al cerrar). */
  efectivo: boolean;
  amount: number;
  payer: string;
  subscriberId: string | null;
  method: string | null;
  note: string | null;
  invoice: { id: string; tid: number } | null;
};

/**
 * Desglose informativo del efectivo. OJO: el excedente NO se calcula sumando estas
 * líneas — el excedente ES el efectivo del cajón. El arrastre ya viene dentro porque
 * entró como una transacción 'Saldo <fecha>'. Estas líneas sólo explican de qué se
 * compone.
 */
type Desglose = {
  arrastre: number;
  ventas: number;
  egresos: number;
  transferencias: number;
  noEfectivo: number;
};

export type CierreDetalle = {
  id: string | null;
  date: string;
  cashAccountId: number;
  account: { holder: string; accountNumber: string | null } | null;
  yaCerrado: boolean;
  cajero: string | null;
  cerradoEl: string | null;
  proximoDiaHabil: string;
  /** El excedente que se barrió al cerrar (null si aún no se ha cerrado). */
  guardado: number | null;
  efectivo: number;
  excedente: number;
  desglose: Desglose;
  descuadrado: boolean;
  porCategoria: { category: string; type: string; n: number; total: number }[];
  movimientos: Movimiento[];
};

const fecha = (d: string | null) => (d ? new Date(d).toLocaleDateString("es-CO") : "—");

/** Una línea del arqueo. `strong` para el resultado, `muted` para lo informativo. */
function Linea({ label, value, hint, sign, strong, muted }: {
  label: string; value: number; hint?: string;
  sign?: "+" | "−"; strong?: boolean; muted?: boolean;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-1.5 ${strong ? "border-t border-border-default pt-2.5 mt-1" : ""}`}>
      <span className={`text-[13px] ${muted ? "text-text-tertiary" : "text-text-secondary"} ${strong ? "font-semibold text-text-primary" : ""}`}>
        {label}
        {hint && <span className="ml-1.5 text-[11px] text-text-tertiary">{hint}</span>}
      </span>
      <span className={`tabular-nums ${strong ? "text-base font-semibold" : "text-[13px]"} ${
        sign === "−" ? "text-error-text" : sign === "+" ? "text-success-text" : "text-text-primary"
      }`}>
        {sign && value !== 0 ? (sign === "−" ? "−" : "+") : ""}{cop(Math.abs(value))}
      </span>
    </div>
  );
}

/**
 * Detalle de un cierre: de qué está hecho el arqueo y qué movimientos lo componen.
 *
 * Antes el cierre era una caja negra —solo totales y un PDF—, así que un descuadre no
 * se podía investigar, que es justo para lo que existe un arqueo.
 */
export function CierreDetalleModal({ closeId, open, onClose }: {
  closeId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { authFetch } = useAuth();
  const [d, setD] = useState<CierreDetalle | null>(null);
  const [err, setErr] = useState("");
  const [soloPagos, setSoloPagos] = useState(false);

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

  const movs = d?.movimientos.filter((m) => (soloPagos ? m.type === "INCOME" && !m.transfer : true)) ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={d ? `Cierre · ${d.account?.holder ?? `Caja #${d.cashAccountId}`} · ${fecha(d.date)}` : "Cierre de caja"}
      maxWidth="max-w-4xl"
    >
      {err && <div className="rounded-lg bg-error-soft px-3 py-2 text-sm text-error-text">{err}</div>}
      {!d && !err && <div className="py-8 text-center text-sm text-text-secondary">Cargando…</div>}

      {d && (
        <div className="flex flex-col gap-5">
          {/* El arqueo ya no cuadra con el libro: algo cambió después de cerrar. */}
          {d.descuadrado && (
            <div className="rounded-lg bg-warning-soft px-4 py-3 text-[13px] text-warning-text">
              <strong>Este cierre ya no cuadra con el libro.</strong> Al cerrar se barrieron{" "}
              {cop(d.guardado ?? 0)}, pero con los movimientos vigentes hoy el cajón daría{" "}
              {cop(d.efectivo)}. Algo cambió después de cerrarlo — lo más común: un movimiento
              anulado, o uno cargado con fecha de ese día más tarde.
            </div>
          )}

          {/* ── El arqueo, línea por línea ── */}
          <section>
            <h3 className="mb-1 text-[13px] font-semibold text-text-primary">Cómo se compone</h3>
            <div className="rounded-xl border border-border-subtle bg-surface px-4 py-2">
              <Linea label="Arrastre que entró del cierre anterior" value={d.desglose.arrastre}
                hint="ya es efectivo del cajón hoy" />
              <Linea label="Recaudo en efectivo del día" value={d.desglose.ventas} sign="+" />
              <Linea label="Egresos en efectivo" value={d.desglose.egresos} sign="−" />
              {d.desglose.transferencias !== 0 && (
                <Linea label="Traslados entre cajas" value={d.desglose.transferencias}
                  sign={d.desglose.transferencias < 0 ? "−" : "+"} />
              )}
              <Linea label={d.yaCerrado ? "Excedente barrido" : "Efectivo en el cajón"}
                value={d.yaCerrado ? (d.guardado ?? 0) : d.efectivo} strong />
              <Linea label="Recaudo que NO es efectivo" value={d.desglose.noEfectivo} muted
                hint="banco, tarjeta, cheque: no está en el cajón y no se barre" />
            </div>
            <p className="mt-1.5 text-[12px] text-text-tertiary">
              La base es cero: al cerrar se lleva el efectivo entero y se arrastra al{" "}
              <strong className="text-text-secondary">
                {new Date(d.proximoDiaHabil).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long" })}
              </strong>{" "}
              (próximo día hábil; el sábado también lo es).
              {d.cajero && <> Cerró <strong className="text-text-secondary">{d.cajero}</strong>.</>}
            </p>
          </section>

          {/* ── De dónde salió la plata ── */}
          {!!d.porCategoria.length && (
            <section>
              <h3 className="mb-1 text-[13px] font-semibold text-text-primary">De dónde salió</h3>
              <div className="flex flex-wrap gap-1.5">
                {d.porCategoria.map((c) => (
                  <span key={`${c.type}|${c.category}`}
                    className="inline-flex items-baseline gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1 text-[12px]">
                    <Icon name={c.type === "INCOME" ? "trending-up" : "trending-down"} size={12}
                      className={c.type === "INCOME" ? "text-success-text" : "text-error-text"} />
                    <span className="text-text-secondary">{c.category}</span>
                    <span className="tabular-nums font-medium text-text-primary">{cop(c.total)}</span>
                    <span className="text-text-tertiary">({c.n})</span>
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* ── Los movimientos ── */}
          <section>
            <div className="mb-1 flex items-center justify-between gap-3">
              <h3 className="text-[13px] font-semibold text-text-primary">
                Movimientos del día <span className="font-normal text-text-tertiary">({movs.length})</span>
              </h3>
              <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-text-secondary">
                <input type="checkbox" checked={soloPagos} onChange={(e) => setSoloPagos(e.target.checked)} />
                Solo pagos recibidos
              </label>
            </div>
            <div className="max-h-80 overflow-auto rounded-xl border border-border-subtle">
              <table className="w-full min-w-[36rem] text-[12.5px]">
                <thead className="sticky top-0 bg-surface-2">
                  <tr className="text-left text-text-tertiary">
                    <th className="px-3 py-1.5 font-medium">Quién</th>
                    <th className="px-3 py-1.5 font-medium">Concepto</th>
                    <th className="px-3 py-1.5 font-medium">Medio</th>
                    <th className="px-3 py-1.5 font-medium">Factura</th>
                    <th className="px-3 py-1.5 text-right font-medium">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {!movs.length && (
                    <tr><td colSpan={5} className="px-3 py-6 text-center text-text-secondary">Sin movimientos.</td></tr>
                  )}
                  {movs.map((m) => (
                    <tr key={m.id} className="border-t border-border-subtle">
                      <td className="px-3 py-1.5">
                        {m.subscriberId
                          ? <a href={`/clientes/${m.subscriberId}`} className="text-brand hover:underline">{m.payer}</a>
                          : <span className="text-text-secondary">{m.payer}</span>}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="text-text-secondary">{m.category}</span>
                        {m.transfer && <Badge tone="info" label="traslado" />}
                        {m.note && <span className="ml-1.5 text-text-tertiary">{m.note}</span>}
                      </td>
                      <td className="px-3 py-1.5 text-text-tertiary">{m.method ?? "—"}</td>
                      <td className="px-3 py-1.5">
                        {m.invoice
                          ? <a href={`/facturacion/${m.invoice.id}`} className="text-brand hover:underline">#{m.invoice.tid}</a>
                          : <span className="text-text-tertiary">—</span>}
                      </td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${m.type === "INCOME" ? "text-success-text" : "text-error-text"}`}>
                        {m.type === "INCOME" ? "+" : "−"}{cop(m.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
}
