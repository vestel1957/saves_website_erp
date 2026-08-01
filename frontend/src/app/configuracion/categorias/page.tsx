"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/Modal";
import { Input, Field } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";

type Category = { id: string; name: string; usage: number };

export default function CategoriasPage() {
  const { authFetch } = useAuth();
  const [cats, setCats] = useState<Category[] | null>(null);
  const [editing, setEditing] = useState<Category | null>(null);
  const [draftName, setDraftName] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmar, setConfirmar] = useState<Category | null>(null);
  const [borrando, setBorrando] = useState(false);

  const load = useCallback(() => {
    void authFetch(`/config/categories`).then((r) => (r.ok ? r.json() : [])).then(setCats).catch(() => setCats([]));
  }, [authFetch]);
  useEffect(() => { load(); }, [load]);

  function openNew() { setEditing(null); setDraftName(""); setOpen(true); }
  function openEdit(c: Category) { setEditing(c); setDraftName(c.name); setOpen(true); }

  async function save() {
    const name = draftName.trim();
    if (name.length < 2) { toast("El nombre es muy corto", "alert-circle"); return; }
    setBusy(true);
    try {
      const body = JSON.stringify({ name });
      const res = editing
        ? await authFetch(`/config/categories/${editing.id}`, { method: "PATCH", body })
        : await authFetch(`/config/categories`, { method: "POST", body });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar");
      toast(editing ? "Categoría actualizada" : "Categoría creada", "check");
      setOpen(false);
      load();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: Category) {
    setBorrando(true);
    try {
      const res = await authFetch(`/config/categories/${c.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "No se pudo eliminar");
      toast("Categoría eliminada", "check");
      load();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setBorrando(false);
      setConfirmar(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeading
          icon="folder"
          title="Categorías de transacción"
          subtitle="Etiquetas para clasificar ingresos y egresos de tesorería. Solo se pueden eliminar las que no estén en uso."
        />
        <Button onClick={openNew}><Icon name="plus" size={15} /> Nueva categoría</Button>
      </div>

      <div className="space-y-2">
        {!cats ? (
          <p className="text-[13px] text-text-tertiary">Cargando…</p>
        ) : cats.length === 0 ? (
          <p className="text-[13px] text-text-tertiary">Aún no hay categorías. Crea la primera con “Nueva categoría”.</p>
        ) : cats.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface p-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand"><Icon name="folder" size={15} /></span>
              <span className="truncate text-[14px] font-semibold text-text-primary">{c.name}</span>
              <Badge tone={c.usage > 0 ? "info" : "default"} label={`${c.usage} mov.`} />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button type="button" onClick={() => openEdit(c)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" title="Editar">
                <Icon name="pencil" size={15} />
              </button>
              <button
                type="button"
                onClick={() => setConfirmar(c)}
                disabled={c.usage > 0}
                className="tap rounded-md p-1.5 text-text-tertiary enabled:hover:bg-error-soft enabled:hover:text-error-text disabled:cursor-not-allowed disabled:opacity-30"
                title={c.usage > 0 ? "En uso: no se puede eliminar" : "Eliminar"}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {open && (
        <Modal open onClose={() => setOpen(false)} title={editing ? "Editar categoría" : "Nueva categoría"}>
          <div className="flex flex-col gap-3">
            <Field label="Nombre">
              <Input autoFocus value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Servicios públicos" onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
            </Field>
            {editing && editing.usage > 0 && (
              <p className="text-[12px] text-text-tertiary">Al renombrar se actualizan las {editing.usage} transacción(es) que usan esta categoría.</p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>Cancelar</Button>
              <Button onClick={save} disabled={busy}>{busy ? "Guardando…" : "Guardar"}</Button>
            </div>
          </div>
        </Modal>
      )}

      {confirmar && (
        <ConfirmDialog
          open
          busy={borrando}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void remove(confirmar)}
          tone="danger"
          icon="trash"
          title="Eliminar categoría de transacción"
          confirmLabel="Eliminar categoría"
          message={
            <>
              La categoría desaparece del catálogo y dejará de estar disponible al registrar
              ingresos y egresos de tesorería. No se puede deshacer.
            </>
          }
          detail={<CategoriaResumen cat={confirmar} />}
        />
      )}
    </div>
  );
}

/** Ficha compacta de la categoría dentro de la confirmación. */
function CategoriaResumen({ cat }: { cat: Category }) {
  const filas: [string, React.ReactNode][] = [
    ["Nombre", cat.name],
    ["Movimientos", <Badge key="u" tone={cat.usage > 0 ? "info" : "default"} label={`${cat.usage} mov.`} />],
  ];
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-2 p-2.5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
        {filas.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-text-tertiary">{k}</dt>
            <dd className="text-right text-text-primary">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
