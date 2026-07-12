"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";

export type OrderFilters = {
  status: string;
  category: string;
  branch: string;
  supplier: string;
  minTotal: string;
  maxTotal: string;
  from: string;
  to: string;
};

export const EMPTY_FILTERS: OrderFilters = { status: "", category: "", branch: "", supplier: "", minTotal: "", maxTotal: "", from: "", to: "" };

/** Nº de filtros activos (cada rango cuenta como uno). */
export function countActiveFilters(f: OrderFilters): number {
  let n = 0;
  if (f.status) n++;
  if (f.category) n++;
  if (f.branch) n++;
  if (f.supplier) n++;
  if (f.minTotal || f.maxTotal) n++;
  if (f.from || f.to) n++;
  return n;
}

const STATUSES = ["pendiente", "aprobado", "recibido parcial", "recibido", "finalizado", "cancelado", "anulado"];

export function OrdersFilterButton({
  value,
  onChange,
  categories,
  branches,
}: {
  value: OrderFilters;
  onChange: (f: OrderFilters) => void;
  categories: { id: string; name: string }[];
  branches: { name: string }[];
}) {
  const { authFetch } = useAuth();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<OrderFilters>(value);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[] | null>(null);

  const active = countActiveFilters(value);

  // Al abrir: sincroniza el borrador y carga proveedores una sola vez (perezoso).
  useEffect(() => {
    if (!open) return;
    setDraft(value);
    if (suppliers === null) {
      void authFetch("/orders/suppliers?pageSize=500")
        .then((r) => r.json())
        .then((d) => setSuppliers(Array.isArray(d?.items) ? d.items.map((s: any) => ({ id: s.id, name: s.name })) : []))
        .catch(() => setSuppliers([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (patch: Partial<OrderFilters>) => setDraft((d) => ({ ...d, ...patch }));

  function apply() { onChange(draft); setOpen(false); }
  function clearAll() { setDraft(EMPTY_FILTERS); onChange(EMPTY_FILTERS); setOpen(false); }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors ${
          active > 0
            ? "border-brand bg-brand-soft text-brand"
            : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"
        }`}
      >
        <Icon name="sliders-horizontal" size={15} />
        Filtros
        {active > 0 && (
          <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-on-brand">
            {active}
          </span>
        )}
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Filtros de órdenes">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Estado">
            <Select value={draft.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">Todos los estados</option>
              {STATUSES.map((s) => <option key={s} value={s} className="capitalize">{s}</option>)}
            </Select>
          </Field>
          <Field label="Categoría">
            <Select value={draft.category} onChange={(e) => set({ category: e.target.value })}>
              <option value="">Todas las categorías</option>
              {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Sede">
            <Select value={draft.branch} onChange={(e) => set({ branch: e.target.value })}>
              <option value="">Todas las sedes</option>
              {branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
            </Select>
          </Field>
          <Field label="Proveedor" hint={suppliers === null ? "Cargando…" : undefined}>
            <Select value={draft.supplier} onChange={(e) => set({ supplier: e.target.value })} disabled={suppliers === null}>
              <option value="">Todos los proveedores</option>
              {(suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Monto desde">
              <Input type="number" min="0" inputMode="numeric" placeholder="0" value={draft.minTotal} onChange={(e) => set({ minTotal: e.target.value })} />
            </Field>
            <Field label="Monto hasta">
              <Input type="number" min="0" inputMode="numeric" placeholder="Sin tope" value={draft.maxTotal} onChange={(e) => set({ maxTotal: e.target.value })} />
            </Field>
          </div>
          <Field label="Fecha desde">
            <Input type="date" value={draft.from} onChange={(e) => set({ from: e.target.value })} />
          </Field>
          <Field label="Fecha hasta">
            <Input type="date" value={draft.to} onChange={(e) => set({ to: e.target.value })} />
          </Field>
        </div>

        <div className="mt-1 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={clearAll}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-[13px] font-medium text-text-secondary hover:bg-surface-2"
          >
            <Icon name="x" size={14} /> Limpiar
          </button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button onClick={apply}>Aplicar filtros</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
