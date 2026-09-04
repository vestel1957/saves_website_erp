"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { type CashAccount, PAY_METHODS, BANKS, isBankMethod } from "@/lib/cobranzas";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { BeneficiarioPicker, type Beneficiario } from "@/components/cobranzas/BeneficiarioPicker";
import { mensajeDeError } from "@/lib/errores";
import { useMiCaja } from "@/lib/useMiCaja";
import { ACCEPT_IMAGEN_PDF } from "@/lib/adjuntos";

const today = () => new Date().toISOString().slice(0, 10);

function useCashAccounts(open: boolean) {
  const { authFetch } = useAuth();
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  useEffect(() => {
    if (!open) return;
    void authFetch(`/treasury/cash-accounts`).then((r) => (r.ok ? r.json() : [])).then(setAccounts).catch(() => {});
  }, [open, authFetch]);
  return accounts;
}

/**
 * Categorías de movimiento, desde el catálogo real (`transactions_cat` del legacy,
 * ya migrado a TransactionCategory y administrable en /tesoreria/cajas).
 *
 * Ingresos y egresos comparten la MISMA lista: el legacy no separa por tipo
 * (`transactions_cat` no tiene columna `type`) y en la práctica se usan en ambos
 * sentidos —p.ej. "Compras" aparece como Income 38 veces y como Expense 2.641—.
 * Antes esto era una lista fija en código que no coincidía con el legacy, así que
 * los movimientos nuevos no cuadraban con el histórico ni con los reportes.
 */
function useTxCategories(open: boolean) {
  const { authFetch } = useAuth();
  const [categories, setCategories] = useState<string[]>([]);
  useEffect(() => {
    if (!open) return;
    void authFetch(`/treasury/categories`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { name: string }[]) => setCategories(rows.map((c) => c.name)))
      .catch(() => {});
  }, [open, authFetch]);
  return categories;
}

/**
 * Selector de caja compartido por los modales que mueven plata.
 *
 * Quien está acotado (la cajera) ve UNA opción —la suya— y no puede dejarlo en
 * blanco: un movimiento sin caja no entra en su cierre y luego no lo ve ni ella.
 * El resto sigue pudiendo elegir, incluido "sin caja". El backend impone lo mismo
 * con un 403 (`treasury/caja-scope.ts`); esto evita el viaje en balde.
 */
