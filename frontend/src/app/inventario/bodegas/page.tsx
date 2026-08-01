"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input, Select, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { PagedTable } from "@/components/ui/PagedTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { esTecnico } from "@/lib/support";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

type Warehouse = {
  id: string; title: string; extra: string | null; technicianRef: string | null;
  managerId: string | null; managerName: string | null; materials: number; value: number;
};

type UserOption = { id: string; name: string; email: string | null };

export default function BodegasPage() {
  const router = useRouter();
  const { loading: authLoading, authFetch, user } = useAuth();
  // Al técnico el backend le devuelve UNA bodega, la suya, y de solo lectura: aquí
  // se le quitan los botones que igual le rechazaría `InventoryService`.
  const soloLoSuyo = esTecnico(user);
  const [rows, setRows] = useState<Warehouse[] | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [title, setTitle] = useState("");
  const [extra, setExtra] = useState("");
  const [managerId, setManagerId] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [delRow, setDelRow] = useState<Warehouse | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setRows(await (await authFetch("/inventory/warehouses")).json());
  }, [authFetch]);

  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);
  useEffect(() => {
    if (authLoading || soloLoSuyo) return;
    void (async () => {
      const us = await (await authFetch("/auth/users/options")).json().catch(() => []);
      setUsers(Array.isArray(us) ? us : []);
    })();
  }, [authLoading, authFetch, soloLoSuyo]);

  function openNew() { setEditing(null); setTitle(""); setExtra(""); setManagerId(""); setErr(null); setOpen(true); }
  function openEdit(w: Warehouse) {
    setEditing(w); setTitle(w.title); setExtra(w.extra ?? ""); setManagerId(w.managerId ?? ""); setErr(null); setOpen(true);
  }

  async function submit() {
    setErr(null);
    if (!title.trim()) { setErr("El nombre de la bodega es obligatorio."); return; }
    setSaving(true);
    try {
      // managerId siempre viaja (aunque sea ""): así se puede quitar el encargado.
      const body = JSON.stringify({ title: title.trim(), extra: extra.trim() || undefined, managerId });
      const res = editing
        ? await authFetch(`/inventory/warehouses/${editing.id}`, { method: "PATCH", body })
        : await authFetch("/inventory/warehouses", { method: "POST", body });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar la bodega");
      toast(editing ? "Bodega actualizada" : "Bodega creada", "check");
      setOpen(false); setEditing(null); setTitle(""); setExtra(""); setManagerId("");
      void load();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
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
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally { setDeleting(false); }
  }

  // Filtro en cliente por nombre/referencia sobre lo ya cargado.
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !rows) return rows ?? [];
    return rows.filter((w) => [w.title, w.extra, w.technicianRef].some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [rows, search]);

  if (authLoading || !rows) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading
          icon="warehouse"
          title={soloLoSuyo ? "Mi bodega de material" : "Bodegas de material"}
          subtitle={soloLoSuyo ? "El material que tienes a tu cargo" : "Almacenes de inventario"}
        />
        {!soloLoSuyo && (
          <div className="flex items-center gap-2">
            <Link href="/inventario" className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
              <Icon name="package" size={14} /> Material
            </Link>
            <Button size="sm" onClick={openNew}><Icon name="plus" size={14} /> Nueva bodega</Button>
          </div>
        )}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? "Editar bodega" : "Nueva bodega"} maxWidth="max-w-md">
        <div className="flex flex-col gap-3">
          <Field label="Nombre" required><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bodega central" autoFocus /></Field>
          <Field label="Referencia / nota"><Input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Opcional" /></Field>
          <Field
            label="Encargado"
            hint={
              editing?.technicianRef
                ? "Es el almacén de un técnico: recibe él, no hace falta encargado."
                : "Es quien recibe y firma los traspasos que entran a esta bodega."
            }
          >
            <Select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
              <option value="">Sin encargado…</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}{u.email ? ` · ${u.email}` : ""}</option>)}
            </Select>
          </Field>
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

      {!soloLoSuyo && <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar bodega…" />}

      <PagedTable
        rows={shown}
        empty={
          soloLoSuyo
            ? "No tienes una bodega de material a tu nombre. Pídele a administración que te asigne una."
            : search ? "Ninguna bodega coincide con la búsqueda." : "No hay bodegas registradas."
        }
        onRowClick={(r: Warehouse) => router.push(`/inventario/bodegas/${r.id}`)}
        columns={[
          { key: "title", header: "Bodega", render: (r: Warehouse) => <span className="font-medium text-text-primary">{r.title}</span> },
          { key: "extra", header: "Referencia", render: (r: Warehouse) => <span className="text-text-tertiary">{r.extra || "—"}</span> },
          {
            key: "manager", header: "Encargado",
            // En la bodega de un técnico recibe él; ahí el encargado no aplica.
            render: (r: Warehouse) => r.technicianRef
              ? <span className="inline-flex items-center gap-1 text-text-tertiary"><Icon name="user" size={12} /> Técnico</span>
              : r.managerName
                ? <span className="text-text-secondary">{r.managerName}</span>
                : <span className="text-warning-text">Sin asignar</span>,
          },
          { key: "materials", header: "Materiales", align: "right", render: (r: Warehouse) => <Badge label={String(r.materials)} tone={r.materials > 0 ? "info" : "default"} /> },
          { key: "value", header: "Valor", align: "right", render: (r: Warehouse) => <span className="font-semibold text-text-primary">{cop(r.value ?? 0)}</span> },
          ...(soloLoSuyo ? [] : [{
            key: "acciones", header: "" as const, align: "right" as const,
            // stopPropagation: la fila navega al detalle con onRowClick.
            render: (r: Warehouse) => (
              <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                <button type="button" onClick={() => openEdit(r)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" title="Editar">
                  <Icon name="pencil" size={15} />
                </button>
                <button type="button" onClick={() => setDelRow(r)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-error-soft hover:text-error-text" title="Eliminar">
                  <Icon name="trash" size={15} />
                </button>
              </div>
            ),
          }]),
        ]}
      />
    </>
  );
}
