"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/Modal";
import { Input, Field } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";

type Category = { id: string; name: string; orders: number };

export default function CategoriasCompraPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [cats, setCats] = useState<Category[] | null>(null);
  const [err, setErr] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setErr(false);
    void authFetch(`/orders/categories`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then(setCats)
      .catch(() => setErr(true));
  }, [authFetch]);
  useEffect(() => { if (!authLoading) load(); }, [authLoading, load]);

  function openNew() { setEditing(null); setName(""); }
  function openEdit(c: Category) { setEditing(c); setName(c.name); }

  async function save() {
    if (name == null) return;
    if (!name.trim()) { toast("La categoría necesita un nombre", "alert-circle"); return; }
    setBusy(true);
    try {
      const body = JSON.stringify({ name: name.trim() });
      const res = editing
        ? await authFetch(`/orders/categories/${editing.id}`, { method: "PATCH", body })
        : await authFetch(`/orders/categories`, { method: "POST", body });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar");
      toast(editing ? "Categoría actualizada" : "Categoría creada", "check");
      setName(null); setEditing(null); load();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally { setBusy(false); }
  }

  async function remove(c: Category) {
    if (!confirm(`¿Eliminar la categoría de compra "${c.name}"?`)) return;
    try {
      const res = await authFetch(`/orders/categories/${c.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "No se pudo eliminar");
      toast("Categoría eliminada", "check");
      load();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <PageHeading
          icon="shopping-cart"
          title="Categorías de compra"
          subtitle="Clasifican las órdenes de compra (Compras, Nómina, Servicios…). No se pueden eliminar mientras alguna orden las use; al renombrar se actualizan las órdenes existentes."
        />
        <Button onClick={openNew}><Icon name="plus" size={15} /> Nueva categoría</Button>
      </div>

      {err && !cats ? (
        <LoadError message="No se pudieron cargar las categorías." onRetry={load} />
      ) : (
        <div className="space-y-2">
          {!cats ? (
            <p className="text-[13px] text-text-tertiary">Cargando…</p>
          ) : cats.length === 0 ? (
            <p className="text-[13px] text-text-tertiary">Aún no hay categorías. Crea la primera con “Nueva categoría”.</p>
          ) : cats.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface p-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate text-[14px] font-semibold text-text-primary">{c.name}</span>
                <Badge tone={c.orders > 0 ? "info" : "default"} label={`${c.orders} orden(es)`} />
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button type="button" onClick={() => openEdit(c)} className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" title="Editar">
                  <Icon name="pencil" size={15} />
                </button>
                <button type="button" onClick={() => remove(c)} className="rounded-md p-1.5 text-text-tertiary hover:bg-error-soft hover:text-error-text" title="Eliminar">
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {name != null && (
        <Modal open onClose={() => setName(null)} title={editing ? "Editar categoría de compra" : "Nueva categoría de compra"}>
          <div className="flex flex-col gap-3">
            <Field label="Nombre">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Compras" autoFocus />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setName(null)}>Cancelar</Button>
              <Button onClick={save} disabled={busy}>{busy ? "Guardando…" : "Guardar"}</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