function CajaField({ accounts, value, onChange }: {
  accounts: CashAccount[];
  value: string;
  onChange: (v: string) => void;
}) {
  const { bloqueada, acotado } = useMiCaja();
  // El valor por defecto lo pone este componente (y no cada modal): si lo pusieran
  // los dos, el del modal pisaría la caja fija con la primera de la lista.
  useEffect(() => {
    if (bloqueada) { onChange(String(bloqueada.id)); return; }
    if (!value && accounts.length) onChange(String(accounts[0].id));
  }, [bloqueada, accounts, value, onChange]);
  return (
    <Field label="Caja / cuenta" required={acotado} hint={bloqueada ? "Tu caja asignada" : undefined}>
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={!!bloqueada}>
        {!acotado && <option value="">— Sin caja —</option>}
        {bloqueada
          ? <option value={bloqueada.id}>{bloqueada.name}</option>
          : accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </Select>
    </Field>
  );
}

/**
 * Selector de método de pago compartido. La cajera solo administra EFECTIVO:
 * consignaciones y cheques los registra contabilidad. Se fija aquí (y el backend
 * lo vuelve a imponer en `cobranzas.service`) para que el modal no ofrezca algo
 * que el servidor va a rechazar.
 */
function MetodoField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { acotado } = useMiCaja();
  useEffect(() => { if (acotado && value !== "Cash") onChange("Cash"); }, [acotado, value, onChange]);
  return (
    <Field label="Método" hint={acotado ? "La caja solo maneja efectivo" : undefined}>
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={acotado}>
        {PAY_METHODS
          .filter((m) => m.value !== "Balance")
          .filter((m) => !acotado || m.value === "Cash")
          .map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </Select>
    </Field>
  );
}

/** Selector de categoría compartido por los modales de ingreso y egreso. */
function CategoriaField({ categories, value, onChange }: { categories: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Categoría" required hint={categories.length ? undefined : "Se administran en Cajas y categorías"}>
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={!categories.length}>
        {!categories.length && <option value="">Cargando…</option>}
        {categories.map((c) => <option key={c} value={c}>{c}</option>)}
      </Select>
    </Field>
  );
}

/** Registrar un egreso/gasto de caja. */
export function EgresoModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { authFetch, can } = useAuth();
  const accounts = useCashAccounts(open);
  const categories = useTxCategories(open);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [method, setMethod] = useState("Cash");
  const [bank, setBank] = useState(BANKS[0]);
  const [cashAccountId, setCashAccountId] = useState("");
  const [beneficiario, setBeneficiario] = useState<Beneficiario | null>(null);
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (open) { setAmount(""); setNote(""); setBeneficiario(null); setFile(null); setErr(null); } }, [open]);
  // El default de la caja lo pone <CajaField/> (respeta la caja fija de la cajera).
  useEffect(() => { if (categories.length && !category) setCategory(categories[0]); }, [categories, category]);

  async function submit() {
    setErr(null);
    const amt = Number(amount) || 0;
    if (amt <= 0) { setErr("Ingresa un monto mayor a cero."); return; }
    // Sin categoría el movimiento se guardaría con cadena vacía y quedaría fuera
    // de los reportes, que agrupan por categoría.
    if (!category) { setErr("Selecciona una categoría."); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/treasury/expenses`, {
        method: "POST",
        body: JSON.stringify({
          amount: amt, category, method,
          cashAccountId: cashAccountId ? Number(cashAccountId) : undefined,
          accountName: accounts.find((a) => String(a.id) === cashAccountId)?.name,
          bankName: isBankMethod(method) ? bank : undefined,
          // Del directorio va el id (el nombre lo pone el servidor); el texto libre
          // sigue viajando como payerName para el pago suelto.
          supplierId: beneficiario?.id ?? undefined,
          payerName: beneficiario && !beneficiario.id ? beneficiario.name : undefined,
          date, note: note || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo registrar el egreso");
      // Adjuntar el comprobante al movimiento recién creado (si se seleccionó uno).
      if (file && data?.id) {
        const fd = new FormData();
        fd.append("file", file);
        const up = await authFetch(`/treasury/transactions/${data.id}/attach`, { method: "POST", body: fd });
        if (!up.ok) toast("Egreso guardado, pero el comprobante no se pudo subir", "alert-triangle");
      }
      toast(`Egreso registrado: ${cop(amt)}`);
      onDone(); onClose();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Registrar egreso" maxWidth="max-w-xl">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Monto" required><Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" autoFocus /></Field>
        <CategoriaField categories={categories} value={category} onChange={setCategory} />
        <MetodoField value={method} onChange={setMethod} />
        {isBankMethod(method) && <Field label="Banco"><Select value={bank} onChange={(e) => setBank(e.target.value)}>{BANKS.map((b) => <option key={b} value={b}>{b}</option>)}</Select></Field>}
        <CajaField accounts={accounts} value={cashAccountId} onChange={setCashAccountId} />
        <Field label="Fecha"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <div className="sm:col-span-2">
          <Field label="Proveedor" hint="Se elige del directorio (proveedores y terceros) o se escribe a mano.">
            <BeneficiarioPicker value={beneficiario} onChange={setBeneficiario} />
          </Field>
        </div>
        <div className="sm:col-span-2"><Field label="Nota"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
        <div className="sm:col-span-2">
          <Field label="Comprobante (opcional)" hint="Foto o PDF de la factura, recibo o soporte de transferencia.">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:border-brand hover:text-text-primary">
              <Icon name="upload" size={14} /> {file ? "Cambiar archivo" : "Adjuntar comprobante"}
              <input type="file" accept={ACCEPT_IMAGEN_PDF} className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            {file && <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-text-tertiary"><Icon name="file-text" size={12} /> {file.name}<button type="button" onClick={() => setFile(null)} className="text-error-text hover:underline"><Icon name="x" size={12} /></button></span>}
          </Field>
        </div>
      </div>
      {err && <p className="mt-2 text-[12px] text-error-text">{err}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button onClick={submit} disabled={saving}>{saving ? "Guardando…" : "Registrar egreso"}</Button>
      </div>
    </Modal>
  );
}

/** Registrar un ingreso manual libre (no ligado a factura). */
export function IngresoLibreModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { authFetch } = useAuth();
  const accounts = useCashAccounts(open);
  const categories = useTxCategories(open);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [method, setMethod] = useState("Cash");
  const [bank, setBank] = useState(BANKS[0]);
  const [cashAccountId, setCashAccountId] = useState("");
  const [payerName, setPayerName] = useState("");
  const [payerSub, setPayerSub] = useState<PickedSub | null>(null);
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (open) { setAmount(""); setNote(""); setPayerName(""); setPayerSub(null); setFile(null); setErr(null); } }, [open]);
  // El default de la caja lo pone <CajaField/> (respeta la caja fija de la cajera).
  useEffect(() => { if (categories.length && !category) setCategory(categories[0]); }, [categories, category]);

  async function submit() {
    setErr(null);
    const amt = Number(amount) || 0;
    if (amt <= 0) { setErr("Ingresa un monto mayor a cero."); return; }
    // Sin categoría el movimiento se guardaría con cadena vacía y quedaría fuera
    // de los reportes, que agrupan por categoría.
    if (!category) { setErr("Selecciona una categoría."); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/treasury/income`, {
        method: "POST",
        body: JSON.stringify({
          amount: amt, category, method,
          cashAccountId: cashAccountId ? Number(cashAccountId) : undefined,
          accountName: accounts.find((a) => String(a.id) === cashAccountId)?.name,
          bankName: isBankMethod(method) ? bank : undefined,
          // Si se eligió un cliente, manda su id y su nombre (paridad legacy:
          // `payer_id` + `payer_name`). El texto libre sigue valiendo para
          // pagadores que no son clientes.
          subscriberId: payerSub?.id,
          payerName: payerSub?.name ?? payerName ?? undefined,
          date, note: note || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo registrar el ingreso");
      if (file && data?.id) {
        const fd = new FormData();
        fd.append("file", file);
        const up = await authFetch(`/treasury/transactions/${data.id}/attach`, { method: "POST", body: fd });
        if (!up.ok) toast("Ingreso guardado, pero el comprobante no se pudo subir", "alert-triangle");
      }
      toast(`Ingreso registrado: ${cop(amt)}`);
      onDone(); onClose();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Registrar ingreso libre" maxWidth="max-w-xl">
      <p className="mb-2 text-[12px] text-text-secondary">Ingreso que no se aplica a facturas (otros conceptos, ingresos sin cliente).</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Monto" required><Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" autoFocus /></Field>
        <CategoriaField categories={categories} value={category} onChange={setCategory} />
        <MetodoField value={method} onChange={setMethod} />
        {isBankMethod(method) && <Field label="Banco"><Select value={bank} onChange={(e) => setBank(e.target.value)}>{BANKS.map((b) => <option key={b} value={b}>{b}</option>)}</Select></Field>}
        <CajaField accounts={accounts} value={cashAccountId} onChange={setCashAccountId} />
        <Field label="Fecha"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        {/* Paridad legacy ("Search Payer"): el ingreso puede quedar ligado a un
            cliente. No toca sus facturas; solo deja constancia de quién pagó. */}
        <div className="sm:col-span-2">
          <Field label="Cliente" hint="Opcional. Liga el ingreso a un cliente sin afectar sus facturas.">
            <SubscriberPicker value={payerSub} onChange={setPayerSub} />
          </Field>
        </div>
        {!payerSub && (
          <div className="sm:col-span-2">
            <Field label="Pagador" hint="Para quien no es cliente.">
              <Input value={payerName} onChange={(e) => setPayerName(e.target.value)} placeholder="Quién paga (opcional)" />
            </Field>
          </div>
        )}
        <div className="sm:col-span-2"><Field label="Nota"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
        <div className="sm:col-span-2">
          <Field label="Comprobante (opcional)" hint="Foto o PDF del soporte.">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:border-brand hover:text-text-primary">
              <Icon name="upload" size={14} /> {file ? "Cambiar archivo" : "Adjuntar comprobante"}
              <input type="file" accept={ACCEPT_IMAGEN_PDF} className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            {file && <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-text-tertiary"><Icon name="file-text" size={12} /> {file.name}<button type="button" onClick={() => setFile(null)} className="text-error-text hover:underline"><Icon name="x" size={12} /></button></span>}
          </Field>
        </div>
      </div>
      {err && <p className="mt-2 text-[12px] text-error-text">{err}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button onClick={submit} disabled={saving}>{saving ? "Guardando…" : "Registrar ingreso"}</Button>
      </div>
    </Modal>
  );
}

/** Editar un movimiento (campos seguros; el monto solo en no-ventas). */
export function EditarMovimientoModal({
  tx, onClose, onDone,
}: {
  tx: { id: string; type: string; category: string; amount: number; note: string | null; method: string | null; date: string; invoiceTid: number | null } | null;
  onClose: () => void; onDone: () => void;
}) {
  const { authFetch } = useAuth();
  const isSalePayment = !!tx && !!tx.invoiceTid && tx.category === "Sales" && tx.type === "INCOME";
  const cats = useTxCategories(!!tx);
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("Cash");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (tx) {
      setCategory(tx.category); setAmount(String(tx.amount));
      setMethod(tx.method || "Cash"); setDate((tx.date || "").slice(0, 10)); setNote(tx.note || ""); setErr(null);
    }
  }, [tx]);

  async function submit() {
    setErr(null);
    setSaving(true);
    try {
      const body: any = { category, method, date, note };
      if (!isSalePayment) body.amount = Number(amount) || 0;
      const res = await authFetch(`/treasury/transactions/${tx!.id}`, { method: "PATCH", body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo editar");
      toast("Movimiento actualizado");
      onDone(); onClose();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={!!tx} onClose={onClose} title="Editar movimiento" maxWidth="max-w-lg">
      {tx && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Categoría"><Select value={category} onChange={(e) => setCategory(e.target.value)}>{!cats.includes(category) && <option value={category}>{category}</option>}{cats.map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
          <Field label="Monto" hint={isSalePayment ? "Los pagos de venta se anulan y rehacen" : undefined}>
            <Input type="number" min={0} value={amount} disabled={isSalePayment} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Método"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{PAY_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select></Field>
          <Field label="Fecha"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <div className="sm:col-span-2"><Field label="Nota"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
          {err && <p className="sm:col-span-2 text-[12px] text-error-text">{err}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
            <Button onClick={submit} disabled={saving}>{saving ? "Guardando…" : "Guardar cambios"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * Cierre de caja — réplica del legacy.
 *
 * No pide base ni consignado: en el legacy la base es cero y al cerrar se barre el
 * efectivo ENTERO del cajón, que se arrastra al próximo día hábil como una transacción
 * 'Saldo <fecha>'. El cajero sólo elige caja y fecha, y confirma contra lo que cuenta.
 */
export function CierreCajaModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { authFetch } = useAuth();
  // La lista ya viene acotada por el backend (la cajera sólo ve la suya). Aquí se quitan
  // además los bancos (`branchLegacy = 0`): un banco no se cierra, se consolida DENTRO
  // del cierre de la caja.
  const todas = useCashAccounts(open);
  const accounts = todas.filter((a: any) => a.branchLegacy !== 0);
  const [cashAccountId, setCashAccountId] = useState("");
  const [date, setDate] = useState(today());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  /** Arqueo del día ANTES de cerrar: se carga al elegir caja y fecha. */
  const [preview, setPreview] = useState<any>(null);
  const [loadingPrev, setLoadingPrev] = useState(false);
  const [verMovs, setVerMovs] = useState(false);

  useEffect(() => { if (open) { setErr(null); setResult(null); setVerMovs(false); } }, [open]);
  useEffect(() => { if (accounts.length && !cashAccountId) setCashAccountId(String(accounts[0].id)); }, [accounts, cashAccountId]);

  // Previsualizar sin escribir nada: un arqueo es contar el cajón y compararlo con lo
  // que dice el sistema. Antes el arqueo solo aparecía DESPUÉS de guardar el cierre.
  useEffect(() => {
    if (!open || !cashAccountId || !date || result) { return; }
    let vivo = true;
    setLoadingPrev(true);
    void authFetch(`/treasury/cash-close/preview?cashAccountId=${cashAccountId}&date=${date}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (vivo) setPreview(d); })
      .catch(() => { if (vivo) setPreview(null); })
      .finally(() => { if (vivo) setLoadingPrev(false); });
    return () => { vivo = false; };
  }, [open, cashAccountId, date, result, authFetch]);

  const fechaLarga = (d?: string) =>
    d ? new Date(d).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long" }) : "—";

  async function submit() {
    setErr(null);
    if (!cashAccountId) { setErr("Selecciona una caja."); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/treasury/cash-close`, {
        method: "POST",
        body: JSON.stringify({ cashAccountId: Number(cashAccountId), date }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo cerrar la caja");
      setResult(data);
      if (data.escrito) toast(`Caja cerrada · se barrieron ${cop(data.excedente)}`);
      else if (data.motivo === "ya-cerrado") toast("Esta caja ya estaba cerrada ese día");
      else toast("Sin excedente: no había efectivo que arrastrar");
      onDone();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Cierre de caja" maxWidth="max-w-lg">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Caja" required><Select value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)}><option value="">— Selecciona —</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label="Fecha" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      {err && <p className="mt-2 text-[12px] text-error-text">{err}</p>}

      {/* El arqueo ANTES de cerrar: el cajero compara contra el cajón y recién cierra. */}
      {!result && preview?.yaCerrado && (
        <p className="mt-2 rounded-lg bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
          Esta caja ya se cerró en esta fecha (se barrieron {cop(preview.guardado ?? 0)}). No se
          vuelve a arrastrar: cerrar dos veces duplicaría el saldo.
        </p>
      )}
      {!result && loadingPrev && <p className="mt-3 text-[12px] text-text-tertiary">Calculando el arqueo…</p>}

      {(result || (preview && !loadingPrev)) && (() => {
        const g = preview?.desglose ?? { arrastre: 0, ventas: 0, egresos: 0, transferencias: 0, noEfectivo: 0 };
        const exced = result ? result.excedente : (preview?.excedente ?? 0);
        const habil = result?.proximoDiaHabil ?? preview?.proximoDiaHabil;
        const movs = preview?.movimientos ?? [];
        return (
          <div className="mt-3 rounded-lg border border-border-subtle bg-surface-2 p-3 text-[12px]">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-bold text-text-primary">{result ? "Caja cerrada" : "Arqueo del día"}</span>
              {!result && <span className="text-[11px] text-text-tertiary">aún no se ha guardado</span>}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <span className="text-text-tertiary">Arrastre que entró</span><span className="text-right font-medium">{cop(g.arrastre)}</span>
              <span className="text-text-tertiary">Recaudo en efectivo</span><span className="text-right font-medium text-success-text">+ {cop(g.ventas)}</span>
              <span className="text-text-tertiary">Egresos en efectivo</span><span className="text-right font-medium text-error-text">− {cop(g.egresos)}</span>
              {g.transferencias !== 0 && (
                <>
                  <span className="text-text-tertiary">Traslados entre cajas</span>
                  <span className={`text-right font-medium ${g.transferencias < 0 ? "text-error-text" : "text-success-text"}`}>
                    {g.transferencias < 0 ? "−" : "+"} {cop(Math.abs(g.transferencias))}
                  </span>
                </>
              )}
              <span className="col-span-2 my-0.5 border-t border-border-subtle" />
              <span className="font-semibold text-text-primary">Efectivo en el cajón</span><span className="text-right font-bold text-text-primary">{cop(exced)}</span>
            </div>
            <p className="mt-2 text-[11px] text-text-tertiary">
              Se barre <strong className="text-text-secondary">todo</strong> el efectivo (la base es cero) y
              se arrastra al <strong className="text-text-secondary">{fechaLarga(habil)}</strong>, el próximo
              día hábil.
              {g.noEfectivo > 0 && <> El recaudo por banco/tarjeta ({cop(g.noEfectivo)}) no está en el cajón y no se barre.</>}
            </p>

            {/* Los movimientos de ESTA caja, ese día: es contra esto que se cuadra. */}
            {!result && !!movs.length && (
              <div className="mt-2 border-t border-border-subtle pt-2">
                <button type="button" onClick={() => setVerMovs((v) => !v)} className="text-[12px] font-medium text-brand hover:underline">
                  {verMovs ? "Ocultar" : "Ver"} los {movs.length} movimiento(s) de esta caja
                </button>
                {verMovs && (
                  <div className="mt-1.5 max-h-56 overflow-auto rounded-md border border-border-subtle bg-surface">
                    <table className="w-full text-[11.5px]">
                      <tbody>
                        {movs.map((m: any) => (
                          <tr key={m.id} className="border-b border-border-subtle last:border-0">
                            <td className="px-2 py-1 text-text-secondary">{m.payer}</td>
                            <td className="px-2 py-1 text-text-tertiary">{m.category}{m.transfer ? " (traslado)" : ""}</td>
                            <td className={`px-2 py-1 text-right tabular-nums ${m.type === "INCOME" ? "text-success-text" : "text-error-text"}`}>
                              {m.type === "INCOME" ? "+" : "−"}{cop(m.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
            {!result && !movs.length && (
              <p className="mt-2 border-t border-border-subtle pt-2 text-[11px] text-text-tertiary">
                Esta caja no tiene movimientos en esa fecha.
              </p>
            )}
          </div>
        );
      })()}

      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>{result ? "Cerrar" : "Cancelar"}</Button>
        {!result && <Button onClick={submit} disabled={saving || loadingPrev}>{saving ? "Guardando…" : "Cerrar caja"}</Button>}
      </div>
    </Modal>
  );
}

/** Anular una transacción. */
export function AnularModal({ tx, onClose, onDone }: { tx: { id: string; payer: string; amount: number } | null; onClose: () => void; onDone: () => void }) {
  const { authFetch } = useAuth();
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState("Anulado de Cierre");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (tx) { setReason(""); setDetail("Anulado de Cierre"); setErr(null); } }, [tx]);

  async function submit() {
    setErr(null);
    if (reason.trim().length < 3) { setErr("Escribe el motivo de la anulación."); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/treasury/transactions/${tx!.id}/void`, {
        method: "POST", body: JSON.stringify({ reason: reason.trim(), detail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo anular");
      toast("Transacción anulada");
      onDone(); onClose();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={!!tx} onClose={onClose} title="Anular transacción" maxWidth="max-w-md">
      {tx && (
        <div className="flex flex-col gap-3">
          <p className="text-[12px] text-text-secondary">
            Vas a anular el movimiento de <span className="font-semibold">{tx.payer}</span> por{" "}
            <span className="font-semibold">{cop(tx.amount)}</span>. Esto revierte el saldo de la factura asociada.
          </p>
          <Field label="Motivo" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej: Pago duplicado" autoFocus /></Field>
          <Field label="Detalle"><Select value={detail} onChange={(e) => setDetail(e.target.value)}><option>Anulado de Cierre</option><option>Anulado de otros Cierres</option></Select></Field>
          {err && <p className="text-[12px] text-error-text">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
            <Button variant="danger" onClick={submit} disabled={saving}>{saving ? "Anulando…" : "Anular"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
