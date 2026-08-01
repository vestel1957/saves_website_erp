"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import {
  type Debt, type DebtInvoice, type CashAccount, PAY_METHODS, BANKS, isBankMethod, previewCascade,
} from "@/lib/cobranzas";
import { mensajeDeError } from "@/lib/errores";
import { useMiCaja } from "@/lib/useMiCaja";

/** Lo que responde el backend sobre la reconexión automática tras el pago. */
type Reconexion = {
  aplica: boolean;
  ok: boolean;
  enCurso: boolean;
  dryRun: boolean;
  servicios: { servicio: "INTERNET" | "TV"; ok: boolean; via: string | null; detalle: string }[];
  mensaje: string;
};

const NOMBRE_SERVICIO: Record<string, string> = { INTERNET: "internet", TV: "televisión" };

/** "internet y televisión" / "televisión" — para contarle a la cajera qué volvió. */
const listar = (nombres: string[]) =>
  nombres.length > 1 ? `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}` : (nombres[0] ?? "");

export function RegistrarPagoModal({
  subscriberId, open, onClose, onDone,
}: {
  subscriberId: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { authFetch, isSuperadmin } = useAuth();
  // La cajera recauda SIEMPRE contra su caja (el backend además lo impone con 403).
  // El selector de caja sólo lo ve el superusuario: al resto se le muestra la suya y
  // el servidor la resuelve solo, para que nadie mande un recaudo a otro cajón.
  const { mi } = useMiCaja();
  const [debt, setDebt] = useState<Debt | null>(null);
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [amount, setAmount] = useState<string>("");
  const [method, setMethod] = useState("Cash");
  const [bank, setBank] = useState(BANKS[0]);
  const [cashAccountId, setCashAccountId] = useState<string>("");
  /** Facturas marcadas para pagar (ids). El pago se aplica SOLO sobre estas. */
  const [elegidas, setElegidas] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Pago aplicado pero el servicio NO volvió: se muestra en vez del formulario. */
  const [fallo, setFallo] = useState<Reconexion | null>(null);

  useEffect(() => {
    if (!open) return;
    setDebt(null); setErr(null); setFallo(null); setAmount(""); setNote(""); setMethod("Cash");
    setElegidas([]);
    void authFetch(`/treasury/subscribers/${subscriberId}/debt`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("No se pudo cargar la deuda"))))
      .then((d: Debt) => {
        setDebt(d);
        // Se abre con TODAS marcadas: es el caso normal (el cliente se pone al día) y
        // deja el monto ya cuadrado con la deuda. Desmarcar es un clic.
        setElegidas(d.invoices.map((i) => i.id));
        setAmount(d.totalDebt > 0 ? String(d.totalDebt) : "");
      })
      .catch((e) => setErr(mensajeDeError(e)));
    // El listado de cajas sólo hace falta para el selector del superusuario.
    if (!isSuperadmin) return;
    void authFetch(`/treasury/cash-accounts`)
      .then((r) => (r.ok ? r.json() : []))
      .then((a: CashAccount[]) => {
        setAccounts(a);
        setCashAccountId((prev) => prev || (a.length ? String(a[0].id) : ""));
      })
      .catch(() => {});
  }, [open, subscriberId, authFetch, isSuperadmin]);

  // Su caja manda sobre "la primera de la lista": ordenada alfabéticamente, la
  // primera puede ser un banco, y el recaudo se le iría fuera del cajón. Va en su
  // propio efecto porque `mi` llega por otra petición: metido en el de arriba,
  // volvería a cargar la deuda al llegar y borraría lo que ya se hubiera marcado.
  useEffect(() => {
    if (!open || !isSuperadmin || !mi?.caja) return;
    setCashAccountId(String(mi.caja.id));
  }, [open, isSuperadmin, mi]);

  const amountNum = Number(amount) || 0;
  /** Las facturas marcadas, en el orden en que se listan (más antigua primero). */
  const seleccionadas = useMemo<DebtInvoice[]>(
    () => (debt ? debt.invoices.filter((i) => elegidas.includes(i.id)) : []),
    [debt, elegidas],
  );
  const deudaElegida = useMemo(
    () => Math.round(seleccionadas.reduce((s, i) => s + i.balance, 0) * 100) / 100,
    [seleccionadas],
  );
  const preview = useMemo(
    () => previewCascade(seleccionadas, amountNum),
    [seleccionadas, amountNum],
  );
  const totalPreview = preview.reduce((s, p) => s + p.applied, 0);
  const excedente = Math.max(0, Math.round((amountNum - deudaElegida) * 100) / 100);

  /**
   * Marcar/desmarcar una factura. El monto se re-cuadra con lo elegido: quien marca
   * facturas espera ver el total de ESAS facturas, no el que quedó de la selección
   * anterior. Si necesita abonar menos, reescribe el monto después.
   */
  function alternar(id: string) {
    const next = elegidas.includes(id) ? elegidas.filter((x) => x !== id) : [...elegidas, id];
    setElegidas(next);
    const total = (debt?.invoices ?? [])
      .filter((i) => next.includes(i.id))
      .reduce((s, i) => s + i.balance, 0);
    setAmount(total > 0 ? String(Math.round(total * 100) / 100) : "");
  }

  async function submit() {
    setErr(null);
    if (!seleccionadas.length) { setErr("Marca al menos una factura a pagar."); return; }
    if (amountNum <= 0) { setErr("Ingresa un monto mayor a cero."); return; }
    if (method === "Balance" && amountNum > (debt?.balance ?? 0)) {
      setErr("El saldo a favor del cliente no alcanza para ese monto."); return;
    }
    setSaving(true);
    try {
      const res = await authFetch(`/treasury/collect`, {
        method: "POST",
        body: JSON.stringify({
          subscriberId, amount: amountNum, method,
          // Sólo el superusuario elige caja; para el resto la pone el servidor (la
          // suya). La fecha tampoco se manda: el pago se registra con el día en que
          // se registra, no con uno escrito a mano.
          cashAccountId: isSuperadmin && cashAccountId ? Number(cashAccountId) : undefined,
          accountName: isSuperadmin ? accounts.find((a) => String(a.id) === cashAccountId)?.name : undefined,
          bankName: isBankMethod(method) ? bank : undefined,
          invoiceIds: elegidas.length ? seleccionadas.map((i) => i.id) : undefined,
          note: note || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo registrar el pago");
      toast(`Recaudo registrado: ${cop(data.totalApplied)} (${data.applied.length} factura(s))`);
      // Abrir el recibo de caja en una pestaña nueva.
      if (data.receiptId) {
        try {
          const pdf = await authFetch(`/treasury/receipts/${data.receiptId}/pdf`);
          if (pdf.ok) {
            const url = URL.createObjectURL(await pdf.blob());
            window.open(url, "_blank");
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }
        } catch { /* el recibo es opcional; no bloquea el flujo */ }
      }
      onDone();

      // Reconexión automática: al pagar se le devuelve internet y/o TV según lo que
      // tenga cortado. Si algo falló, el modal NO se cierra: quien recibió la plata
      // tiene que enterarse en el acto de que el cliente sigue sin servicio — un
      // toast se va solo y ese aviso no puede perderse.
      const rec: Reconexion | null = data.reconexion ?? null;
      if (rec?.aplica && !rec.ok) { setFallo(rec); return; }
      if (rec?.aplica) {
        const nombres = rec.servicios.map((s) => NOMBRE_SERVICIO[s.servicio] ?? s.servicio.toLowerCase());
        if (rec.enCurso) toast("Pago aplicado · reconectando el servicio, puede tardar un momento", "loader");
        else if (rec.dryRun) toast(`Pago aplicado · reconexión de ${listar(nombres)} SIMULADA (modo pruebas)`, "flask-conical");
        else toast(`Servicio reconectado: ${listar(nombres)}`, "wifi");
      }
      onClose();
    } catch (e) {
      setErr(mensajeDeError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Registrar pago" maxWidth="max-w-2xl">
      {/* El pago quedó, el servicio no. Se muestra en lugar del formulario para que
          nadie cierre la ventana creyendo que el cliente ya está navegando. */}
      {fallo ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3 rounded-lg border border-error-border bg-error-soft p-3">
            <Icon name="alert-triangle" size={18} className="mt-0.5 shrink-0 text-error-text" />
            <div className="min-w-0">
              <p className="text-[13px] font-bold text-error-text">El pago quedó registrado, pero el servicio NO se reconectó</p>
              <p className="mt-0.5 text-[12px] text-text-secondary">
                El cliente sigue cortado. Reintenta desde Red (Mikrotik / GenieACS) o avisa a soporte.
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-border-subtle">
            {fallo.servicios.map((s) => (
              <div key={s.servicio} className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-3 py-2 text-[12px] last:border-0">
                <span className="flex items-center gap-1.5 font-semibold text-text-primary">
                  <Icon name={s.servicio === "TV" ? "tv" : "wifi"} size={14} />
                  {NOMBRE_SERVICIO[s.servicio] ?? s.servicio}
                  {s.via && <span className="font-normal text-text-tertiary">· {s.via}</span>}
                </span>
                <Badge label={s.ok ? "reconectado" : "falló"} tone={s.ok ? "success" : "error"} />
                <span className="w-full text-text-tertiary">{s.detalle}</span>
              </div>
            ))}
          </div>

          <div className="flex justify-end pt-1">
            <Button onClick={onClose}>Entendido</Button>
          </div>
        </div>
      ) : (
      <>
      {!debt && !err && <div className="py-6 text-center text-[13px] text-text-tertiary">Cargando deuda…</div>}
      {debt && (
        <div className="flex flex-col gap-3">
          {/* Resumen deuda */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
            <span className="text-[13px] font-semibold text-text-primary">{debt.name}</span>
            <div className="flex gap-4 text-right">
              <div><div className="text-[10px] text-text-tertiary">Deuda total</div><div className="text-[14px] font-bold text-error-text">{cop(debt.totalDebt)}</div></div>
              <div><div className="text-[10px] text-text-tertiary">Saldo a favor</div><div className="text-[14px] font-bold text-text-primary">{cop(debt.balance)}</div></div>
            </div>
          </div>

          {debt.invoices.length === 0 ? (
            <div className="rounded-lg border border-border-subtle bg-surface p-4 text-center text-[13px] text-text-tertiary">
              El cliente no tiene facturas pendientes.
            </div>
          ) : (
            <>
              {/* Facturas a pagar: se marcan las que se van a cubrir. El monto se
                  reparte SOLO entre las marcadas (el backend recibe sus ids). */}
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-text-tertiary">
                    <Icon name="list" size={13} /> Facturas a pagar
                  </span>
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-text-secondary">
                    <input
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer accent-brand"
                      checked={elegidas.length === debt.invoices.length}
                      onChange={(e) => {
                        const todas = e.target.checked;
                        setElegidas(todas ? debt.invoices.map((i) => i.id) : []);
                        setAmount(todas && debt.totalDebt > 0 ? String(debt.totalDebt) : "");
                      }}
                    />
                    Todas
                  </label>
                </div>
                <div className="max-h-48 overflow-y-auto rounded-lg border border-border-subtle">
                  {debt.invoices.map((inv) => {
                    const marcada = elegidas.includes(inv.id);
                    const p = marcada ? preview.find((x) => x.tid === inv.tid) : undefined;
                    return (
                      <label
                        key={inv.id}
                        className={`flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-subtle px-3 py-2 text-[12px] last:border-0 ${marcada ? "bg-surface-2" : ""}`}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0 cursor-pointer accent-brand"
                          checked={marcada}
                          onChange={() => alternar(inv.id)}
                        />
                        <span className="font-mono text-text-secondary">#{inv.tid}</span>
                        <span className="text-text-tertiary">saldo {cop(inv.balance)}</span>
                        <span className="ml-auto">
                          {p ? (
                            <Badge label={`+${cop(p.applied)}${p.willBePaid ? " · saldada" : " · parcial"}`} tone={p.willBePaid ? "success" : "warning"} />
                          ) : (
                            <span className="text-[11px] text-text-tertiary">—</span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {excedente > 0 && (
                  <p className="mt-1 text-[11px] text-warning-text">
                    Excedente de {cop(excedente)} se cargará como saldo adelantado en la última factura marcada.
                  </p>
                )}
                <p className="mt-1 text-[11px] text-text-tertiary">
                  Marcadas {seleccionadas.length} de {debt.invoices.length} · total a aplicar{" "}
                  <span className="font-semibold text-text-primary">{cop(totalPreview)}</span>
                </p>
              </div>

              {/* Formulario */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Monto a recaudar" required hint={`Deuda marcada: ${cop(deudaElegida)}`}>
                  <Input type="number" min={0} inputMode="numeric" value={amount}
                    onChange={(e) => setAmount(e.target.value)} placeholder="0" autoFocus />
                </Field>
                <Field label="Método de pago" required>
                  <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                    {PAY_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </Select>
                </Field>
                {isBankMethod(method) && (
                  <Field label="Banco">
                    <Select value={bank} onChange={(e) => setBank(e.target.value)}>
                      {BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
                    </Select>
                  </Field>
                )}
                {/* La caja NO se elige: el recaudo entra en la de quien lo registra y
                    el servidor la resuelve. Sólo el superusuario puede mandarlo a
                    otra —él sí administra todas las cajas—. */}
                {isSuperadmin && (
                  <Field label="Caja / cuenta" hint="Sólo tú ves este selector.">
                    <Select value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)}>
                      <option value="">— Sin caja —</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </Select>
                  </Field>
                )}
                <Field label="Nota (opcional)">
                  <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Referencia…" />
                </Field>
              </div>

              {!isSuperadmin && (
                <p className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
                  <Icon name="wallet" size={13} />
                  {mi?.caja
                    ? <>El recaudo entra en tu caja <span className="font-semibold text-text-secondary">{mi.caja.name}</span> con la fecha de hoy.</>
                    : <>El recaudo entra en la caja que tengas asignada, con la fecha de hoy.</>}
                </p>
              )}
            </>
          )}

          {err && <p className="text-[12px] text-error-text">{err}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
            <Button onClick={submit} disabled={saving || seleccionadas.length === 0 || amountNum <= 0}>
              {saving ? "Registrando…" : "Registrar pago"}
            </Button>
          </div>
        </div>
      )}
      {err && !debt && <p className="py-4 text-center text-[12px] text-error-text">{err}</p>}
      </>
      )}
    </Modal>
  );
}
