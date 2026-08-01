"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Combobox, type ComboItem } from "@/components/ui/Combobox";
import { Modal } from "@/components/Modal";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";

type Holder = {
  id: string;
  userId: string;
  name: string;
  email: string;
  isPrimary: boolean;
  notifyWhatsapp: boolean;
  /** Pidió WhatsApp pero el usuario no tiene teléfono registrado. */
  missingPhone: boolean;
  /** Nombrado y luego desactivado: sigue en la casilla pero no recibe nada. */
  inactive: boolean;
};

type Post = {
  slug: string;
  label: string;
  group: string;
  purpose: string;
  alerts: string[];
  hasFallback: boolean;
  holders: Holder[];
};

type Grupo = { group: string; posts: Post[] };
type Data = { groups: Grupo[]; vacantes: number };
type Assignable = { id: string; name: string; email: string; hasPhone: boolean };

/** Fila en edición dentro del modal. */
type Draft = { userId: string; isPrimary: boolean; notifyWhatsapp: boolean };

/* -------------------------------------------------------------------------- */
/* Modal: definir los encargados de un cargo                                  */
/* -------------------------------------------------------------------------- */

function EncargadosModal({
  post,
  users,
  onClose,
  onSaved,
}: {
  post: Post;
  users: Assignable[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { authFetch } = useAuth();
  const [draft, setDraft] = useState<Draft[]>(
    post.holders.map((h) => ({ userId: h.userId, isPrimary: h.isPrimary, notifyWhatsapp: h.notifyWhatsapp })),
  );
  const [pick, setPick] = useState("");
  const [saving, setSaving] = useState(false);

  const byId = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  // Del selector desaparece quien ya está en la lista: volver a elegirlo no hace nada.
  const items: ComboItem[] = useMemo(
    () =>
      users
        .filter((u) => !draft.some((d) => d.userId === u.id))
        .map((u) => ({
          value: u.id,
          label: u.name,
          sublabel: u.hasPhone ? u.email : `${u.email} · sin WhatsApp`,
          keywords: u.email,
        })),
    [users, draft],
  );

  const agregar = (userId: string) => {
    if (!userId) return;
    setDraft((d) => [
      ...d,
      // El primero en entrar queda titular: un cargo con gente pero sin titular es
      // justo la ambigüedad que esta pantalla viene a quitar.
      { userId, isPrimary: d.length === 0, notifyWhatsapp: false },
    ]);
    setPick("");
  };

  const quitar = (userId: string) =>
    setDraft((d) => {
      const resto = d.filter((x) => x.userId !== userId);
      // Si se fue el titular, el siguiente asume: el cargo no se queda acéfalo.
      if (resto.length && !resto.some((x) => x.isPrimary)) resto[0] = { ...resto[0], isPrimary: true };
      return resto;
    });

  const hacerTitular = (userId: string) =>
    setDraft((d) => d.map((x) => ({ ...x, isPrimary: x.userId === userId })));

  const alternarWhatsapp = (userId: string) =>
    setDraft((d) => d.map((x) => (x.userId === userId ? { ...x, notifyWhatsapp: !x.notifyWhatsapp } : x)));

  const guardar = async () => {
    setSaving(true);
    try {
      const res = await authFetch(`/responsibilities/${post.slug}`, {
        method: "PUT",
        body: JSON.stringify({ holders: draft }),
      });
      const d: any = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(draft.length ? "Encargados actualizados" : "El cargo quedó sin encargado");
      onSaved();
      onClose();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo guardar"), "x");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Encargados de ${post.label}`}>
      <div className="flex flex-col gap-4">
        <p className="text-[12px] text-text-tertiary">{post.purpose}</p>

        <div>
          <div className="mb-1.5 text-[12px] font-semibold text-text-secondary">Agregar persona</div>
          <Combobox
            items={items}
            value={pick}
            onChange={agregar}
            placeholder="Buscar por nombre o correo…"
            emptyText="Sin coincidencias entre los usuarios activos."
          />
        </div>

        {draft.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-default bg-surface-2 p-4 text-center text-[12px] text-text-tertiary">
            Nadie asignado.
            {post.hasFallback
              ? " Mientras esté así, los avisos seguirán saliendo a todo el que tenga el permiso del área."
              : " Mientras esté así, estos avisos no le llegarán a nadie."}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {draft.map((d) => {
              const u = byId.get(d.userId);
              const sinTelefono = !u?.hasPhone;
              return (
                <li
                  key={d.userId}
                  className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-semibold text-text-primary">{u?.name ?? "—"}</span>
                      {d.isPrimary && <Badge label="Titular" tone="info" />}
                    </div>
                    <div className="truncate text-[11px] text-text-tertiary">{u?.email}</div>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-3">
                    {!d.isPrimary && (
                      <button
                        type="button"
                        onClick={() => hacerTitular(d.userId)}
                        className="cursor-pointer text-[12px] font-semibold text-brand hover:underline"
                      >
                        Hacer titular
                      </button>
                    )}

                    <label
                      className={`inline-flex items-center gap-1.5 text-[12px] ${
                        sinTelefono ? "cursor-not-allowed text-text-tertiary" : "cursor-pointer text-text-secondary"
                      }`}
                      title={
                        sinTelefono
                          ? "Este usuario no tiene WhatsApp registrado en su ficha."
                          : "Además de la campanita, le llega un WhatsApp."
                      }
                    >
                      <input
                        type="checkbox"
                        className="size-3.5 accent-[var(--brand)]"
                        checked={d.notifyWhatsapp && !sinTelefono}
                        disabled={sinTelefono}
                        onChange={() => alternarWhatsapp(d.userId)}
                      />
                      WhatsApp
                    </label>

                    <button
                      type="button"
                      onClick={() => quitar(d.userId)}
                      className="cursor-pointer text-text-tertiary hover:text-error-text"
                      title="Quitar del cargo"
                    >
                      <Icon name="x" size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {draft.some((d) => d.notifyWhatsapp) && (
          <p className="text-[11px] text-text-tertiary">
            El WhatsApp sale al número que tenga el usuario en su ficha. Un mismo asunto no se repite antes de 15
            minutos, para que el aviso no se vuelva ruido.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={guardar} disabled={saving}>
            <Icon name="check" size={15} />
            {saving ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Tarjeta de un cargo                                                        */
/* -------------------------------------------------------------------------- */

function PostCard({ post, onEdit }: { post: Post; onEdit: () => void }) {
  const vacante = post.holders.length === 0;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-bold text-text-primary">{post.label}</h3>
          <p className="mt-0.5 text-[12px] text-text-tertiary">{post.purpose}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={onEdit}>
          {vacante ? "Nombrar" : "Cambiar"}
        </Button>
      </div>

      {vacante ? (
        <div className="flex items-center gap-2 text-[12px] text-warning-text">
          <Icon name="alert-triangle" size={14} />
          Sin encargado
          <span className="text-text-tertiary">
            {post.hasFallback ? "— los avisos salen al área completa" : "— estos avisos no le llegan a nadie"}
          </span>
        </div>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {post.holders.map((h) => (
            <li
              key={h.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface-2 px-2.5 py-1 text-[12px]"
            >
              <span className={`font-semibold ${h.inactive ? "text-text-tertiary line-through" : "text-text-primary"}`}>
                {h.name}
              </span>
              {h.isPrimary && <Badge label="Titular" tone="info" />}
              {h.notifyWhatsapp &&
                (h.missingPhone ? (
                  <span title="Pidió WhatsApp pero no tiene número en su ficha: sólo le llega la campanita.">
                    <Icon name="alert-triangle" size={13} className="text-warning-text" />
                  </span>
                ) : (
                  <span title="También le llega por WhatsApp">
                    <Icon name="message-circle" size={13} className="text-text-tertiary" />
                  </span>
                ))}
              {h.inactive && <Badge label="Inactivo" tone="error" />}
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-border-subtle pt-2.5">
        {post.alerts.length === 0 ? (
          <p className="text-[11px] text-text-tertiary">
            Todavía sin avisos automáticos. Se puede nombrar al encargado desde ya.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {post.alerts.map((a) => (
              <li key={a} className="flex items-start gap-1.5 text-[11px] text-text-secondary">
                <Icon name="bell" size={12} className="mt-0.5 shrink-0 text-text-tertiary" />
                {a}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Página                                                                      */
/* -------------------------------------------------------------------------- */

export default function ResponsablesPage() {
  const { authFetch, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Data | null>(null);
  const [users, setUsers] = useState<Assignable[]>([]);
  const [editing, setEditing] = useState<Post | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, u] = await Promise.all([
        (await authFetch("/responsibilities")).json(),
        (await authFetch("/responsibilities/assignable")).json(),
      ]);
      setData(d as Data);
      setUsers(Array.isArray(u) ? (u as Assignable[]) : []);
    } catch {
      toast("No se pudieron cargar los encargados", "x");
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  if (authLoading || loading) return <PageSkeleton />;

  const grupos = data?.groups ?? [];
  const vacantes = data?.vacantes ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeading
        icon="contact"
        title="Encargados por cargo"
        subtitle="Quién responde por cada frente — y a quién le llegan sus avisos"
      />

      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <div className="flex items-start gap-2.5">
          <Icon name="info" size={16} className="mt-0.5 shrink-0 text-text-secondary" />
          <p className="text-[12px] leading-relaxed text-text-secondary">
            Los permisos dicen quién <strong>puede</strong> hacer algo; aquí se define quién{" "}
            <strong>responde</strong> por ello. El aviso de cada frente le llega al titular y a sus suplentes, en vez de
            salir a todo el que tenga el permiso —que es la forma más rápida de que nadie se sienta aludido—. Los
            suplentes reciben lo mismo, para que nada se caiga en vacaciones o en un cambio de turno.
          </p>
        </div>
        {vacantes > 0 && (
          <div className="mt-3 flex items-center gap-2 border-t border-border-subtle pt-3 text-[12px] text-warning-text">
            <Icon name="alert-triangle" size={14} />
            {vacantes} {vacantes === 1 ? "cargo sigue" : "cargos siguen"} sin encargado.
          </div>
        )}
      </div>

      {grupos.map((g) => (
        <section key={g.group} className="flex flex-col gap-3">
          <h2 className="text-[12px] font-bold uppercase tracking-wide text-text-tertiary">{g.group}</h2>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {g.posts.map((p) => (
              <PostCard key={p.slug} post={p} onEdit={() => setEditing(p)} />
            ))}
          </div>
        </section>
      ))}

      {editing && (
        <EncargadosModal post={editing} users={users} onClose={() => setEditing(null)} onSaved={load} />
      )}
    </div>
  );
}
