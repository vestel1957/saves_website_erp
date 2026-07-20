"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Textarea, Select, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

type Row = { product: string; qty: string; price: string; taxRate: string };

const emptyRow = (): Row => ({ product: "", qty: "1", price: "0", taxRate: "0" });

export default function NuevaOrdenPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const router = useRouter();

  const [search, setSearch] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [supplier, setSupplier] = useState<any>(null);

  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [orderDate, setOrderDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [category, setCategory] = useState("");
  const [cats, setCats] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);

  const searchSuppliers = useCallback(async (q: string) => {
    setSearching(true);
    try {
      const qs = new URLSearchParams({ search: q, pageSize: "8" });
      const res = await authFetch(`/orders/suppliers?${qs.toString()}`);
      const d = await res.json();
      setResults(d?.items ?? []);
    } finally { setSearching(false); }
  }, [authFetch]);

  useEffect(() => {
    if (authLoading || supplier) return;
    const q = search.trim();
    if (!q) { setResults([]); return; }
    const t = setTimeout(() => void searchSuppliers(q), 300);
    return () => clearTimeout(t);
  }, [authLoading, supplier, search, searchSuppliers]);

  useEffect(() => {
    if (authLoading) return;
    void authFetch(`/orders/categories`).then((r) => (r.ok ? r.json() : [])).then(setCats).catch(() => setCats([]));
  }, [authLoading, authFetch]);

  const totals = useMemo(() => {
    let subtotal = 0, tax = 0;
    for (const r of rows) {
      const qty = Number(r.qty) || 0;
      const price = Number(r.price) || 0;
      const rate = Number(r.taxRate) || 0;
      const line = qty * price;
      subtotal += line;
      tax += line * (rate / 100);
    }
    return { subtotal, tax, total: subtotal + tax };
  }, [rows]);

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((prev) => [...prev, emptyRow()]);
  const removeRow = (i: number) => setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  const create = async () => {
    if (!supplier) { toast("Selecciona un proveedor", "alert-triangle"); return; }
    const items = rows
      .filter((r) => r.product.trim() && Number(r.qty) > 0)
      .map((r) => ({ product: r.product.trim(), qty: Number(r.qty), price: Number(r.price) || 0, taxRate: Number(r.taxRate) || 0 }));
    if (!items.length) { toast("Agrega al menos un ítem", "alert-triangle"); return; }
    setSaving(true);
    try {
      const res = await authFetch("/orders", {
        method: "POST",
        body: JSON.stringify({ supplierId: supplier.id, orderDate, categoryRef: category || undefined, notes: notes.trim() || undefined, items }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast("Orden creada");
      router.push("/ordenes/" + d.id);
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo crear la orden"), "alert-triangle");
    } finally { setSaving(false); }
  };

  if (authLoading) return <PageSkeleton />;

  const isCompra = supplier?.category === 1;

  return (
    <>
      <PageHeading icon="receipt" title="Nueva orden" subtitle="Compra o servicio a proveedor" />

      <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <h2 className="mb-3 text-[13px] font-bold text-text-primary">Proveedor</h2>
        {supplier ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-default bg-surface-2 px-4 py-3">
            <div className="flex flex-col leading-tight">
              <span className="flex items-center gap-2 text-[14px] font-bold text-text-primary">
                {supplier.name}
                <Badge label={isCompra ? "Compra" : "Servicio"} tone={isCompra ? "brand" : "info"} />
              </span>
              <span className="text-[12px] text-text-tertiary">NIT {supplier.nit ?? "—"}{supplier.city ? ` · ${supplier.city}` : ""}</span>
            </div>
            <Button variant="secondary" size="sm" onClick={() => { setSupplier(null); setSearch(""); setResults([]); }}>
              <Icon name="x" size={14} /> Cambiar
            </Button>
          </div>
        ) : (
          <div className="relative">
            <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <Input className="pl-9" placeholder="Buscar proveedor por nombre o NIT…" value={search} onChange={(e) => setSearch(e.target.value)} />
            {search.trim() && (
              <div className="mt-2 overflow-hidden rounded-lg border border-border-default">
                {searching && !results.length ? (
                  <div className="px-4 py-3 text-[12px] text-text-tertiary">Buscando…</div>
                ) : results.length ? (
                  results.map((s: any) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => { setSupplier(s); setResults([]); }}
                      className="flex w-full items-center justify-between gap-3 border-b border-border-subtle px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-surface-2"
                    >
                      <span className="flex flex-col leading-tight">
                        <span className="text-[13px] font-semibold text-text-primary">{s.name}</span>
                        <span className="text-[11px] text-text-tertiary">NIT {s.nit ?? "—"}{s.city ? ` · ${s.city}` : ""}</span>
                      </span>
                      <Badge label={s.category === 1 ? "Compra" : "Servicio"} tone={s.category === 1 ? "brand" : "info"} />
                    </button>
                  ))
                ) : (
                  <div className="px-4 py-3 text-[12px] text-text-tertiary">Sin resultados.</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-bold text-text-primary">Ítems</h2>
          <Button variant="secondary" size="sm" onClick={addRow}><Icon name="plus" size={14} /> Agregar ítem</Button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase text-text-tertiary">
                <th className="pb-2 pr-2">Descripción</th>
                <th className="pb-2 px-2 text-right">Cant.</th>
                <th className="pb-2 px-2 text-right">Precio</th>
                <th className="pb-2 px-2 text-right">IVA %</th>
                <th className="pb-2 pl-2 text-right">Subtotal</th>
                <th className="pb-2 pl-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const line = (Number(r.qty) || 0) * (Number(r.price) || 0);
                return (
                  <tr key={i} className="border-t border-border-subtle">
                    <td className="py-2 pr-2"><Input value={r.product} onChange={(e) => setRow(i, { product: e.target.value })} placeholder="Descripción del ítem" /></td>
                    <td className="py-2 px-2"><Input type="number" min={0} className="w-20 text-right" value={r.qty} onChange={(e) => setRow(i, { qty: e.target.value })} /></td>
                    <td className="py-2 px-2"><Input type="number" min={0} className="w-28 text-right" value={r.price} onChange={(e) => setRow(i, { price: e.target.value })} /></td>
                    <td className="py-2 px-2"><Input type="number" min={0} className="w-20 text-right" value={r.taxRate} onChange={(e) => setRow(i, { taxRate: e.target.value })} /></td>
                    <td className="py-2 pl-2 text-right font-medium text-text-secondary">{cop(line)}</td>
                    <td className="py-2 pl-2 text-right">
                      <button type="button" onClick={() => removeRow(i)} className="text-text-tertiary transition-colors hover:text-error-text" aria-label="Quitar">
                        <Icon name="x" size={16} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-col items-end gap-1 border-t border-border-subtle pt-3 text-[13px]">
          <div className="flex w-64 justify-between text-text-secondary"><span>Subtotal</span><span>{cop(totals.subtotal)}</span></div>
          <div className="flex w-64 justify-between text-text-secondary"><span>IVA</span><span>{cop(totals.tax)}</span></div>
          <div className="flex w-64 justify-between text-[15px] font-bold text-text-primary"><span>Total</span><span>{cop(totals.total)}</span></div>
        </div>
      </div>

      <div className="grid gap-4 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm sm:grid-cols-2">
        <Field label="Fecha de la orden">
          <Input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
        </Field>
        <Field label="Categoría de compra" hint="Opcional · se gestionan en Categorías de compra">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Sin categoría</option>
            {cats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Nota">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Observaciones (opcional)" />
        </Field>
      </div>

      <div className="flex justify-end gap-2">
        <Link href="/ordenes"><Button variant="secondary">Cancelar</Button></Link>
        <Button variant="primary" onClick={create} disabled={saving}>
          <Icon name="check" size={15} /> {saving ? "Creando…" : "Crear orden"}
        </Button>
      </div>
    </>
  );
}
