"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Field";
import { PagedTable } from "@/components/ui/PagedTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import type { CashAccount } from "@/lib/cobranzas";
import { mensajeDeError } from "@/lib/errores";
import { useValidacion, requerido, numero } from "@/lib/useValidacion";
import { RangoFechas, rangoDePreset, rangoDeUrl, rangoAUrl, etiquetaRango, type RangoFechasValor } from "@/components/ui/RangoFechas";
import { useFiltrosEnUrl, useFiltrosRecordados } from "@/lib/useFiltrosUrl";

type Category = { id: string; name: string };

/** Modal de alta/edición de una caja o banco. */
function CajaModal({ caja, onClose, onDone }: { caja: CashAccount | "new" | null; onClose: () => void; onDone: () => void }) {
  const { authFetch } = useAuth();
  const editing = caja && caja !== "new";
  const [holder, setHolder] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [fixedFund, setFixedFund] = useState("200000");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const v = useValidacion(
    { holder, fixedFund },
    { holder: requerido("El nombre de la caja es obligatorio."), fixedFund: numero({ min: 0 }) },
  );

  useEffect(() => {
    // Al reabrir el modal se olvida lo ya marcado: si no, la caja nueva se
    // estrena con el error de la edición anterior todavía en rojo.
    v.limpiar();
    if (caja && caja !== "new") {
      setHolder(caja.name ?? ""); setAccountNumber(caja.accountNumber ?? ""); setCode(caja.code ?? "");
      setFixedFund(String(caja.fixedFund ?? 200000));
      setPhone(""); setAddress(""); setErr(null);
    } else if (caja === "new") {
      setHolder(""); setAccountNumber(""); setCode(""); setPhone(""); setAddress("");
      setFixedFund("200000"); setErr(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caja]);

  async function submit() {
    setErr(null);
    if (!v.revisar()) return;
    setSaving(true);
    try {
      const body = {
        holder: holder.trim(), accountNumber: accountNumber || undefined,
        code: code || undefined, phone: phone || undefined, address: address || undefined,
        fixedFund: Number(fixedFund) || 0,
      };
      const url = editing ? `/treasury/cash-accounts/${(caja as CashAccount).id}` : `/treasury/cash-accounts`;
      const res = await authFetch(url, { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo guardar");
      toast(editing ? "Caja actualizada" : "Caja creada", "check");
      onDone(); onClose();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={!!caja} onClose={onClose} title={editing ? "Editar caja" : "Nueva caja / banco"} maxWidth="max-w-lg">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label="Nombre de la caja" required error={v.error("holder")}><Input value={holder} onChange={(e) => setHolder(e.target.value)} placeholder="Ej: Caja principal Yopal" autoFocus {...v.campo("holder")} /></Field></div>
        <Field label="N.º de cuenta" hint="Si es un banco"><Input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} /></Field>
        <Field label="Código"><Input value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <Field label="Teléfono"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <Field label="Dirección"><Input value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
        <div className="sm:col-span-2">
          <Field
            label="Base de apertura (fondo fijo)"
            hint="Con cuánto arranca esta caja. Es lo que se registra cuando la cajera pulsa «Abrir caja» (más el arrastre del cierre anterior): ella no la teclea. Nunca sale del cajón y no entra en el excedente del arqueo."
            error={v.error("fixedFund")}
          >
            <Input type="number" min={0} value={fixedFund} onChange={(e) => setFixedFund(e.target.value)} {...v.campo("fixedFund")} />
          </Field>
        </div>
      </div>
      {err && <p className="mt-2 text-[12px] text-error-text">{err}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button onClick={submit} disabled={saving}>{saving ? "Guardando…" : editing ? "Guardar" : "Crear caja"}</Button>
      </div>
    </Modal>
  );
}

/**
 * El rango de fechas y la búsqueda viven en la URL (`?q=…&periodo=…&desde=…&hasta=…`),
 * como en Movimientos: recargar o pasar el enlace deja la pantalla igual.
 */
export default function CajasPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <CajasConFiltros />
    </Suspense>
  );
}

function CajasConFiltros() {
  const { loading: authLoading } = useAuth();
  const inicial = useFiltrosRecordados();
  if (authLoading || !inicial) return <PageSkeleton />;
  return <Cajas urlInicial={inicial.valores} />;
}

function Cajas({ urlInicial }: { urlInicial: Record<string, string> }) {
  const { loading: authLoading, authFetch } = useAuth();
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [cajaModal, setCajaModal] = useState<CashAccount | "new" | null>(null);
  const [toDelete, setToDelete] = useState<CashAccount | null>(null);
  const [newCat, setNewCat] = useState("");
  const [catToDelete, setCatToDelete] = useState<Category | null>(null);
  const [search, setSearch] = useState(urlInicial.q ?? "");
  /** Periodo: el saldo de la columna «Saldo hoy» es el de siempre; el rango decide lo
   *  que entró y salió de cada caja y con qué saldo abrió y cerró ese periodo. */
  const [rango, setRango] = useState<RangoFechasValor>(() => rangoDeUrl(urlInicial));

  useFiltrosEnUrl({ q: search.trim(), ...rangoAUrl(rango) });

  // Filtro en cliente por nombre/número de cuenta sobre lo ya cargado.
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) => [a.name, a.accountNumber, a.code].some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [accounts, search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, c] = await Promise.all([
        authFetch(`/treasury/cash-accounts?${new URLSearchParams({ from: rango.desde, to: rango.hasta })}`).then((r) => (r.ok ? r.json() : [])),
        authFetch(`/treasury/categories`).then((r) => (r.ok ? r.json() : [])),
      ]);
      setAccounts(a); setCategories(c);
    } finally { setLoading(false); }
  }, [authFetch, rango.desde, rango.hasta]);

  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  async function recompute(id: number) {
    try {
      const res = await authFetch(`/treasury/cash-accounts/${id}/recompute`, { method: "POST" });
      if (!res.ok) throw new Error();
      toast("Saldo recalculado", "check");
      void load();
    } catch { toast("No se pudo recalcular", "alert-triangle"); }
  }

  async function doDeleteCaja() {
    if (!toDelete) return;
    try {
      const res = await authFetch(`/treasury/cash-accounts/${toDelete.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo eliminar");
      toast("Caja eliminada", "check"); setToDelete(null); void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); setToDelete(null); }
  }

  async function createCat() {
    const name = newCat.trim();
    if (!name) return;
    try {
      const res = await authFetch(`/treasury/categories`, { method: "POST", body: JSON.stringify({ name }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo crear");
      setNewCat(""); toast("Categoría creada", "check"); void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); }
  }

  async function renameCat(c: Category) {
    const name = window.prompt("Nuevo nombre de la categoría", c.name)?.trim();
    if (!name || name === c.name) return;
    try {
      const res = await authFetch(`/treasury/categories/${c.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo renombrar");
      toast("Categoría renombrada", "check"); void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); }
  }

  async function doDeleteCat() {
    if (!catToDelete) return;
    try {
      const res = await authFetch(`/treasury/categories/${catToDelete.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo eliminar");
      toast("Categoría eliminada", "check"); setCatToDelete(null); void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); setCatToDelete(null); }
  }

  if (authLoading || (loading && accounts.length === 0)) return <PageSkeleton />;

  const totalSaldo = accounts.reduce((s, a) => s + (a.balance ?? 0), 0);
  const totales = shown.reduce(
    (t, a) => ({ ingresos: t.ingresos + (a.periodo?.ingresos ?? 0), egresos: t.egresos + (a.periodo?.egresos ?? 0) }),
    { ingresos: 0, egresos: 0 },
  );
  // Enlace a Movimientos con la caja y el mismo rango puestos.
  const verMovimientos = (a: CashAccount) =>
    `/tesoreria?${new URLSearchParams({ caja: String(a.id), periodo: "personalizado", desde: rango.desde, hasta: rango.hasta })}`;
  const monto = (v: number | undefined, clase = "") => <span className={`tabular-nums ${clase}`}>{cop(v ?? 0)}</span>;

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="wallet" title="Cajas y categorías" subtitle="Administra las cajas/bancos y las categorías de movimientos" />
        <Button size="sm" onClick={() => setCajaModal("new")}><Icon name="plus" size={14} /> Nueva caja</Button>
      </div>

      <section className="mt-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-bold uppercase tracking-wide text-text-tertiary">Cajas y bancos</h2>
          <span className="text-[12px] text-text-secondary">Saldo total hoy: <b className="text-text-primary">{cop(totalSaldo)}</b></span>
        </div>
        <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar caja o banco…">
          <RangoFechas value={rango} onChange={setRango} presets={["hoy", "semana", "mes", "mesPasado", "anio", "personalizado"]} />
        </ListToolbar>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-secondary">
          <span>{etiquetaRango(rango)}{loading && " · actualizando…"}</span>
          <span>Ingresos: <b className="tabular-nums text-success-text">{cop(totales.ingresos)}</b></span>
          <span>Egresos: <b className="tabular-nums text-error-text">{cop(totales.egresos)}</b></span>
          <span>Neto: <b className="tabular-nums text-text-primary">{cop(totales.ingresos - totales.egresos)}</b></span>
        </div>
        <PagedTable
          rows={shown}
          empty={search ? "Ninguna caja coincide con la búsqueda." : "No hay cajas registradas."}
          columns={[
            { key: "name", header: "Caja / Banco", render: (a: CashAccount) => <span className="font-medium text-text-primary">{a.name}</span> },
            { key: "acc", header: "N.º cuenta", render: (a: CashAccount) => a.accountNumber || "—" },
            { key: "inicial", header: "Saldo inicial", align: "right" as const, render: (a: CashAccount) => monto(a.periodo?.saldoInicial, "text-text-secondary") },
            { key: "ingresos", header: "Ingresos", align: "right" as const, render: (a: CashAccount) => monto(a.periodo?.ingresos, "text-success-text") },
            { key: "egresos", header: "Egresos", align: "right" as const, render: (a: CashAccount) => monto(a.periodo?.egresos, "text-error-text") },
            { key: "final", header: "Saldo final", align: "right" as const, render: (a: CashAccount) => monto(a.periodo?.saldoFinal, "font-semibold") },
            { key: "movs", header: "Movs.", align: "right" as const, render: (a: CashAccount) => a.periodo?.movimientos
              ? <Link href={verMovimientos(a)} className="tabular-nums text-brand hover:underline" title="Ver los movimientos de esta caja en el periodo">{a.periodo.movimientos}</Link>
              : <span className="text-text-tertiary">0</span> },
            { key: "saldo", header: "Saldo hoy", align: "right" as const, render: (a: CashAccount) => monto(a.balance, "text-text-secondary") },
            { key: "estado", header: "", render: (a: CashAccount) => a.persisted === false ? <span className="text-[11px] text-text-tertiary">derivada</span> : null },
            { key: "acciones", header: "", align: "right" as const, render: (a: CashAccount) => (
              <div className="flex justify-end gap-2">
                <button type="button" title="Recalcular saldo" onClick={() => recompute(a.id)} className="tap text-text-tertiary hover:text-brand"><Icon name="refresh-cw" size={14} /></button>
                {a.persisted !== false && <>
                  <button type="button" title="Editar" onClick={() => setCajaModal(a)} className="tap text-text-tertiary hover:text-brand"><Icon name="pencil" size={14} /></button>
                  <button type="button" title="Eliminar" onClick={() => setToDelete(a)} className="tap text-text-tertiary hover:text-error-text"><Icon name="trash" size={14} /></button>
                </>}
              </div>
            ) },
          ]}
        />
        <p className="text-[11px] text-text-tertiary">Las cajas «derivadas» provienen de movimientos antiguos y no tienen ficha propia. Recalcula su saldo o créalas formalmente para editarlas.</p>
      </section>

      <section className="mt-8 flex flex-col gap-2">
        <h2 className="text-[13px] font-bold uppercase tracking-wide text-text-tertiary">Categorías de movimientos</h2>
        <div className="flex max-w-md items-end gap-2">
          <div className="flex-1"><Field label="Nueva categoría"><Input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="Ej: Comisiones" onKeyDown={(e) => { if (e.key === "Enter") void createCat(); }} /></Field></div>
          <Button size="sm" onClick={createCat} disabled={!newCat.trim()}><Icon name="plus" size={14} /> Añadir</Button>
        </div>
        <div className="mt-1 flex flex-wrap gap-2">
          {categories.length === 0 && <span className="text-[12px] text-text-tertiary">No hay categorías.</span>}
          {categories.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface-2 px-3 py-1 text-[12.5px] text-text-primary">
              {c.name}
              <button type="button" title="Renombrar" onClick={() => renameCat(c)} className="tap text-text-tertiary hover:text-brand"><Icon name="pencil" size={12} /></button>
              <button type="button" title="Eliminar" onClick={() => setCatToDelete(c)} className="tap text-text-tertiary hover:text-error-text"><Icon name="x" size={12} /></button>
            </span>
          ))}
        </div>
      </section>

      <CajaModal caja={cajaModal} onClose={() => setCajaModal(null)} onDone={load} />
      <ConfirmDialog
        open={!!toDelete}
        title="Eliminar caja"
        message={<>¿Eliminar la caja <b>{toDelete?.name}</b>? Solo es posible si no tiene movimientos.</>}
        confirmLabel="Eliminar"
        onConfirm={doDeleteCaja}
        onClose={() => setToDelete(null)}
      />
      <ConfirmDialog
        open={!!catToDelete}
        title="Eliminar categoría"
        message={<>¿Eliminar la categoría <b>{catToDelete?.name}</b>? Solo es posible si no está en uso.</>}
        confirmLabel="Eliminar"
        onConfirm={doDeleteCat}
        onClose={() => setCatToDelete(null)}
      />
    </>
  );
}
