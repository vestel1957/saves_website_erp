"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/Modal";
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
  const [title, setTitle] = useState("");
  const [extra, setExtra] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(await (await authFetch("/inventory/warehouses")).json());
  }, [authFetch]);

  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  async function submit() {
    setErr(null);
    if (!title.trim()) { setErr("El nombre de la bodega es obligatorio."); return; }
    setSaving(true);
    try {
      const res = await authFetch("/inventory/warehouses", { method: "POST", body: JSON.stringify({ title: title.trim(), extra: extra.trim() || undefined }) });
      if (!res.ok) throw new Error((await res.json())?.message || "No se pudo crear la bodega");
      toast("Bodega creada", "check");
      setOpen(false); setTitle(""); setExtra("");
      void load();
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
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
          <Button size="sm" onClick={() => setOpen(true)}><Icon name="plus" size={14} /> Nueva bodega</Button>
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="Nueva bodega" maxWidth="max-w-md">
        <div className="flex flex-col gap-3">
          <Field label="Nombre" required><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bodega central" autoFocus /></Field>
          <Field label="Referencia / nota"><Input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Opcional" /></Field>
          {err && <p className="text-[12px] text-error-text">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>Cancelar</Button>
            <Button onClick={submit} disabled={saving}>{saving ? "Guardando…" : "Crear"}</Button>
          </div>
        </div>
      </Modal>

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
        ]}
      />
    </>
  );
}
