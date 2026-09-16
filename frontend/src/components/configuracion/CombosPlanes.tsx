"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/Modal";
import { Input, Select, Field } from "@/components/ui/Field";
import { Interruptor, InterruptorCompacto } from "@/components/ui/Segmented";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { fullCurrency } from "@/lib/format";
import { type Bundle, type BundleApp, type Plan, type ServiceKind, SERVICE_KIND_LABEL } from "@/lib/plans";

/**
 * Combos: paquetes de planes que se venden juntos a un precio propio.
 *
 * El precio se fija POR COMPONENTE y no como un total del combo. No es un
 * capricho de la pantalla: la mensualidad se factura con una línea por servicio
 * y cada una lleva su IVA (internet 0%, TV 19%). Repartir un total a posteriori
 * movería el IVA que se le cobra al cliente y lo que se le reporta a la DIAN.
 *
 * Al venderlo, estos precios se copian a los servicios del abonado y de ahí en
 * adelante la facturación hace lo de siempre. Cambiar un combo NO reprecia a
 * quien ya lo tiene, igual que con los planes sueltos.
 */

/** Orden en que se ofrecen los tipos de servicio dentro del combo. */
const KIND_ORDER: ServiceKind[] = ["INTERNET", "TV", "PUNTOS", "STREAMING"];

/** Una fila del armador: el plan elegido para un tipo de servicio y su precio. */
type Linea = { planId: string; price: string };
type Draft = {
  name: string;
  description: string;
  active: boolean;
  /** kind → línea. Sin entrada = ese servicio no va en el combo. */
  lineas: Partial<Record<ServiceKind, Linea>>;
  /** Códigos de las apps que el cliente puede elegir con el combo. */
  apps: string[];
};

const EMPTY: Draft = { name: "", description: "", active: true, lineas: {}, apps: [] };

