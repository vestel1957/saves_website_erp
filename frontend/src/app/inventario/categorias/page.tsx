"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/Modal";
import { Input, Field } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";

type Category = { id: string; title: string; extra: string | null; materials: number; value: number };
type Draft = { title: string; extra: string };

const EMPTY: Draft = { title: "", extra: "" };

export default function CategoriasMaterialPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [cats, setCats] = useState<Category[] | null>(null);
  const [err, setErr] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmar, setConfirmar] = useState<Category | null>(null);
  const [borrando, setBorrando] = useState(false);

  const load = useCallback(() => {
    setErr(false);
    void authFetch(`/inventory/categories`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then(setCats)
      .catch(() => setErr(true));
  }, [authFetch]);
  useEffect(() => { if (!authLoading) load(); }, [authLoading, load]);

  function openNew() { setEditing(null); setDraft({ ...EMPTY }); }
  function openEdit(c: Category) { setEditing(c); setDraft({ title: c.title, extra: c.extra ?? "" }); }

  async function save() {
    if (!draft) return;
    if (!draft.title.trim()) { toast("La categoría necesita un nombre", "alert-circle"); return; }
    setBusy(true);
    try {
      const body = JSON.stringify({ title: draft.title.trim(), extra: draft.extra.trim() || undefined });
      const res = editing
        ? await authFetch(`/inventory/categories/${editing.id}`, { method: "PATCH", body })
        : await authFetch(`/inventory/categories`, { method: "POST", body });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar");
      toast(editing ? "Categoría actualizada" : "Categoría creada", "check");
      setDraft(null); setEditing(null); load();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally { setBusy(false); }
  }

  async function remove(c: Category) {
    setBorrando(true);
    try {
      const res = await authFetch(`/inventory/categories/${c.id}`, { method: "DELETE" });
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
          icon="boxes"
          title="Categorías de material"
          subtitle="Organiza el inventario. Una categoría no se puede eliminar mientras tenga materiales asociados."
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
              <Link
                href={`/inventario/categorias/${c.id}`}
                className="group -m-1 min-w-0 flex-1 rounded-lg p-1 transition-colors hover:bg-surface-2"
                title="Ver los materiales de esta categoría"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[14px] font-semibold text-text-primary group-hover:text-brand">{c.title}</span>
                  <Badge tone={c.materials > 0 ? "info" : "default"} label={`${c.materials} material(es)`} />
                  {c.value > 0 && <Badge tone="default" label={cop(c.value)} />}
                  {/* En táctil no hay hover: el chevron es la única pista de que
                      la fila se abre, así que en móvil se deja visible. */}
                  <Icon name="chevron-right" size={14} className="shrink-0 text-brand transition-opacity sm:opacity-0 sm:group-hover:opacity-100" />
                </div>
                {c.extra && <div className="mt-0.5 text-[12px] text-text-tertiary">{c.extra}</div>}
              </Link>
              <div className="flex shrink-0 items-center gap-1">
                <button type="button" onClick={() => openEdit(c)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" title="Editar">
                  <Icon name="pencil" size={15} />
                </button>
                <button type="button" onClick={() => setConfirmar(c)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-error-soft hover:text-error-text" title="Eliminar">
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <Modal open onClose={() => setDraft(null)} title={editing ? "Editar categoría" : "Nueva categoría"}>
          <div className="flex flex-col gap-3">
            <Field label="Nombre">
              <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="CONSUMIBLES" autoFocus />
            </Field>
            <Field label="Nota / detalle" hint="Opcional">
              <Input value={draft.extra} onChange={(e) => setDraft({ ...draft, extra: e.target.value })} placeholder="Descripción de la categoría" />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDraft(null)}>Cancelar</Button>
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
          title="Eliminar categoría de material"
          confirmLabel="Eliminar categoría"
          message={
            confirmar.materials > 0 ? (
              <>
                Esta categoría todavía agrupa <b>{confirmar.materials} material(es)</b> del inventario,
                así que el sistema rechazará el borrado. Muévelos a otra categoría antes de eliminarla.
              </>
            ) : (
              <>
                La categoría desaparece del catálogo y dejará de estar disponible al clasificar
                materiales. No se puede deshacer.
              </>
            )
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
    ["Nombre", cat.title],
    ["Materiales", <Badge key="m" tone={cat.materials > 0 ? "info" : "default"} label={`${cat.materials} material(es)`} />],
    ["Valor en stock", <span key="v" className="font-mono">{cop(cat.value)}</span>],
    ...(cat.extra ? ([["Nota", cat.extra]] as [string, React.ReactNode][]) : []),
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
