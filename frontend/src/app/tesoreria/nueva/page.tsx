"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { type CashAccount, PAY_METHODS, BANKS, isBankMethod } from "@/lib/cobranzas";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { mensajeDeError } from "@/lib/errores";
import { useMiCaja } from "@/lib/useMiCaja";

const today = () => new Date().toISOString().slice(0, 10);

type TxType = "Income" | "Expense";

/**
 * Nueva transacción — porta el formulario `transactions/add` del legacy: UN solo
 * formulario con selector Ingreso/Egreso, no un menú de opciones.
 *
 * Es un asiento libre de tesorería: NO aplica el dinero a facturas (en el legacy
 * eso también es un flujo aparte). Para aplicar un pago a la cartera de un cliente
 * está "Registrar recaudo", en Ingresos, Inicio y la ficha del cliente.
 */
export default function NuevaTransaccionPage() {
  const router = useRouter();
  const { loading: authLoading, authFetch } = useAuth();
  // Quien está acotado (la cajera) escribe en SU caja y no puede elegir otra ni
  // dejarla en blanco: un movimiento sin caja no aparecería en su cierre.
  const { bloqueada, acotado, sinCaja } = useMiCaja();

  const [type, setType] = useState<TxType>("Income");
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [method, setMethod] = useState("Cash");
  const [bank, setBank] = useState(BANKS[0]);
  const [cashAccountId, setCashAccountId] = useState("");
  const [sub, setSub] = useState<PickedSub | null>(null);
  const [payerName, setPayerName] = useState("");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/treasury/cash-accounts").then((r) => (r.ok ? r.json() : [])).then(setAccounts).catch(() => {});
    void authFetch("/treasury/categories")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { name: string }[]) => setCategories(rows.map((c) => c.name)))
      .catch(() => {});
  }, [authLoading, authFetch]);

  // A la cajera se le fija la suya; al resto se le propone la primera de la lista.
  useEffect(() => {
    if (bloqueada) { setCashAccountId(String(bloqueada.id)); return; }
    if (accounts.length && !cashAccountId) setCashAccountId(String(accounts[0].id));
  }, [accounts, cashAccountId, bloqueada]);
  useEffect(() => { if (categories.length && !category) setCategory(categories[0]); }, [categories, category]);

  const submit = useCallback(async () => {
    setErr(null);
    const amt = Number(amount) || 0;
    if (amt <= 0) { setErr("Ingresa un monto mayor a cero."); return; }
    // Sin categoría el movimiento quedaría fuera de los reportes, que agrupan por ella.
    if (!category) { setErr("Selecciona una categoría."); return; }
    setSaving(true);
    try {
      const body: any = {
        amount: amt, category, method, date,
        cashAccountId: cashAccountId ? Number(cashAccountId) : undefined,
        accountName: accounts.find((a) => String(a.id) === cashAccountId)?.name,
        bankName: isBankMethod(method) ? bank : undefined,
        // Paridad legacy (`payer_id` + `payer_name`): si se eligió cliente manda su
        // id y su nombre; si no, vale el texto libre para terceros que no son clientes.
        subscriberId: sub?.id,
        payerName: sub?.name ?? (payerName.trim() || undefined),
        note: note.trim() || undefined,
      };
      const url = type === "Income" ? "/treasury/income" : "/treasury/expenses";
      const res = await authFetch(url, { method: "POST", body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo registrar el movimiento");

      // El comprobante se adjunta al movimiento ya creado (necesita su id).
      if (file && data?.id) {
        const fd = new FormData();
        fd.append("file", file);
        const up = await authFetch(`/treasury/transactions/${data.id}/attach`, { method: "POST", body: fd });
        if (!up.ok) toast("Movimiento guardado, pero el comprobante no se pudo subir", "alert-triangle");
      }
      toast(`${type === "Income" ? "Ingreso" : "Egreso"} registrado: ${cop(amt)}`, "check");
      router.push(type === "Income" ? "/tesoreria/ingresos" : "/tesoreria/egresos");
    } catch (e) {
      setErr(mensajeDeError(e, "No se pudo registrar el movimiento"));
    } finally {
      setSaving(false);
    }
  }, [amount, category, method, date, cashAccountId, accounts, bank, sub, payerName, note, type, file, authFetch, router]);

  const esIngreso = type === "Income";
  const montoNum = Number(amount) || 0;
  const cuentaNombre = bloqueada?.name ?? accounts.find((a) => String(a.id) === cashAccountId)?.name;
  const metodoLabel = PAY_METHODS.find((m) => m.value === method)?.label ?? method;
  const quienLabel = sub?.name ?? (payerName.trim() || null);

  return (
    <>
      <PageHeading icon="plus" title="Nueva transacción" subtitle="Registra un ingreso o un egreso de caja" />

      {sinCaja && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-warning-subtle bg-warning-soft px-3.5 py-3 text-[13px] text-warning-text">
          <Icon name="alert-triangle" size={16} className="mt-0.5 shrink-0" />
          <span>No tienes una caja asignada, así que no puedes registrar movimientos. Pídele a administración que te asigne la de tu sede.</span>
        </div>
      )}

      {/* Formulario ancho a la izquierda + resumen sticky a la derecha: aprovecha el
          espacio horizontal y deja el monto y los botones siempre a la vista. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-2xl border border-border-subtle bg-surface p-5 shadow-sm sm:p-6">
          {/* Tipo: es lo que decide todo lo demás, así que va primero y bien visible. */}
          <div className="mb-5">
            <span className="mb-1.5 block text-[11px] font-semibold text-text-tertiary">Tipo de movimiento *</span>
            <div className="inline-flex w-full max-w-sm rounded-lg border border-border-default p-0.5">
              {([
                { v: "Income", label: "Ingreso", icon: "trending-up" },
                { v: "Expense", label: "Egreso", icon: "trending-down" },
              ] as const).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setType(o.v)}
                  className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-4 py-2 text-[13px] font-semibold transition-colors ${
                    type === o.v ? "bg-brand text-on-brand" : "text-text-secondary hover:bg-surface-2"
                  }`}
                >
                  <Icon name={o.icon} size={15} />
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Monto" required>
              <Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" autoFocus />
            </Field>
            <Field label="Fecha" required>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>

            <Field label="Categoría" required hint={categories.length ? undefined : "Se administran en Cajas y categorías"}>
              <Select value={category} onChange={(e) => setCategory(e.target.value)} disabled={!categories.length}>
                {!categories.length && <option value="">Cargando…</option>}
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field
              label="Caja / cuenta"
              required={acotado}
              hint={bloqueada ? "Tu caja asignada. El movimiento entra en tu cierre." : undefined}
            >
              <Select
                value={cashAccountId}
                onChange={(e) => setCashAccountId(e.target.value)}
                disabled={!!bloqueada}
              >
                {/* "Sin caja" sólo para quien no está acotado: a la cajera le dejaría
                    el movimiento fuera de su propio arqueo. */}
                {!acotado && <option value="">— Sin caja —</option>}
                {bloqueada
                  ? <option value={bloqueada.id}>{bloqueada.name}</option>
                  : accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            </Field>

            <Field label="Método" hint={acotado ? "La caja solo maneja efectivo" : undefined}>
              {/* "Saldo a favor" solo aplica al pagar facturas, no a un asiento libre.
                  La cajera solo administra EFECTIVO: consignaciones y cheques los
                  registra contabilidad (el backend lo vuelve a imponer). */}
              <Select value={method} onChange={(e) => setMethod(e.target.value)} disabled={acotado}>
                {PAY_METHODS.filter((m) => m.value !== "Balance")
                  .filter((m) => !acotado || m.value === "Cash")
                  .map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </Select>
            </Field>
            {isBankMethod(method) ? (
              <Field label="Banco">
                <Select value={bank} onChange={(e) => setBank(e.target.value)}>
                  {BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
                </Select>
              </Field>
            ) : <div className="hidden sm:block" />}

            <div className="sm:col-span-2">
              <Field
                label="Cliente"
                hint={esIngreso
                  ? "Opcional. Liga el ingreso a un cliente y le abona saldo a favor."
                  : "Opcional. Deja constancia de a quién se le pagó; no le mueve la cartera."}
              >
                <SubscriberPicker value={sub} onChange={setSub} />
              </Field>
            </div>
            {!sub && (
              <div className="sm:col-span-2">
                <Field label={esIngreso ? "Pagador" : "Beneficiario"} hint="Para quien no es cliente.">
                  <Input
                    value={payerName}
                    onChange={(e) => setPayerName(e.target.value)}
                    placeholder={esIngreso ? "Quién paga" : "A quién se le paga"}
                  />
                </Field>
              </div>
            )}

            <div className="sm:col-span-2">
              <Field label="Nota">
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </div>

            <div className="sm:col-span-2">
              <Field label="Comprobante (opcional)" hint="Foto o PDF de la factura, recibo o soporte.">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:border-brand hover:text-text-primary">
                  <Icon name="upload" size={14} /> {file ? "Cambiar archivo" : "Adjuntar comprobante"}
                  <input type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                </label>
                {file && (
                  <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-text-tertiary">
                    <Icon name="file-text" size={12} /> {file.name}
                    <button type="button" onClick={() => setFile(null)} className="text-error-text hover:underline"><Icon name="x" size={12} /></button>
                  </span>
                )}
              </Field>
            </div>
          </div>
        </div>

        {/* Resumen sticky: espejo en vivo de lo que se va a registrar + acciones. */}
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <div className="overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-sm">
            <div className={`px-5 py-4 ${esIngreso ? "bg-success-soft" : "bg-error-soft"}`}>
              <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${esIngreso ? "text-success-text" : "text-error-text"}`}>
                <Icon name={esIngreso ? "trending-up" : "trending-down"} size={13} />
                {esIngreso ? "Ingreso" : "Egreso"}
              </span>
              <div className={`mt-1 text-3xl font-bold tabular-nums ${esIngreso ? "text-success-text" : "text-error-text"}`}>
                {esIngreso ? "+" : "−"} {cop(montoNum)}
              </div>
            </div>

            <dl className="divide-y divide-border-subtle px-5 text-[13px]">
              {[
                { k: "Categoría", v: category || "—" },
                { k: "Caja / cuenta", v: cuentaNombre || "Sin caja" },
                { k: "Método", v: isBankMethod(method) ? `${metodoLabel} · ${bank}` : metodoLabel },
                { k: esIngreso ? "Pagador" : "Beneficiario", v: quienLabel || "—" },
                { k: "Fecha", v: date },
              ].map((r) => (
                <div key={r.k} className="flex items-center justify-between gap-3 py-2.5">
                  <dt className="text-text-tertiary">{r.k}</dt>
                  <dd className="truncate text-right font-medium text-text-primary">{r.v}</dd>
                </div>
              ))}
            </dl>

            <div className="border-t border-border-subtle p-4">
              {err && <p className="mb-3 text-[12px] text-error-text">{err}</p>}
              <div className="flex flex-col gap-2">
                <Button variant="primary" onClick={submit} disabled={saving} className="w-full justify-center">
                  <Icon name="check" size={15} />
                  {saving ? "Guardando…" : `Registrar ${esIngreso ? "ingreso" : "egreso"}`}
                </Button>
                <Button variant="secondary" onClick={() => router.push("/tesoreria")} disabled={saving} className="w-full justify-center">
                  <Icon name="x" size={15} /> Cancelar
                </Button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