export function CombosPlanes() {
  const { authFetch } = useAuth();
  const [combos, setCombos] = useState<Bundle[] | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [appsCatalogo, setAppsCatalogo] = useState<BundleApp[]>([]);
  const [editing, setEditing] = useState<Bundle | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmar, setConfirmar] = useState<Bundle | null>(null);
  const [borrando, setBorrando] = useState(false);
  const [cambiando, setCambiando] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    void authFetch(`/plan-bundles`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setCombos(Array.isArray(d) ? d : []))
      .catch(() => setCombos([]));
  }, [authFetch]);
 
  useEffect(() => {
    load();
    // Solo planes visibles: meter en un combo un plan que ya no se vende deja el
    // combo invendible (el backend lo rechaza al aplicarlo).
    void authFetch(`/plans?activeOnly=true`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setPlans(Array.isArray(d) ? d : []))
      .catch(() => setPlans([]));
    // Catálogo de apps (PlayHub). Es el mismo del que salen los códigos que se
    // guardan, así que no hay una lista propia que se pueda desincronizar.
    void authFetch(`/plan-bundles/apps`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setAppsCatalogo(Array.isArray(d) ? d : []))
      .catch(() => setAppsCatalogo([]));
  }, [load, authFetch]);

  /** Planes disponibles por tipo de servicio, para los desplegables del armador. */
  const planesPorKind = useMemo(() => {
    const m = new Map<ServiceKind, Plan[]>();
    for (const p of plans) {
      if (!m.has(p.kind)) m.set(p.kind, []);
      m.get(p.kind)!.push(p);
    }
    return m;
  }, [plans]);

  /**
   * Catálogo de apps agrupado por área comercial (Standard, Premium, …) para
   * que el desplegable no sea una lista plana de 20 nombres sueltos.
   */
  const appsPorArea = useMemo(() => {
    const m = new Map<string, BundleApp[]>();
    for (const a of appsCatalogo) {
      if (!m.has(a.area)) m.set(a.area, []);
      m.get(a.area)!.push(a);
    }
    return [...m.entries()];
  }, [appsCatalogo]);

  /** Las elegidas, en el orden del catálogo (no en el que se fueron pulsando). */
  const appsElegidas = useMemo(
    () => appsCatalogo.filter((a) => draft?.apps.includes(a.code)),
    [appsCatalogo, draft],
  );

  function agregarApp(code: string) {
    if (!draft || !code || draft.apps.includes(code)) return;
    setDraft({ ...draft, apps: [...draft.apps, code] });
  }

  function quitarApp(code: string) {
    if (!draft) return;
    setDraft({ ...draft, apps: draft.apps.filter((c) => c !== code) });
  }

  function openNew() {
    setEditing(null);
    setDraft({ ...EMPTY, lineas: {}, apps: [] });
  }

  function openEdit(b: Bundle) {
    setEditing(b);
    setDraft({
      name: b.name,
      description: b.description ?? "",
      active: b.active,
      lineas: Object.fromEntries(
        b.items.map((it) => [it.kind, { planId: it.planId, price: String(it.price) }]),
      ) as Partial<Record<ServiceKind, Linea>>,
      apps: b.apps.map((a) => a.code),
    });
  }

  /** Elegir plan en una fila. El precio se precarga con el de lista para editarlo. */
  function elegirPlan(kind: ServiceKind, planId: string) {
    if (!draft) return;
    const lineas = { ...draft.lineas };
    if (!planId) {
      delete lineas[kind];
    } else {
      const plan = plans.find((p) => p.id === planId);
      lineas[kind] = { planId, price: String(plan?.price ?? 0) };
    }
    setDraft({ ...draft, lineas });
  }

  function ponerPrecio(kind: ServiceKind, price: string) {
    if (!draft) return;
    const actual = draft.lineas[kind];
    if (!actual) return;
    setDraft({ ...draft, lineas: { ...draft.lineas, [kind]: { ...actual, price } } });
  }

  /** Cuentas en vivo del armador: qué cobra el combo y cuánto se rebaja. */
  const cuentas = useMemo(() => {
    const filas = KIND_ORDER.flatMap((kind) => {
      const l = draft?.lineas[kind];
      if (!l) return [];
      const plan = plans.find((p) => p.id === l.planId);
      if (!plan) return [];
      const precio = Number(l.price);
      return [{ kind, plan, precio: Number.isFinite(precio) ? precio : 0 }];
    });
    const total = filas.reduce((s, f) => s + f.precio, 0);
    const lista = filas.reduce((s, f) => s + f.plan.price, 0);
    return { filas, total, lista, ahorro: lista - total };
  }, [draft, plans]);

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) { toast("El combo necesita un nombre", "alert-circle"); return; }
    if (cuentas.filas.length < 2) { toast("Un combo necesita al menos 2 servicios", "alert-circle"); return; }
    const invalido = cuentas.filas.find((f) => !Number.isFinite(Number(draft.lineas[f.kind]!.price)) || f.precio < 0);
    if (invalido) { toast(`Precio inválido en ${SERVICE_KIND_LABEL[invalido.kind]}`, "alert-circle"); return; }

    setBusy(true);
    try {
      const body = JSON.stringify({
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        active: draft.active,
        items: cuentas.filas.map((f) => ({ planId: f.plan.id, price: f.precio })),
        allowedApps: draft.apps,
      });
      const res = editing
        ? await authFetch(`/plan-bundles/${editing.id}`, { method: "PATCH", body })
        : await authFetch(`/plan-bundles`, { method: "POST", body });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar");
      toast(editing ? "Combo actualizado" : "Combo creado", "check");
      setDraft(null);
      setEditing(null);
      load();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setBusy(false);
    }
  }

  /** Mostrar/ocultar el combo a los demás funcionarios (igual que un plan). */
  async function alternarVisibilidad(b: Bundle, next: boolean) {
    if (cambiando.has(b.id)) return;
    setCambiando((s) => new Set(s).add(b.id));
    setCombos((prev) => prev?.map((x) => (x.id === b.id ? { ...x, active: next } : x)) ?? prev);
    try {
      const res = await authFetch(`/plan-bundles/${b.id}`, { method: "PATCH", body: JSON.stringify({ active: next }) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo cambiar");
      toast(next ? `“${b.name}” ya se puede vender` : `“${b.name}” oculto`, next ? "eye" : "eye-off");
    } catch (e) {
      setCombos((prev) => prev?.map((x) => (x.id === b.id ? { ...x, active: !next } : x)) ?? prev);
      toast((e as Error).message, "alert-circle");
    } finally {
      setCambiando((s) => { const n = new Set(s); n.delete(b.id); return n; });
    }
  }

  async function remove(b: Bundle) {
    setBorrando(true);
    try {
      const res = await authFetch(`/plan-bundles/${b.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "No se pudo eliminar");
      toast(data?.deactivated ? "Combo oculto (está en uso)" : "Combo eliminado", "check");
      load();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setBorrando(false);
      setConfirmar(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        {/* El párrafo se topa: si no, empuja al botón y lo deja partido en dos líneas. */}
        <p className="max-w-2xl text-[12.5px] text-text-tertiary">
          Paquetes de planes que se venden juntos a precio rebajado. Al venderlo, la factura del
          cliente sale con sus renglones de siempre —uno por servicio, con su IVA— pero a estos
          precios. Cambiar un combo no le cambia el cobro a quien ya lo tiene.
        </p>
        <Button className="w-full shrink-0 whitespace-nowrap px-6 sm:w-auto" onClick={openNew}>
          <Icon name="plus" size={15} /> Nuevo combo
        </Button>
      </div>

      {!combos ? (
        <p className="text-[13px] text-text-tertiary">Cargando…</p>
      ) : combos.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-subtle bg-surface-2 p-6 text-center">
          <p className="text-[13px] font-semibold text-text-primary">Aún no hay combos armados</p>
          <p className="mt-1 text-[12px] text-text-tertiary">
            Un combo junta, por ejemplo, un plan de internet y uno de televisión a un precio
            menor que la suma de los dos. Crea el primero con “Nuevo combo”.
          </p>
        </div>
      ) : combos.map((b) => (
        <div
          key={b.id}
          className={`rounded-xl border p-3 ${b.active ? "border-border-subtle bg-surface" : "border-dashed border-border-subtle bg-surface-2"}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <div className="pt-0.5">
                <InterruptorCompacto
                  checked={b.active}
                  disabled={cambiando.has(b.id)}
                  onChange={(next) => void alternarVisibilidad(b, next)}
                  label={b.active ? `Ocultar el combo “${b.name}”` : `Mostrar el combo “${b.name}”`}
                />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`truncate text-[14px] font-semibold ${b.active ? "text-text-primary" : "text-text-tertiary"}`}>{b.name}</span>
                  {!b.active && <Badge tone="warning" label="Oculto" />}
                  {b.blocked && <Badge tone="error" label="Lleva un plan oculto" />}
                  {b.savings > 0 && <Badge tone="success" label={`Ahorro ${fullCurrency(b.savings)}`} />}
                </div>
                {b.description && <p className="mt-0.5 text-[12px] text-text-tertiary">{b.description}</p>}
                <div className="mt-1.5 flex flex-col gap-0.5">
                  {b.items.map((it) => (
                    <div key={it.planId} className="flex items-baseline gap-2 text-[12px]">
                      <span className="w-[76px] shrink-0 text-text-tertiary">{SERVICE_KIND_LABEL[it.kind]}</span>
                      <span className="truncate text-text-secondary">{it.planName}</span>
                      <span className="font-mono text-text-primary">{fullCurrency(it.price)}</span>
                      {it.listPrice > it.price && (
                        <span className="font-mono text-[11px] text-text-tertiary line-through">{fullCurrency(it.listPrice)}</span>
                      )}
                    </div>
                  ))}
                </div>
                {b.apps.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[12px]">
                    <span className="text-text-tertiary">Apps a elegir</span>
                    {b.apps.map((a) => (
                      <span
                        key={a.code}
                        className="rounded-full border border-border-subtle px-2 py-0.5 text-[11px] text-text-secondary"
                        title={`${a.name} · ${a.area}`}
                      >
                        {a.name}
                      </span>
                    ))}
                  </div>
                )}
                <p className="mt-1 text-[11.5px] text-text-tertiary">{b.subscribers} abonado(s) con este combo</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <div className="text-right">
                <div className={`text-[15px] font-bold ${b.active ? "text-text-primary" : "text-text-tertiary"}`}>
                  {fullCurrency(b.total)}<span className="text-[11px] font-normal text-text-tertiary">/mes</span>
                </div>
                {b.savings > 0 && (
                  <div className="text-[11px] text-text-tertiary line-through">{fullCurrency(b.listTotal)}</div>
                )}
              </div>
              <button type="button" onClick={() => openEdit(b)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" title="Editar">
                <Icon name="pencil" size={15} />
              </button>
              <button type="button" onClick={() => setConfirmar(b)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-error-soft hover:text-error-text" title="Eliminar">
                <Icon name="trash" size={15} />
              </button>
            </div>
          </div>
        </div>
      ))}

      {/* El armador va en un modal más ancho que el de por defecto: lleva tres
          columnas (servicio · plan · precio) y a 512 px el desplegable del plan
          no deja leer el nombre completo. */}
      {draft && (
        <Modal open onClose={() => setDraft(null)} maxWidth="max-w-2xl" title={editing ? "Editar combo" : "Nuevo combo"}>
          <div className="flex flex-col gap-3">
            <Field label="Nombre del combo">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Combo Hogar 300" />
            </Field>
            <Field label="Descripción" hint="Opcional. Es el gancho que ve quien lo vende.">
              <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Internet 300 Megas + televisión completa" />
            </Field>

            <div>
              <p className="mb-1.5 text-[12.5px] font-semibold text-text-primary">Qué lleva el combo</p>
              <p className="mb-2 text-[11.5px] text-text-tertiary">
                Elige un plan por servicio y ponle el precio que tiene DENTRO del combo. Deja en
                “—” los servicios que no van. Mínimo dos.
              </p>
              <div className="flex flex-col gap-2">
                {KIND_ORDER.map((kind) => {
                  const disponibles = planesPorKind.get(kind) ?? [];
                  if (!disponibles.length) return null;
                  const linea = draft.lineas[kind];
                  const plan = disponibles.find((p) => p.id === linea?.planId);
                  return (
                    <div key={kind} className="grid grid-cols-1 gap-2 sm:grid-cols-[100px_1fr_130px] sm:items-center">
                      <span className="text-[12.5px] font-semibold text-text-secondary">{SERVICE_KIND_LABEL[kind]}</span>
                      <Select value={linea?.planId ?? ""} onChange={(e) => elegirPlan(kind, e.target.value)}>
                        <option value="">— sin {SERVICE_KIND_LABEL[kind].toLowerCase()} —</option>
                        {disponibles.map((p) => (
                          <option key={p.id} value={p.id}>{p.name} · {fullCurrency(p.price)}</option>
                        ))}
                      </Select>
                      <Input
                        type="text"
                        min={0}
                        disabled={!linea}
                        value={linea?.price ?? ""}
                        onChange={(e) => ponerPrecio(kind, e.target.value)}
                        placeholder={plan ? String(plan.price) : "—"}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Las apps NO se facturan aquí: el cupo ("02 servicios a elegir") va
                dentro del plan del combo y esta lista solo dice ENTRE CUÁLES puede
                escoger el cliente. Por eso no entra en la cuenta de abajo. */}
            {appsCatalogo.length > 0 && (
              <div>
                <p className="mb-1.5 text-[12.5px] font-semibold text-text-primary">
                  Aplicaciones que puede elegir el cliente
                </p>
                <p className="mb-2 text-[11.5px] text-text-tertiary">
                  Con este combo el cliente escoge entre las apps que marques aquí. Déjalo vacío si
                  el combo no ofrece apps.
                </p>

                <Select
                  value=""
                  onChange={(e) => { agregarApp(e.target.value); e.target.value = ""; }}
                >
                  <option value="">— Añadir aplicación —</option>
                  {appsPorArea.map(([area, lista]) => {
                    const libres = lista.filter((a) => !draft.apps.includes(a.code));
                    if (!libres.length) return null;
                    return (
                      <optgroup key={area} label={area}>
                        {libres.map((a) => (
                          <option key={a.code} value={a.code}>{a.name}</option>
                        ))}
                      </optgroup>
                    );
                  })}
                </Select>

                {appsElegidas.length === 0 ? (
                  <p className="mt-2 text-[11.5px] text-text-tertiary">
                    Ninguna aplicación por ahora.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {appsElegidas.map((a) => (
                      <span
                        key={a.code}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface-2 py-1 pl-2.5 pr-1.5 text-[12px] text-text-primary"
                      >
                        <span className="truncate">{a.name}</span>
                        <span className="text-[10.5px] text-text-tertiary">{a.area}</span>
                        <button
                          type="button"
                          onClick={() => quitarApp(a.code)}
                          className="tap rounded-full p-0.5 text-text-tertiary hover:bg-error-soft hover:text-error-text"
                          title={`Quitar ${a.name}`}
                          aria-label={`Quitar ${a.name}`}
                        >
                          <Icon name="x" size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* La cuenta a la vista mientras se arma: es la decisión comercial. */}
            {cuentas.filas.length > 0 && (
              <div className="rounded-lg border border-border-subtle bg-surface-2 p-2.5">
                <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[12.5px]">
                  {cuentas.filas.map((f) => (
                    <Fragment key={f.kind}>
                      <dt className="truncate text-text-tertiary">{f.plan.name}</dt>
                      <dd className="text-right font-mono text-text-primary">{fullCurrency(f.precio)}</dd>
                    </Fragment>
                  ))}
                  <dt className="border-t border-border-subtle pt-1 font-semibold text-text-primary">Total del combo</dt>
                  <dd className="border-t border-border-subtle pt-1 text-right font-mono font-bold text-text-primary">{fullCurrency(cuentas.total)}/mes</dd>
                  <dt className="text-text-tertiary">Precio suelto</dt>
                  <dd className="text-right font-mono text-text-tertiary">{fullCurrency(cuentas.lista)}</dd>
                  <dt className={cuentas.ahorro >= 0 ? "font-semibold text-success-text" : "font-semibold text-error-text"}>
                    {cuentas.ahorro >= 0 ? "Ahorro del cliente" : "Sobreprecio"}
                  </dt>
                  <dd className={`text-right font-mono font-bold ${cuentas.ahorro >= 0 ? "text-success-text" : "text-error-text"}`}>
                    {fullCurrency(Math.abs(cuentas.ahorro))}/mes
                  </dd>
                </dl>
                {cuentas.ahorro < 0 && (
                  <p className="mt-1.5 text-[11.5px] text-error-text">
                    Este combo sale MÁS caro que comprar los planes por separado. Revisa los precios.
                  </p>
                )}
              </div>
            )}

            <div className="rounded-lg border border-border-subtle bg-surface-2 p-2.5">
              <Interruptor
                checked={draft.active}
                onChange={(active) => setDraft({ ...draft, active })}
                title="Se puede vender"
                detail={
                  draft.active
                    ? "Aparece al dar de alta y al cambiar de plan."
                    : "Queda armado pero nadie puede venderlo todavía."
                }
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDraft(null)}>Cancelar</Button>
              <Button onClick={save} disabled={busy}>{busy ? "Guardando…" : "Guardar combo"}</Button>
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
          title={confirmar.subscribers > 0 ? "Retirar combo" : "Eliminar combo"}
          confirmLabel={confirmar.subscribers > 0 ? "Retirar de la venta" : "Eliminar combo"}
          message={
            confirmar.subscribers > 0 ? (
              <>
                Hay <b>{confirmar.subscribers} abonado(s)</b> con este combo, así que no se borra:
                queda <b>oculto</b>. Ellos conservan sus planes y su precio; el combo solo deja de
                poder venderse.
              </>
            ) : (
              <>
                El combo desaparece del catálogo. Los planes que lo componen no se tocan: siguen
                vendiéndose sueltos. No se puede deshacer.
              </>
            )
          }
        />
      )}
    </div>
  );
}
