"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { StatCard } from "@/components/ui/StatCard";

const emptyForm = { name: "", code: "", categoryId: "", warehouseId: "", price: "", cost: "", taxRate: "", qty: "", alert: "", description: "" };

export default function MaterialPage() {
  const { loading: authLoading, authFetch } = useAuth();

  const [stats, setStats] = useState<any>(null);
  const [categories, setCategories] = useState<any[]>([]);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  // Toma la categoría inicial de la URL (?categoryId=…) al entrar desde la
  // pantalla de Categorías. Client component → se lee del window sin Suspense.
  const [categoryId, setCategoryId] = useState<string>(() =>
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("categoryId") || "" : "",
  );
  const [warehouseId, setWarehouseId] = useState("");
  // ?lowStock=1 al entrar desde la campana de alertas de stock.
  const [lowStock, setLowStock] = useState<boolean>(() =>
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("lowStock") === "1" : false,
  );
  const [page, setPage] = useState(1);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [delRow, setDelRow] = useState<any>(null);
  const [deleting, setDeleting] = useState(false);
  const [importing, setImporting] = useState(false);

  async function importExcel(file: File) {
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await authFetch(`/inventory/materials/import`, { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo importar");
      toast(`Importados ${d.created} material(es)${d.skipped ? ` · ${d.skipped} omitidos` : ""}`, "check");
      await load();
    } catch (e: any) { toast(e.message, "alert-triangle"); } finally { setImporting(false); }
  }
  const [form, setForm] = useState<any>(emptyForm);
  const [saving, setSaving] = useState(false);

  const loadRefs = useCallback(async () => {
    const [cats, whs] = await Promise.all([
      (await authFetch("/inventory/categories")).json(),
      (await authFetch("/inventory/warehouses")).json(),
    ]);
    setCategories(Array.isArray(cats) ? cats : []);
    setWarehouses(Array.isArray(whs) ? whs : []);
  }, [authFetch]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (categoryId) params.set("categoryId", categoryId);
      if (warehouseId) params.set("warehouseId", warehouseId);
      if (lowStock) params.set("lowStock", "1");
      params.set("page", String(page));
      params.set("pageSize", "25");
      const [s, d] = await Promise.all([
        (await authFetch("/inventory/stats")).json(),
        (await authFetch(`/inventory/materials?${params.toString()}`)).json(),
      ]);
      setStats(s);
      setData(d);
    } finally {
      setLoading(false);
    }
  }, [authFetch, search, categoryId, warehouseId, lowStock, page]);

  useEffect(() => { if (!authLoading) void loadRefs(); }, [authLoading, loadRefs]);
  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  const set = (k: string) => (e: any) => setForm((f: any) => ({ ...f, [k]: e.target.value }));

  function openNew() {
    setEditing(null);
    setForm(emptyForm);
    setModalOpen(true);
  }

  /** El listado no trae categoryId ni descripción: se piden al detalle. */
  async function openEdit(row: any) {
    try {
      const res = await authFetch(`/inventory/materials/${row.id}`);
      const m = await res.json();
      if (!res.ok) throw new Error(m?.message || "No se pudo cargar el material");
      setEditing(m);
      setForm({
        name: m.name ?? "", code: m.code ?? "", categoryId: m.category?.id ?? "", warehouseId: m.warehouse?.id ?? "",
        price: m.price ?? "", cost: m.cost ?? "", taxRate: m.taxRate ?? "",
        qty: m.qty ?? "", alert: m.alert ?? "", description: m.description ?? "",
      });
      setModalOpen(true);
    } catch (e: any) {
      toast(e?.message || "No se pudo cargar el material", "alert-triangle");
    }
  }

  const submit = async () => {
    if (!form.name.trim()) { toast("El nombre es obligatorio"); return; }
    setSaving(true);
    try {
      const body: any = {
        name: form.name,
        code: form.code || undefined,
        categoryId: form.categoryId || undefined,
        price: form.price !== "" ? Number(form.price) : undefined,
        cost: form.cost !== "" ? Number(form.cost) : undefined,
        taxRate: form.taxRate !== "" ? Number(form.taxRate) : undefined,
        qty: form.qty !== "" ? Number(form.qty) : undefined,
        alert: form.alert !== "" ? Number(form.alert) : undefined,
        description: form.description || undefined,
      };
      // La bodega solo se fija al crear: moverla después exige un traspaso con acta.
      if (!editing) body.warehouseId = form.warehouseId || undefined;
      const res = await authFetch(
        editing ? `/inventory/materials/${editing.id}` : "/inventory/materials",
        { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) },
      );
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(editing ? "Material actualizado" : "Material creado", "check");
      setModalOpen(false);
      setEditing(null);
      setForm(emptyForm);
      await load();
    } catch (e: any) {
      toast(e?.message || "No se pudo guardar", "alert-triangle");
    } finally {
      setSaving(false);
    }
  };

  async function removeMaterial() {
    if (!delRow) return;
    setDeleting(true);
    try {
      const res = await authFetch(`/inventory/materials/${delRow.id}`, { method: "DELETE" });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "No se pudo eliminar");
      toast("Material eliminado", "check");
      setDelRow(null);
      await load();
    } catch (e: any) {
      toast(e?.message || "No se pudo eliminar", "alert-triangle");
    } finally {
      setDeleting(false);
    }
  }

  const columns = useMemo(() => [
    { key: "name", header: "Nombre", render: (r: any) => <span className="font-medium text-text-primary">{r.name}</span> },
    { key: "code", header: "Código", render: (r: any) => <span className="text-text-secondary">{r.code || "—"}</span> },
    { key: "category", header: "Categoría", render: (r: any) => <span className="text-text-secondary">{r.category || "—"}</span> },
    { key: "warehouse", header: "Bodega", render: (r: any) => <span className="text-text-secondary">{r.warehouse || "—"}</span> },
    { key: "price", header: "Precio", align: "right" as const, render: (r: any) => <span>{cop(r.price ?? 0)}</span> },
    { key: "qty", header: "Stock", align: "right" as const, render: (r: any) => r.low ? <Badge label={`${r.qty ?? 0} · Bajo`} tone="error" /> : <span>{r.qty ?? 0}</span> },
    { key: "value", header: "Valor", align: "right" as const, render: (r: any) => <span className="font-semibold">{cop(r.value ?? 0)}</span> },
    {
      key: "acciones", header: "", align: "right" as const,
      render: (r: any) => (
        <div className="flex justify-end gap-1">
          <button type="button" onClick={() => void openEdit(r)} className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" title="Editar">
            <Icon name="pencil" size={15} />
          </button>
          <button type="button" onClick={() => setDelRow(r)} className="rounded-md p-1.5 text-text-tertiary hover:bg-error-soft hover:text-error-text" title="Eliminar">
            <Icon name="trash" size={15} />
          </button>
        </div>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  if (authLoading || (loading && !data)) return <PageSkeleton />;

  const rows = data?.items ?? [];

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeading icon="boxes" title="Material" subtitle="Inventario de materiales y existencias" />
        <div className="flex items-center gap-2">
          <Link href="/inventario/traspasos"><Button variant="secondary" size="sm"><Icon name="arrow-left" size={14} />Traspasos</Button></Link>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-default bg-surface px-3 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
            <Icon name={importing ? "loader" : "upload"} size={14} className={importing ? "animate-spin" : ""} /> {importing ? "Importando…" : "Importar Excel"}
            <input type="file" accept=".xlsx" className="hidden" disabled={importing} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importExcel(f); e.target.value = ""; }} />
          </label>
          <Button variant="primary" size="sm" onClick={openNew}><Icon name="plus" size={14} />Nuevo material</Button>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Materiales" value={String(stats.materiales ?? 0)} icon="package" />
          <StatCard label="Categorías" value={String(stats.categorias ?? 0)} icon="layers" />
          <StatCard label="Bodegas" value={String(stats.bodegas ?? 0)} icon="boxes" />
          <StatCard label="Stock bajo" value={String(stats.stockBajo ?? 0)} icon="alert-triangle" tone="text-error-text" />
          <StatCard label="Valor inventario" value={cop(stats.valorInventario ?? 0)} icon="dollar-sign" />
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Buscar">
          <Input value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} placeholder="Nombre o código…" />
        </Field>
        <Field label="Categoría">
          <Select value={categoryId} onChange={(e) => { setPage(1); setCategoryId(e.target.value); }}>
            <option value="">Todas</option>
            {categories.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </Select>
        </Field>
        <Field label="Bodega">
          <Select value={warehouseId} onChange={(e) => { setPage(1); setWarehouseId(e.target.value); }}>
            <option value="">Todas</option>
            {warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.title}</option>)}
          </Select>
        </Field>
        <Button variant={lowStock ? "primary" : "secondary"} size="md" onClick={() => { setPage(1); setLowStock((v) => !v); }}>
          <Icon name="alert-triangle" size={14} />Solo stock bajo
        </Button>
      </div>

      <DataTable rows={rows} empty="No hay materiales." columns={columns} />

      {data && (
        <Pagination
          meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }}
          onPage={setPage}
        />
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? "Editar material" : "Nuevo material"} maxWidth="max-w-lg">
        <div className="flex flex-col gap-3">
          <Field label="Nombre" required>
            <Input value={form.name} onChange={set("name")} placeholder="Nombre del material" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Código"><Input value={form.code} onChange={set("code")} /></Field>
            <Field label="Categoría">
              <Select value={form.categoryId} onChange={set("categoryId")}>
                <option value="">Sin categoría</option>
                {categories.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </Select>
            </Field>
          </div>
          {editing ? (
            <Field label="Bodega" hint="Para mover el material a otra bodega usa un traspaso, que deja acta del movimiento.">
              <Input value={editing.warehouse?.title ?? "Sin bodega"} disabled />
            </Field>
          ) : (
            <Field label="Bodega">
              <Select value={form.warehouseId} onChange={set("warehouseId")}>
                <option value="">Sin bodega</option>
                {warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.title}</option>)}
              </Select>
            </Field>
          )}
          <div className="grid grid-cols-3 gap-3">
            <Field label="Precio"><Input type="number" value={form.price} onChange={set("price")} /></Field>
            <Field label="Costo"><Input type="number" value={form.cost} onChange={set("cost")} /></Field>
            <Field label="IVA %"><Input type="number" value={form.taxRate} onChange={set("taxRate")} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Stock"><Input type="number" value={form.qty} onChange={set("qty")} /></Field>
            <Field label="Alerta stock"><Input type="number" value={form.alert} onChange={set("alert")} /></Field>
          </div>
          <Field label="Descripción">
            <Textarea rows={3} value={form.description} onChange={set("description")} />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setModalOpen(false)}><Icon name="x" size={14} />Cancelar</Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={saving}><Icon name="check" size={14} />{saving ? "Guardando…" : editing ? "Guardar cambios" : "Crear"}</Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(delRow)}
        title="Eliminar material"
        message={<>¿Seguro que quieres eliminar <strong>{delRow?.name}</strong> del inventario? Esta acción no se puede deshacer.</>}
        confirmLabel="Eliminar"
        busy={deleting}
        onConfirm={removeMaterial}
        onClose={() => setDelRow(null)}
      />
    </>
  );
}
