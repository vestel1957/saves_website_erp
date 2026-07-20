"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/format";
import { useRequest } from "@/lib/useRequest";
import { mensajeDeError } from "@/lib/errores";

const CATEGORY_LABEL: Record<number, string> = { 1: "Productos", 2: "Servicios" };

const EMPTY_FORM = {
  name: "",
  category: "1",
  nit: "",
  phone: "",
  email: "",
  address: "",
  city: "",
  bank: "",
  account: "",
  company: "",
};

export default function ProveedoresPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [tab, setTab] = useState<1 | 2>(1);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<any>(null);
  const [statement, setStatement] = useState<any>(null);
  const [stmtLoading, setStmtLoading] = useState(false);

  // Carga con cancelación: al teclear se aborta la petición en vuelo para que
  // una respuesta lenta no pise a otra más reciente. Ver lib/useRequest.
  const { data, cargando: loading, error, refrescar: load } = useRequest<any>(
    () => {
      const qs = new URLSearchParams({ category: String(tab), page: String(page), pageSize: String(pageSize) });
      if (search.trim()) qs.set("search", search.trim());
      return `/orders/suppliers?${qs.toString()}`;
    },
    [tab, page, pageSize, search],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  useEffect(() => { setPage(1); }, [tab, search, pageSize]);

  const submit = async () => {
    if (!form.name.trim()) { toast("El nombre es obligatorio", "alert-triangle"); return; }
    setSaving(true);
    try {
      const body: any = {
        name: form.name.trim(),
        category: Number(form.category),
      };
      for (const k of ["nit", "phone", "email", "address", "city", "bank", "account", "company"]) {
        if (form[k]?.trim()) body[k] = form[k].trim();
      }
      const url = editingId ? `/orders/suppliers/${editingId}` : "/orders/suppliers";
      const res = await authFetch(url, { method: editingId ? "PATCH" : "POST", body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(editingId ? "Proveedor actualizado" : "Proveedor creado");
      setOpen(false);
      setForm(EMPTY_FORM);
      setEditingId(null);
      await load();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo guardar el proveedor"), "alert-triangle");
    } finally {
      setSaving(false);
    }
  };

  function editSupplier(r: any) {
    setEditingId(r.id);
    setForm({
      name: r.name ?? "", category: String(r.category ?? 1), nit: r.nit ?? "", phone: r.phone ?? "",
      email: r.email ?? "", address: r.address ?? "", city: r.city ?? "", bank: r.bank ?? "", account: r.account ?? "", company: r.company ?? "",
    });
    setOpen(true);
  }

  async function doDelete() {
    if (!toDelete) return;
    try {
      const res = await authFetch(`/orders/suppliers/${toDelete.id}`, { method: "DELETE" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo eliminar");
      toast("Proveedor eliminado"); setToDelete(null); await load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); setToDelete(null); }
  }

  async function showStatement(r: any) {
    setStmtLoading(true); setStatement({ loading: true, name: r.name });
    try {
      const res = await authFetch(`/orders/suppliers/${r.id}/statement`);
      setStatement(await res.json());
    } catch { toast("No se pudo cargar el estado de cuenta", "alert-triangle"); setStatement(null); }
    finally { setStmtLoading(false); }
  }

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <PageHeading icon="user" title="Proveedores" subtitle="Directorio de proveedores de productos y servicios" />

      {/* Tabs categoría */}
      <div className="flex items-center gap-2">
        {([1, 2] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setTab(c)}
            className={`rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors ${
              tab === c ? "bg-brand text-on-brand" : "border border-border-default text-text-secondary hover:bg-surface-2"
            }`}
          >
            {CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>

      {/* Filtros + acción */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder="Buscar por nombre, NIT o ciudad…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Button variant="primary" onClick={() => { setForm(EMPTY_FORM); setOpen(true); }}>
          <Icon name="plus" size={15} /> Nuevo proveedor
        </Button>
      </div>

      {/* Tabla */}
      {loading && !data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable
            rows={data?.items ?? []}
            empty="No se encontraron proveedores con esos criterios."
            columns={[
              { key: "name", header: "Nombre", render: (r: any) => <span className="font-medium text-text-primary">{r.name}</span> },
              { key: "nit", header: "NIT", render: (r: any) => <span className="text-text-secondary">{r.nit ?? "—"}</span> },
              { key: "phone", header: "Teléfono", render: (r: any) => r.phone ?? "—" },
              { key: "city", header: "Ciudad", render: (r: any) => r.city ?? "—" },
              { key: "bank", header: "Banco", render: (r: any) => r.bank ?? "—" },
              { key: "orders", header: "# Órdenes", align: "right", render: (r: any) => <span className="font-semibold text-text-secondary">{r.orders ?? 0}</span> },
              { key: "actions", header: "", align: "right", render: (r: any) => (
                <div className="flex justify-end gap-2">
                  <button type="button" title="Estado de cuenta" onClick={() => showStatement(r)} className="text-text-tertiary hover:text-brand"><Icon name="scroll-text" size={14} /></button>
                  <button type="button" title="Editar" onClick={() => editSupplier(r)} className="text-text-tertiary hover:text-brand"><Icon name="pencil" size={14} /></button>
                  <button type="button" title="Eliminar" onClick={() => setToDelete(r)} className="text-text-tertiary hover:text-error-text"><Icon name="trash" size={14} /></button>
                </div>
              ) },
            ]}
          />
          {data && data.pages > 1 && (
            <div className="mt-3">
              <Pagination
                meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }}
                onPage={setPage}
                onPageSize={setPageSize}
              />
            </div>
          )}
        </>
      )}

      <Modal open={open} onClose={() => { setOpen(false); setEditingId(null); }} title={editingId ? "Editar proveedor" : "Nuevo proveedor"}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Nombre" required>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Razón social o nombre" />
            </Field>
          </div>
          <Field label="Categoría">
            <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="1">Productos</option>
              <option value="2">Servicios</option>
            </Select>
          </Field>
          <Field label="NIT">
            <Input value={form.nit} onChange={(e) => setForm({ ...form, nit: e.target.value })} />
          </Field>
          <Field label="Teléfono">
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Dirección">
            <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </Field>
          <Field label="Ciudad">
            <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
          </Field>
          <Field label="Banco">
            <Input value={form.bank} onChange={(e) => setForm({ ...form, bank: e.target.value })} />
          </Field>
          <Field label="Cuenta">
            <Input value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Empresa">
              <Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
            </Field>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={() => { setOpen(false); setEditingId(null); }} disabled={saving}>Cancelar</Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            <Icon name="check" size={15} /> {saving ? "Guardando…" : editingId ? "Guardar" : "Crear proveedor"}
          </Button>
        </div>
      </Modal>

      {/* Estado de cuenta del proveedor */}
      <Modal open={!!statement} onClose={() => setStatement(null)} title={`Estado de cuenta · ${statement?.supplier?.name ?? statement?.name ?? ""}`} maxWidth="max-w-3xl">
        {stmtLoading || statement?.loading ? (
          <p className="py-6 text-center text-[13px] text-text-tertiary">Cargando…</p>
        ) : statement ? (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-2">
              {([["Total comprado", statement.totals?.totalOrdered], ["Pagado", statement.totals?.totalPaid], ["Saldo", statement.totals?.saldo]] as const).map(([lbl, val]) => (
                <div key={lbl} className="rounded-lg border border-border-subtle bg-surface-2 p-3 text-center">
                  <div className="text-[15px] font-bold tabular-nums text-text-primary">{cop(Number(val) || 0)}</div>
                  <div className="text-[11px] text-text-tertiary">{lbl}</div>
                </div>
              ))}
            </div>
            <div>
              <h3 className="mb-1 text-[12px] font-bold uppercase tracking-wide text-text-tertiary">Órdenes</h3>
              <DataTable autoHeight rows={statement.orders ?? []} empty="Sin órdenes."
                columns={[
                  { key: "tid", header: "#", render: (o: any) => <span className="font-mono">#{o.tid}</span> },
                  { key: "total", header: "Total", align: "right", render: (o: any) => cop(o.total) },
                  { key: "paid", header: "Pagado", align: "right", render: (o: any) => cop(o.paid) },
                  { key: "bal", header: "Saldo", align: "right", render: (o: any) => <span className={o.balance > 0 ? "text-error-text" : ""}>{cop(o.balance)}</span> },
                  { key: "st", header: "Estado", render: (o: any) => o.status },
                ]} />
            </div>
            <div>
              <h3 className="mb-1 text-[12px] font-bold uppercase tracking-wide text-text-tertiary">Pagos</h3>
              <DataTable autoHeight rows={statement.payments ?? []} empty="Sin pagos registrados."
                columns={[
                  { key: "date", header: "Fecha", render: (p: any) => p.date ? new Date(p.date).toLocaleDateString("es-CO") : "—" },
                  { key: "amount", header: "Monto", align: "right", render: (p: any) => cop(p.amount) },
                  { key: "note", header: "Concepto", render: (p: any) => <span className="text-text-secondary">{p.note ?? p.category}</span> },
                ]} />
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        title="Eliminar proveedor"
        message={<>¿Eliminar el proveedor <b>{toDelete?.name}</b>? Solo es posible si no tiene órdenes ni devoluciones.</>}
        confirmLabel="Eliminar"
        onConfirm={doDelete}
        onClose={() => setToDelete(null)}
      />
    </>
  );
}
