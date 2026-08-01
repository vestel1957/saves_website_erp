"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { StatCard } from "@/components/ui/StatCard";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { mensajeDeError } from "@/lib/errores";

const STATUS_TONE: Record<string, "default" | "success" | "error" | "warning" | "info" | "brand"> = {
  DRAFT: "default",
  PENDING: "warning",
  APPROVED: "info",
  COMPLETED: "success",
  CANCELED: "error",
};
const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Borrador",
  PENDING: "Pendiente",
  APPROVED: "Aprobada",
  COMPLETED: "Completada",
  CANCELED: "Anulada",
};

type ItemRow = { materialId: any; name: string; code?: string; qty: number; price: number };

export default function DevolucionesPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [stats, setStats] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Modal nueva devolución
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [supplier, setSupplier] = useState<any>(null);
  const [supplierQuery, setSupplierQuery] = useState("");
  const [supplierResults, setSupplierResults] = useState<any[]>([]);
  const [materialQuery, setMaterialQuery] = useState("");
  const [materialResults, setMaterialResults] = useState<any[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);

  // Carga con cancelación: al teclear se aborta la petición en vuelo para que
  // una respuesta lenta no pise a otra más reciente. Ver lib/useRequest.
  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const { data, cargando: loading, error, refrescar: load } = useRequest<any>(
    () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...orden.params });
      if (search.trim()) qs.set("search", search.trim());
      if (status) qs.set("status", status);
      return `/returns?${qs.toString()}`;
    },
    [page, pageSize, search, status],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/returns/stats").then((r) => r.json()).then(setStats).catch(() => {});
  }, [authLoading, authFetch]);

  useEffect(() => { setPage(1); }, [search, status, pageSize, orden.clave]);

  // Búsqueda de proveedores (debounce)
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      const qs = new URLSearchParams({ pageSize: "8" });
      if (supplierQuery.trim()) qs.set("search", supplierQuery.trim());
      try {
        const d = await (await authFetch(`/orders/suppliers?${qs.toString()}`)).json();
        setSupplierResults(d?.items ?? []);
      } catch { setSupplierResults([]); }
    }, 300);
    return () => clearTimeout(t);
  }, [open, supplierQuery, authFetch]);

  // Búsqueda de materiales (debounce)
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      const qs = new URLSearchParams({ pageSize: "8" });
      if (materialQuery.trim()) qs.set("search", materialQuery.trim());
      try {
        const d = await (await authFetch(`/inventory/materials?${qs.toString()}`)).json();
        setMaterialResults(d?.items ?? []);
      } catch { setMaterialResults([]); }
    }, 300);
    return () => clearTimeout(t);
  }, [open, materialQuery, authFetch]);

  const total = useMemo(() => items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0), [items]);

  const resetModal = () => {
    setDate(new Date().toISOString().slice(0, 10));
    setNotes("");
    setSupplier(null);
    setSupplierQuery("");
    setSupplierResults([]);
    setMaterialQuery("");
    setMaterialResults([]);
    setItems([]);
  };

  const addMaterial = (m: any) => {
    setItems((prev) => {
      if (prev.some((it) => it.materialId === m.id)) return prev;
      return [...prev, { materialId: m.id, name: m.name, code: m.code, qty: 1, price: Number(m.price) || 0 }];
    });
    setMaterialQuery("");
    setMaterialResults([]);
  };

  const updateItem = (id: any, patch: Partial<ItemRow>) => {
    setItems((prev) => prev.map((it) => (it.materialId === id ? { ...it, ...patch } : it)));
  };

  const removeItem = (id: any) => setItems((prev) => prev.filter((it) => it.materialId !== id));

  const submit = async () => {
    if (!supplier) { toast("Selecciona un proveedor", "alert-triangle"); return; }
    if (!items.length) { toast("Agrega al menos un material", "alert-triangle"); return; }
    setSaving(true);
    try {
      const body = {
        supplierId: supplier.id,
        date,
        notes: notes.trim() || undefined,
        items: items.map((it) => ({ materialId: it.materialId, qty: Number(it.qty) || 0, price: Number(it.price) || 0 })),
      };
      const res = await authFetch("/returns", { method: "POST", body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast("Devolución creada");
      setOpen(false);
      resetModal();
      void authFetch("/returns/stats").then((r) => r.json()).then(setStats).catch(() => {});
      await load();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo crear la devolución"), "alert-triangle");
    } finally {
      setSaving(false);
    }
  };

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <PageHeading icon="trending-down" title="Devoluciones" subtitle="Devoluciones a proveedores" />

      {/* Tarjetas */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total devoluciones" value={(stats?.total ?? 0).toLocaleString("es-CO")} icon="receipt" />
        <StatCard label="Monto total" value={cop(stats?.montoTotal ?? 0)} icon="dollar-sign" />
      </div>

      {/* Filtros + acción */}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Buscar por # o proveedor…"
        actions={
          <Button variant="primary" onClick={() => { resetModal(); setOpen(true); }}>
            <Icon name="plus" size={15} /> Nueva devolución
          </Button>
        }
      >
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">Todos los estados</option>
          {Object.keys(STATUS_TONE).map((k) => <option key={k} value={k}>{STATUS_LABEL[k] ?? k}</option>)}
        </Select>
      </ListToolbar>

      {/* Tabla */}
      {loading && !data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable
            sort={orden.sort}
            onSort={orden.onSort}
            rows={data?.items ?? []}
            empty="No se encontraron devoluciones con esos criterios."
            columns={[
              { key: "tid", header: "#", sortable: true, render: (r: any) => <Link href={`/devoluciones/${r.id}`} className="font-mono font-semibold text-brand hover:underline">{r.tid}</Link> },
              { key: "supplier", header: "Proveedor", sortable: true, render: (r: any) => <span className="font-medium text-text-primary">{r.supplier ?? "—"}</span> },
              { key: "date", header: "Fecha", sortable: true, render: (r: any) => <span className="text-text-secondary">{r.date ?? "—"}</span> },
              { key: "total", header: "Total", sortable: true, align: "right", render: (r: any) => <span className="font-semibold text-text-secondary">{cop(r.total)}</span> },
              { key: "status", header: "Estado", sortable: true, render: (r: any) => <Badge label={STATUS_LABEL[r.status] ?? r.status ?? "—"} tone={STATUS_TONE[r.status ?? ""] ?? "default"} /> },
              { key: "itemsCount", header: "# Ítems", sortable: true, align: "right", render: (r: any) => r.itemsCount ?? 0 },
            ]}
          />
          {data && (
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

      <Modal open={open} onClose={() => setOpen(false)} title="Nueva devolución" maxWidth="max-w-2xl">
        <div className="flex flex-col gap-3">
          {/* Proveedor */}
          <Field label="Proveedor" required>
            {supplier ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border-default bg-surface-2 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-text-primary">{supplier.name}</div>
                  <div className="text-[11px] text-text-tertiary">{supplier.nit ?? "Sin NIT"}</div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setSupplier(null)}><Icon name="x" size={14} /></Button>
              </div>
            ) : (
              <div className="relative">
                <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                <Input className="pl-9" placeholder="Buscar proveedor…" value={supplierQuery} onChange={(e) => setSupplierQuery(e.target.value)} />
                {supplierResults.length > 0 && (
                  <div className="mt-1 max-h-52 overflow-y-auto rounded-lg border border-border-subtle bg-surface shadow-lg">
                    {supplierResults.map((s: any) => (
                      <button key={s.id} type="button" onClick={() => { setSupplier(s); setSupplierQuery(""); setSupplierResults([]); }}
                        className="flex w-full items-center justify-between gap-2 border-b border-border-subtle px-3 py-2 text-left last:border-0 hover:bg-surface-2">
                        <span className="truncate text-[13px] font-medium text-text-primary">{s.name}</span>
                        <span className="shrink-0 text-[11px] text-text-tertiary">{s.nit ?? ""}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Field>

          {/* Materiales */}
          <Field label="Materiales">
            <div className="relative">
              <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
              <Input className="pl-9" placeholder="Buscar material para agregar…" value={materialQuery} onChange={(e) => setMaterialQuery(e.target.value)} />
              {materialResults.length > 0 && (
                <div className="mt-1 max-h-52 overflow-y-auto rounded-lg border border-border-subtle bg-surface shadow-lg">
                  {materialResults.map((m: any) => (
                    <button key={m.id} type="button" onClick={() => addMaterial(m)}
                      className="flex w-full items-center justify-between gap-2 border-b border-border-subtle px-3 py-2 text-left last:border-0 hover:bg-surface-2">
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-text-primary">{m.name}</span>
                        <span className="block text-[11px] text-text-tertiary">{m.code ?? ""} · stock {m.qty ?? 0}</span>
                      </span>
                      <span className="shrink-0 text-[12px] font-semibold text-text-secondary">{cop(m.price)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Field>

          {/* Ítems agregados.
              `overflow-hidden` recortaba en móvil: con dos inputs y cinco
              columnas la tabla no baja de ~34 rem, así que el subtotal y el
              botón de quitar quedaban cortados y sin forma de alcanzarlos.
              Ahora la tabla se desplaza en horizontal dentro de su marco. */}
          {items.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border-subtle">
              <table className="w-full min-w-[34rem] text-[12px]">
                <thead>
                  <tr className="border-b border-border-subtle bg-surface-2 text-text-tertiary">
                    <th className="px-2 py-1.5 text-left font-semibold">Material</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Cant.</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Precio</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Subtotal</th>
                    <th className="px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.materialId} className="border-b border-border-subtle last:border-0">
                      <td className="px-2 py-1.5">
                        <span className="block font-medium text-text-primary">{it.name}</span>
                        {it.code && <span className="block text-[10px] text-text-tertiary">{it.code}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Input type="number" min={1} className="w-20 text-right" value={it.qty}
                          onChange={(e) => updateItem(it.materialId, { qty: Number(e.target.value) })} />
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Input type="number" min={0} className="w-28 text-right" value={it.price}
                          onChange={(e) => updateItem(it.materialId, { price: Number(e.target.value) })} />
                      </td>
                      <td className="px-2 py-1.5 text-right font-semibold text-text-secondary">{cop((Number(it.qty) || 0) * (Number(it.price) || 0))}</td>
                      <td className="px-2 py-1.5 text-right">
                        <Button variant="ghost" size="sm" onClick={() => removeItem(it.materialId)}><Icon name="x" size={14} /></Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-end gap-2 border-t border-border-subtle bg-surface-2 px-3 py-2">
                <span className="text-[12px] text-text-tertiary">Total</span>
                <span className="text-[14px] font-bold text-text-primary">{cop(total)}</span>
              </div>
            </div>
          )}

          {/* Fecha + nota */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Fecha">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <Field label="Nota">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Motivo o comentario…" />
          </Field>

          <div className="mt-1 flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>Cancelar</Button>
            <Button variant="primary" onClick={submit} disabled={saving}>
              <Icon name="check" size={15} /> {saving ? "Guardando…" : "Crear devolución"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
