"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/Modal";
import { Input, Select, Field } from "@/components/ui/Field";
import { Segmented, Interruptor, InterruptorCompacto } from "@/components/ui/Segmented";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { fullCurrency } from "@/lib/format";
import { type Plan, type ServiceKind, SERVICE_KIND_LABEL } from "@/lib/plans";
import { VelocidadOltPlanes } from "@/components/configuracion/VelocidadOltPlanes";
import { CombosPlanes } from "@/components/configuracion/CombosPlanes";

type Draft = {
  name: string;
  kind: ServiceKind;
  pppProfile: string;
  price: string;
  taxRate: string;
  megas: string;
  active: boolean;
};

const EMPTY: Draft = { name: "", kind: "INTERNET", pppProfile: "", price: "", taxRate: "0", megas: "", active: true };

export default function PlanesPage() {
  const { authFetch } = useAuth();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmar, setConfirmar] = useState<Plan | null>(null);
  const [borrando, setBorrando] = useState(false);
  /** Qué se lista: con 64 planes en el catálogo, los ocultos tapan a los vivos. */
  const [filtro, setFiltro] = useState<"todos" | "visibles" | "ocultos">("todos");
  /** Planes con el interruptor en vuelo (no se deja pulsar dos veces). */
  const [cambiando, setCambiando] = useState<Set<string>>(new Set());
  /** Pestaña activa. `?tab=olt` la fija desde fuera (el aviso de la orden enlaza aquí). */
  const [tab, setTab] = useState<"catalogo" | "combos" | "olt">("catalogo");
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "olt" || t === "combos") setTab(t);
  }, []);

  const load = useCallback(() => {
    void authFetch(`/plans`).then((r) => (r.ok ? r.json() : [])).then(setPlans).catch(() => setPlans([]));
  }, [authFetch]);
  useEffect(() => { load(); }, [load]);

  function openNew() {
    setEditing(null);
    setDraft({ ...EMPTY });
  }
  function openEdit(p: Plan) {
    setEditing(p);
    setDraft({
      name: p.name, kind: p.kind, pppProfile: p.pppProfile ?? "",
      price: String(p.price), taxRate: String(p.taxRate ?? 0),
      megas: p.megas == null ? "" : String(p.megas), active: p.active,
    });
  }

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) { toast("El plan necesita un nombre", "alert-circle"); return; }
    const price = Number(draft.price);
    if (!Number.isFinite(price) || price < 0) { toast("Precio inválido", "alert-circle"); return; }
    setBusy(true);
    try {
      const body = JSON.stringify({
        name: draft.name.trim(),
        kind: draft.kind,
        pppProfile: draft.pppProfile.trim() || undefined,
        price,
        taxRate: draft.taxRate.trim() ? Number(draft.taxRate) : 0,
        megas: draft.megas.trim() ? Number(draft.megas) : undefined,
        active: draft.active,
      });
      const res = editing
        ? await authFetch(`/plans/${editing.id}`, { method: "PATCH", body })
        : await authFetch(`/plans`, { method: "POST", body });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar");
      toast(editing ? "Plan actualizado" : "Plan creado", "check");
      setDraft(null);
      setEditing(null);
      load();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Muestra u oculta el plan al resto del sistema sin abrir el formulario: es la
   * operación del día a día ("este ya no se vende"), y obligar a entrar a editar
   * un plan para eso es pasear a la gente por el PRECIO con el que se factura.
   *
   * Se pinta primero y se corrige si el servidor dice que no: el interruptor
   * tiene que responder al dedo, no al viaje de red.
   */
  async function alternarVisibilidad(p: Plan, next: boolean) {
    if (cambiando.has(p.id)) return;
    setCambiando((s) => new Set(s).add(p.id));
    setPlans((prev) => prev?.map((x) => (x.id === p.id ? { ...x, active: next } : x)) ?? prev);
    try {
      const res = await authFetch(`/plans/${p.id}`, { method: "PATCH", body: JSON.stringify({ active: next }) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo cambiar");
      // Ocultar un plan NO le quita el servicio a quien ya lo tiene: se dice aquí
      // para que nadie crea que acaba de dejar a 800 abonados sin cobro.
      toast(
        next
          ? `“${p.name}” vuelve a estar disponible`
          : p.subscribers > 0
            ? `“${p.name}” oculto · los ${p.subscribers} abonado(s) que ya lo tienen siguen igual`
            : `“${p.name}” oculto para los demás funcionarios`,
        next ? "eye" : "eye-off",
      );
    } catch (e) {
      setPlans((prev) => prev?.map((x) => (x.id === p.id ? { ...x, active: !next } : x)) ?? prev);
      toast((e as Error).message, "alert-circle");
    } finally {
      setCambiando((s) => { const n = new Set(s); n.delete(p.id); return n; });
    }
  }

  async function remove(p: Plan) {
    setBorrando(true);
    try {
      const res = await authFetch(`/plans/${p.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "No se pudo eliminar");
      toast(data?.deactivated ? "Plan desactivado (está en uso)" : "Plan eliminado", "check");
      load();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setBorrando(false);
      setConfirmar(null);
    }
  }

  const visibles = plans?.filter((p) => p.active).length ?? 0;
  const mostrados = (plans ?? []).filter(
    (p) => filtro === "todos" || (filtro === "visibles" ? p.active : !p.active),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeading
          icon="gauge"
          title="Planes"
          subtitle="Catálogo de planes de servicio. Es la fuente del precio de la mensualidad recurrente y del perfil que se empuja al router."
        />
        {tab === "catalogo" && <Button onClick={openNew}><Icon name="plus" size={15} /> Nuevo plan</Button>}
      </div>

      {/* El plan ya no es solo precio + perfil PPP: también dice a qué velocidad
          se autentica la ONU en la OLT, y con qué otros planes se vende junto.
          Son configuraciones distintas del mismo catálogo, así que van en la
          misma pantalla en pestañas. */}
      <div className="flex gap-1 border-b border-border-subtle">
        {([["catalogo", "Catálogo"], ["combos", "Combos"], ["olt", "Velocidad en OLT"]] as const).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors ${
              tab === k ? "border-brand text-text-primary" : "border-transparent text-text-tertiary hover:text-text-secondary"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "combos" && <CombosPlanes />}
      {tab === "olt" && <VelocidadOltPlanes />}

      <div className={`space-y-2 ${tab === "catalogo" ? "" : "hidden"}`}>
        {!plans ? (
          <p className="text-[13px] text-text-tertiary">Cargando…</p>
        ) : plans.length === 0 ? (
          <p className="text-[13px] text-text-tertiary">Aún no hay planes. Crea el primero con “Nuevo plan”.</p>
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[12.5px] text-text-tertiary">
                El interruptor decide si el plan le aparece a los demás funcionarios al dar de alta o
                cambiar de plan. Ocultarlo no le quita el servicio a quien ya lo tiene.
              </p>
              <Segmented
                ariaLabel="Filtrar planes por visibilidad"
                value={filtro}
                onChange={setFiltro}
                options={[
                  { value: "todos", label: `Todos (${plans.length})` },
                  { value: "visibles", label: `Visibles (${visibles})` },
                  { value: "ocultos", label: `Ocultos (${plans.length - visibles})` },
                ]}
              />
            </div>

            {mostrados.length === 0 ? (
              <p className="text-[13px] text-text-tertiary">
                {filtro === "ocultos" ? "No hay planes ocultos." : "No hay planes visibles."}
              </p>
            ) : mostrados.map((p) => (
              <div
                key={p.id}
                className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${
                  p.active ? "border-border-subtle bg-surface" : "border-dashed border-border-subtle bg-surface-2"
                }`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <InterruptorCompacto
                    checked={p.active}
                    disabled={cambiando.has(p.id)}
                    onChange={(next) => void alternarVisibilidad(p, next)}
                    label={p.active ? `Ocultar “${p.name}” a los demás funcionarios` : `Mostrar “${p.name}” a los demás funcionarios`}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`truncate text-[14px] font-semibold ${p.active ? "text-text-primary" : "text-text-tertiary"}`}>{p.name}</span>
                      <Badge tone="info" label={SERVICE_KIND_LABEL[p.kind]} />
                      {!p.active && <Badge tone="warning" label="Oculto" />}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-text-tertiary">
                      <span className="font-mono">{p.pppProfile || "sin perfil"}</span>
                      {p.taxRate > 0 && <span>IVA {p.taxRate}%</span>}
                      {p.megas != null && <span>{p.megas} Mbps</span>}
                      {/* El número lleva al listado de clientes filtrado por este plan:
                          saber que son 812 no sirve si no se puede ver quiénes son. */}
                      {p.subscribers > 0 ? (
                        <Link
                          href={`/clientes?planId=${p.id}`}
                          className="tap font-semibold text-brand underline decoration-dotted underline-offset-2 hover:decoration-solid"
                          title={`Ver los ${p.subscribers} cliente(s) con “${p.name}”`}
                        >
                          {p.subscribers} abonado(s)
                        </Link>
                      ) : (
                        <span>sin abonados</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className={`text-[14px] font-bold ${p.active ? "text-text-primary" : "text-text-tertiary"}`}>{fullCurrency(p.price)}<span className="text-[11px] font-normal text-text-tertiary">/mes</span></span>
                  <button type="button" onClick={() => openEdit(p)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" title="Editar">
                    <Icon name="pencil" size={15} />
                  </button>
                  <button type="button" onClick={() => setConfirmar(p)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-error-soft hover:text-error-text" title="Eliminar">
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {draft && (
        <Modal open onClose={() => setDraft(null)} title={editing ? "Editar plan" : "Nuevo plan"}>
          <div className="flex flex-col gap-3">
            <Field label="Nombre">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="300 Megas ST" />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Tipo de servicio">
                <Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ServiceKind })}>
                  {(Object.keys(SERVICE_KIND_LABEL) as ServiceKind[]).map((k) => (
                    <option key={k} value={k}>{SERVICE_KIND_LABEL[k]}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Precio mensual (COP)" hint="Base sin IVA">
                <Input type="number" min={0} value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} placeholder="60000" />
              </Field>
            </div>
            <Field label="IVA (%)" hint="Internet 0 · Televisión 19">
              <Input type="number" min={0} value={draft.taxRate} onChange={(e) => setDraft({ ...draft, taxRate: e.target.value })} placeholder="0" />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Perfil PPP (router)" hint="Vacío = no se empuja al router">
                <Input value={draft.pppProfile} onChange={(e) => setDraft({ ...draft, pppProfile: e.target.value })} placeholder="300M" />
              </Field>
              <Field label="Velocidad (Mbps)" hint="Informativo">
                <Input type="number" min={0} value={draft.megas} onChange={(e) => setDraft({ ...draft, megas: e.target.value })} placeholder="300" />
              </Field>
            </div>
            <div className="rounded-lg border border-border-subtle bg-surface-2 p-2.5">
              <Interruptor
                checked={draft.active}
                onChange={(active) => setDraft({ ...draft, active })}
                title="Visible para los demás funcionarios"
                detail={
                  draft.active
                    ? "Aparece al dar de alta y al cambiar de plan."
                    : "No aparece en ningún desplegable. Quien ya lo tiene lo conserva."
                }
              />
            </div>
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
          title={confirmar.subscribers > 0 ? "Retirar plan del catálogo" : "Eliminar plan"}
          confirmLabel={confirmar.subscribers > 0 ? "Retirar del catálogo" : "Eliminar plan"}
          message={
            confirmar.subscribers > 0 ? (
              <>
                El plan tiene <b>{confirmar.subscribers} abonado(s)</b> asignados, así que no se
                borra: queda <b>oculto</b>. Esos abonados conservan su plan y su cobro, pero
                el plan dejará de poder asignarse a nuevos abonados. Es lo mismo que hace el
                interruptor de la lista, y se puede revertir.
              </>
            ) : (
              <>
                El plan desaparece del catálogo y dejará de estar disponible al dar de alta o
                cambiar de plan a un abonado. No se puede deshacer.
              </>
            )
          }
          detail={<PlanResumen plan={confirmar} />}
        />
      )}
    </div>
  );
}

/** Ficha compacta del plan dentro de la confirmación. */
function PlanResumen({ plan }: { plan: Plan }) {
  const filas: [string, React.ReactNode][] = [
    ["Plan", plan.name],
    ["Servicio", <Badge key="k" tone="info" label={SERVICE_KIND_LABEL[plan.kind]} />],
    ["Precio", <span key="p" className="font-mono">{fullCurrency(plan.price)}/mes</span>],
    ["Perfil PPP", <span key="pp" className="font-mono">{plan.pppProfile || "—"}</span>],
    ["Abonados", <Badge key="s" tone={plan.subscribers > 0 ? "warning" : "default"} label={`${plan.subscribers} abonado(s)`} />],
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
