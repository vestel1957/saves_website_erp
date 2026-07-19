"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/inventory/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";

type Warehouse = { id: string; title: string; extra: string | null; technicianRef: string | null; materials: number; value: number };

export default function BodegasPage() {
  const router = useRouter();
  const { loading: authLoading, authFetch } = useAuth();
  const [rows, setRows] = useState<Warehouse[] | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [title, setTitle] = useState("");
  const [extra, setExtra] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [delRow, setDelRow] = useState<Warehouse | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setRows(await (await authFetch("/inventory/warehouses")).json());
  }, [authFetch]);

  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  function openNew() { setEditing(null); setTitle(""); setExtra(""); setErr(null); setOpen(true); }
  function openEdit(w: Warehouse) { setEditing(w); setTitle(w.title); setExtra(w.extra ?? ""); setErr(null); setOpen(true); }

  async function submit() {
    setErr(null);
    if (!title.trim()) { setErr("El nombre de la bodega es obligatorio."); return; }
    setSaving(true);
    try {
      const body = JSON.stringify({ title: title.trim(), extra: extra.trim() || undefined });
      const res = editing
        ? await authFetch(`/inventory/warehouses/${editing.id}`, { method: "PATCH", body })
        : await authFetch("/inventory/warehouses", { method: "POST", body });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar la bodega");
      toast(editing ? "Bodega actualizada" : "Bodega creada", "check");
      setOpen(false); setEditing(null); setTitle(""); setExtra("");
      void load();
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  }

  async function remove() {
    if (!delRow) return;
    setDeleting(true);
    try {
      const res = await authFetch(`/inventory/warehouses/${delRow.id}`, { method: "DELETE" });
      const d = await res.json().catch(() => null);
      // El backend rechaza el borrado si la bodega aún tiene material.
      if (!res.ok) throw new Error(d?.message || "No se pudo eliminar la bodega");
      toast("Bodega eliminada", "check");
      setDelRow(null);
      void load();
    } catch (e: any) {
      toast(e.message, "alert-triangle");
    } finally { setDeleting(false); }
  }

  if (authLoading || !rows) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <PageHeading icon="warehouse" title="Bodegas de material" subtitle="Almacenes de inventario" />
        <div className="flex items-center gap-2">
          <Link href="/inventario" className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
            <Icon name="package" size={14} /> Material
          </Link>
          <Button size="sm" onClick={openNew}><Icon name="plus" size={14} /> Nueva bodega</Button>
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? "Editar bodega" : "Nueva bodega"} maxWidth="max-w-md">
        <div className="flex flex-col gap-3">
          <Field label="Nombre" required><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bodega central" autoFocus /></Field>
          <Field label="Referencia / nota"><Input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Opcional" /></Field>
          {err && <p className="text-[12px] text-error-text">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>Cancelar</Button>
            <Button onClick={submit} disabled={saving}>{saving ? "Guardando…" : editing ? "Guardar cambios" : "Crear"}</Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(delRow)}
        title="Eliminar bodega"
        message={<>¿Seguro que quieres eliminar la bodega <strong>{delRow?.title}</strong>? Solo es posible si no tiene material asociado.</>}
        confirmLabel="Eliminar"
        busy={deleting}
        onConfirm={remove}
        onClose={() => setDelRow(null)}
      />

      <DataTable
        autoHeight
        rows={rows}
        empty="No hay bodegas registradas."
        onRowClick={(r: Warehouse) => router.push(`/inventario/bodegas/${r.id}`)}
        columns={[
          { key: "title", header: "Bodega", render: (r: Warehouse) => <span className="font-medium text-text-primary">{r.title}</span> },
          { key: "extra", header: "Referencia", render: (r: Warehouse) => <span className="text-text-tertiary">{r.extra || "—"}</span> },
          { key: "materials", header: "Materiales", align: "right", render: (r: Warehouse) => <Badge label={String(r.materials)} tone={r.materials > 0 ? "info" : "default"} /> },
          { key: "value", header: "Valor", align: "right", render: (r: Warehouse) => <span className="font-semibold text-text-primary">{cop(r.value ?? 0)}</span> },
          {
            key: "acciones", header: "", align: "right",
            // stopPropagation: la fila navega al detalle con onRowClick.
            render: (r: Warehouse) => (
              <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                <button type="button" onClick={() => openEdit(r)} className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" title="Editar">
                  <Icon name="pencil" size={15} />
                </button>
                <button type="button" onClick={() => setDelRow(r)} className="rounded-md p-1.5 text-text-tertiary hover:bg-error-soft hover:text-error-text" title="Eliminar">
                  <Icon name="trash" size={15} />
                </button>
              </div>
            ),
          },
        ]}
      />
    </>
  );
}
