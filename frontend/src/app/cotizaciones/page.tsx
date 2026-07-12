"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/inventory/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";

type QuoteItem = { product: string; qty: number; price: number; taxRate: number };

const statusTone = (s: string): "default" | "success" | "warning" | "info" | "error" | "brand" => {
  const v = (s || "").toLowerCase();
  if (v.includes("aprob") || v.includes("acept")) return "success";
  if (v.includes("rechaz") || v.includes("anul")) return "error";
  if (v.includes("envi") || v.includes("pend")) return "warning";
  return "default";
};

export default function CotizacionesPage() {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = `/omni/quotes?search=${encodeURIComponent(search)}&page=${page}&pageSize=${pageSize}`;
      const d: any = await (await authFetch(url)).json();
      setRows(d.items ?? []);
      setTotal(d.total ?? 0);
      setPages(d.pages ?? 1);
    } finally {
      setLoading(false);
    }
  }, [authFetch, search, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Modal nueva cotización ────────────────────────────────────────────────
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sub, setSub] = useState<PickedSub | null>(null);
  const [notes, setNotes] = useState("");
  const [proposal, setProposal] = useState("");
  const [items, setItems] = useState<QuoteItem[]>([{ product: "", qty: 1, price: 0, taxRate: 19 }]);

  const resetForm = () => {
    setSub(null);
    setNotes("");
    setProposal("");
    setItems([{ product: "", qty: 1, price: 0, taxRate: 19 }]);
  };

  const setItem = (i: number, patch: Partial<QuoteItem>) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const addItem = () => setItems((prev) => [...prev, { product: "", qty: 1, price: 0, taxRate: 19 }]);
  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));

  const liveTotal = useMemo(
    () =>
      items.reduce((acc, it) => {
        const base = (it.qty || 0) * (it.price || 0);
        return acc + base + (base * (it.taxRate || 0)) / 100;
      }, 0),
    [items],
  );

  const submit = async () => {
    const valid = items.filter((it) => it.product.trim() && it.qty > 0);
    if (!valid.length) {
      toast("Agrega al menos un ítem con producto y cantidad", "alert-triangle");
      return;
    }
    setSaving(true);
    try {
      const body = {
        subscriberId: sub?.id,
        notes: notes.trim() || undefined,
        proposal: proposal.trim() || undefined,
        items: valid.map((it) => ({
          product: it.product.trim(),
          qty: Number(it.qty),
          price: Number(it.price),
          taxRate: Number(it.taxRate),
        })),
      };
      const res = await authFetch("/omni/quotes", { method: "POST", body: JSON.stringify(body) });
      const d: any = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast("Cotización creada", "check");
      setOpen(false);
      resetForm();
      await load();
    } catch (e: any) {
      toast(e?.message || "Error al crear la cotización", "alert-triangle");
    } finally {
      setSaving(false);
    }
  };

  const columns = [
    {
      key: "tid",
      header: "Cotización",
      render: (r: any) => <span className="font-mono text-[12px] font-semibold text-text-primary">{r.tid}</span>,
    },
    { key: "client", header: "Cliente", render: (r: any) => r.client || "—" },
    {
      key: "date",
      header: "Fecha",
      render: (r: any) =>
        r.date ? new Date(r.date).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" }) : "—",
    },
    { key: "total", header: "Total", align: "right" as const, render: (r: any) => cop(Number(r.total || 0)) },
    { key: "status", header: "Estado", render: (r: any) => <Badge label={r.status || "—"} tone={statusTone(r.status)} /> },
    {
      key: "itemsCount",
      header: "Ítems",
      align: "center" as const,
      render: (r: any) => <span className="text-text-secondary">{r.itemsCount ?? 0}</span>,
    },
  ];

  if (loading && rows.length === 0) return <PageSkeleton />;

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="receipt" title="Cotizaciones" />
        <div className="flex items-center gap-2">
          <Link href="/ordenes" className="hidden sm:block">
            <Button variant="ghost" size="sm">
              <Icon name="arrow-left" size={14} /> Órdenes
            </Button>
          </Link>
          <Button onClick={() => setOpen(true)}>
            <Icon name="plus" size={15} /> Nueva cotización
          </Button>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          void load();
        }}
        className="flex items-center gap-2"
      >
        <div className="relative flex-1">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input
            className="pl-9"
            placeholder="Buscar por cliente o número…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary">
          <Icon name="search" size={14} /> Buscar
        </Button>
      </form>

      <DataTable columns={columns} rows={rows} empty="Aún no hay cotizaciones" />

      {total > 0 && (
        <Pagination
          meta={{ page, pageSize, total, pageCount: pages }}
          onPage={setPage}
          onPageSize={(s) => {
            setPageSize(s);
            setPage(1);
          }}
        />
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Nueva cotización" maxWidth="max-w-2xl">
        <div className="flex flex-col gap-4">
          <Field label="Cliente" hint="Opcional">
            <SubscriberPicker value={sub} onChange={setSub} />
          </Field>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Ítems</span>
              <Button variant="ghost" size="sm" onClick={addItem}>
                <Icon name="plus" size={13} /> Agregar ítem
              </Button>
            </div>

            <div className="hidden grid-cols-[1fr_70px_110px_80px_36px] gap-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary sm:grid">
              <span>Producto</span>
              <span className="text-right">Cant.</span>
              <span className="text-right">Precio</span>
              <span className="text-right">IVA %</span>
              <span />
            </div>

            {items.map((it, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_70px_110px_80px_36px]">
                <Input
                  className="col-span-2 sm:col-span-1"
                  placeholder="Producto / descripción"
                  value={it.product}
                  onChange={(e) => setItem(i, { product: e.target.value })}
                />
                <Input
                  type="number"
                  min={0}
                  className="text-right"
                  placeholder="Cant."
                  value={it.qty}
                  onChange={(e) => setItem(i, { qty: Number(e.target.value) })}
                />
                <Input
                  type="number"
                  min={0}
                  className="text-right"
                  placeholder="Precio"
                  value={it.price}
                  onChange={(e) => setItem(i, { price: Number(e.target.value) })}
                />
                <Input
                  type="number"
                  min={0}
                  className="text-right"
                  placeholder="IVA"
                  value={it.taxRate}
                  onChange={(e) => setItem(i, { taxRate: Number(e.target.value) })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-center px-0"
                  onClick={() => removeItem(i)}
                  disabled={items.length <= 1}
                  aria-label="Quitar ítem"
                >
                  <Icon name="x" size={14} />
                </Button>
              </div>
            ))}

            <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-surface-2 px-3 py-2">
              <span className="flex items-center gap-1.5 text-[12px] font-semibold text-text-secondary">
                <Icon name="dollar-sign" size={14} className="text-brand" /> Total (con IVA)
              </span>
              <span className="text-[15px] font-bold text-text-primary">{cop(liveTotal)}</span>
            </div>
          </div>

          <Field label="Nota">
            <Input placeholder="Nota interna (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>

          <Field label="Propuesta">
            <Textarea
              rows={4}
              placeholder="Texto de la propuesta para el cliente (opcional)"
              value={proposal}
              onChange={(e) => setProposal(e.target.value)}
            />
          </Field>

          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={submit} disabled={saving}>
              <Icon name="check" size={15} /> {saving ? "Guardando…" : "Crear cotización"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
