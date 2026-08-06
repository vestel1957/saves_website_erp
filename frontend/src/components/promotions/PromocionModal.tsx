"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Segmented, Interruptor } from "@/components/ui/Segmented";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { PasoPublico } from "@/components/promotions/PublicoPromocion";
import { useAlcance } from "@/components/promotions/useAlcance";
import {
  type DiscountFormat, type Promotion, type PromotionAudience, type PromotionCatalogs,
  type PromotionDraft, type PromotionSubscriber, type PromotionTemplate,
  EMPTY_AUDIENCE, FACTURA_EJEMPLO, discountLabel, isFlatDiscount,
  requisitosPromocion, simularDescuento,
} from "@/lib/promotions";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const dstr = (s: string) => s.slice(0, 10);
const cop = (n: number) => `$${Math.round(Number(n || 0)).toLocaleString("es-CO")}`;
const fecha = (s: string) => { const [y, m, d] = s.split("-"); return d && m && y ? `${d}/${m}/${y}` : s; };

const PASOS = ["Descuento", "Clientes", "Fechas"];

const EMPTY: PromotionDraft = {
  name: "", description: "", discountFormat: "%", percentage: "", flatAmount: "",
  startDate: iso(new Date()), endDate: iso(new Date()), active: true,
};

/** Atajos de vigencia: el 90% de las campañas cae en uno de estos rangos. */
function rangosRapidos() {
  const hoy = new Date();
  return [
    { label: "Este mes", desde: iso(hoy), hasta: iso(new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0)) },
    { label: "3 meses", desde: iso(hoy), hasta: iso(new Date(hoy.getFullYear(), hoy.getMonth() + 3, 0)) },
    { label: "Resto del año", desde: iso(hoy), hasta: iso(new Date(hoy.getFullYear(), 11, 31)) },
  ];
}

/**
 * Barra de progreso del asistente. Los tramos son PULSABLES: se puede volver a un
 * paso ya visto, o saltar hacia adelante si todo lo anterior está completo. Ir y
 * venir a revisar algo no debería costar tres clics en «Atrás».
 */
function Pasos({
  actual, onIr, alcanzable,
}: {
  actual: number;
  onIr: (i: number) => void;
  alcanzable: (i: number) => boolean;
}) {
  return (
    <div className="flex gap-1.5">
      {PASOS.map((p, i) => {
        const puede = alcanzable(i);
        return (
          <button key={p} type="button" disabled={!puede} onClick={() => onIr(i)}
            aria-current={i === actual ? "step" : undefined}
            className={`tap flex flex-1 flex-col gap-1.5 text-left ${puede ? "cursor-pointer" : "cursor-default"}`}>
            <span aria-hidden className={`h-[3px] rounded-full transition-colors ${
              i <= actual ? "bg-brand" : "bg-border-subtle"
            }`} />
            <span className={`text-[10.5px] font-semibold transition-colors ${
              i === actual ? "text-brand" : puede ? "text-text-secondary" : "text-text-tertiary"
            }`}>
              {p}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * La única línea de contexto del asistente: siempre en el mismo sitio, al pie del
 * paso, y siempre con lo que acaba de decidirse.
 */
function Eco({ tono = "normal", children }: { tono?: "normal" | "alerta"; children: React.ReactNode }) {
  return (
    <p className={`mt-auto rounded-lg px-3 py-2 text-[12.5px] ${
      tono === "alerta" ? "bg-warning-soft text-warning-text" : "bg-surface-2 text-text-tertiary"
    }`}>
      {children}
    </p>
  );
}

/** Valor destacado dentro de la línea de eco. */
function V({ children }: { children: React.ReactNode }) {
  return <b className="font-semibold tabular-nums text-text-primary">{children}</b>;
}

/**
 * Crear o editar una promoción, en tres pasos: cuánto descuenta, a quién y entre qué
 * fechas. Nunca hay más de tres controles en pantalla y «Siguiente» no deja avanzar
 * hasta que el paso esté completo, así que no hace falta enumerar pendientes.
 *
 * El cuerpo que se manda al servidor no cambió: los dos interruptores del paso 1
 * escriben el mismo `discountFormat` de siempre (`%`, `flat`, `b_p`, `bflat`).
 */
export function PromocionModal({
  editing, catalogs, onClose, onSaved,
}: {
  editing: Promotion | null;
  catalogs: PromotionCatalogs | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { authFetch } = useAuth();
  const [paso, setPaso] = useState(0);
  const [busy, setBusy] = useState(false);

  const [draft, setDraft] = useState<PromotionDraft>(() =>
    editing
      ? {
          name: editing.name,
          description: editing.description ?? "",
          discountFormat: editing.discountFormat ?? "%",
          percentage: editing.percentage ? String(editing.percentage) : "",
          flatAmount: editing.flatAmount != null ? String(editing.flatAmount) : "",
          startDate: dstr(editing.startDate),
          endDate: dstr(editing.endDate),
          active: editing.active,
        }
      : { ...EMPTY },
  );

  const [audience, setAudience] = useState<PromotionAudience>(() =>
    editing
      ? {
          allSubscribers: editing.allSubscribers,
          subscriberStatuses: [...editing.subscriberStatuses],
          subscriberIds: editing.subscribers.map((s) => s.id),
          planIds: editing.plans.map((x) => x.id),
          branchIds: editing.branches.map((b) => b.id),
          neighborhoodRefs: [...editing.neighborhoodRefs],
        }
      : { ...EMPTY_AUDIENCE },
  );

  const [nombres, setNombres] = useState<Map<string, PromotionSubscriber>>(
    () => new Map((editing?.subscribers ?? []).map((s) => [s.id, s])),
  );

  // Plantillas: solo sirven para arrancar una campaña nueva.
  const [plantillas, setPlantillas] = useState<PromotionTemplate[]>([]);
  const [usada, setUsada] = useState<string | null>(null);
  const [guardarPlantilla, setGuardarPlantilla] = useState(false);

  useEffect(() => {
    if (editing) return;
    void authFetch(`/promotions/templates`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setPlantillas(Array.isArray(d) ? d : []))
      .catch(() => setPlantillas([]));
  }, [authFetch, editing]);

  const { alcance, contando } = useAlcance(audience);

  const flat = isFlatDiscount(draft.discountFormat);
  const antes = draft.discountFormat === "b_p" || draft.discountFormat === "bflat";
  const valor = flat ? draft.flatAmount : draft.percentage;
  const sim = simularDescuento(draft.discountFormat, Number(draft.percentage), Number(draft.flatAmount));

  // Las mismas cuatro reglas de siempre, repartidas entre los pasos que las piden.
  const req = requisitosPromocion(draft, audience);
  const pasoOk = [req[0].ok && req[1].ok, req[2].ok, req[3].ok];
  const todoOk = pasoOk.every(Boolean);

  const set = (patch: Partial<PromotionDraft>) => setDraft((d) => ({ ...d, ...patch }));

  /** Los dos interruptores componen el `discountFormat` de cuatro valores del legacy. */
  function setFormato(esFijo: boolean, esAntes: boolean) {
    const fmt: DiscountFormat = esFijo ? (esAntes ? "bflat" : "flat") : (esAntes ? "b_p" : "%");
    // Al cambiar de porcentaje a pesos el número anterior deja de tener sentido.
    set({ discountFormat: fmt, ...(esFijo !== flat ? { percentage: "", flatAmount: "" } : {}) });
  }

  /** Volcar una plantilla en el borrador. El público NO se toca: es lo que cambia. */
  function aplicar(t: PromotionTemplate) {
    setUsada(t.id);
    set({
      name: t.name,
      description: t.description ?? "",
      discountFormat: t.discountFormat,
      percentage: t.percentage ? String(t.percentage) : "",
      flatAmount: t.flatAmount != null ? String(t.flatAmount) : "",
      startDate: dstr(t.startDate),
      endDate: dstr(t.endDate),
    });
  }

  async function borrarPlantilla(t: PromotionTemplate) {
    setPlantillas((prev) => prev.filter((x) => x.id !== t.id));
    if (usada === t.id) setUsada(null);
    const res = await authFetch(`/promotions/templates/${t.id}`, { method: "DELETE" });
    if (!res.ok) { toast("No se pudo eliminar la plantilla", "alert-circle"); return; }
    toast(`Plantilla «${t.name}» eliminada`, "check");
  }

  const guardar = useCallback(async () => {
    if (!todoOk || busy) return;
    setBusy(true);
    try {
      const body = JSON.stringify({
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        discountFormat: draft.discountFormat,
        percentage: flat ? undefined : Number(draft.percentage),
        flatAmount: flat ? Number(draft.flatAmount) : undefined,
        startDate: draft.startDate,
        endDate: draft.endDate,
        active: draft.active,
        ...audience,
        ...(editing ? {} : { saveAsTemplate: guardarPlantilla }),
      });
      const res = editing
        ? await authFetch(`/promotions/${editing.id}`, { method: "PUT", body })
        : await authFetch(`/promotions`, { method: "POST", body });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar");
      toast(editing ? "Promoción actualizada" : "Promoción creada", "check");
      onSaved();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setBusy(false);
    }
  }, [authFetch, audience, busy, draft, editing, flat, guardarPlantilla, onSaved, todoOk]);

  /**
   * Enter avanza al paso siguiente. NO crea la promoción desde el último paso: crear
   * es una acción con consecuencias (descuenta plata en facturas reales) y merece un
   * clic deliberado. Tampoco actúa dentro de un buscador, donde Enter es del propio
   * desplegable.
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter" || paso >= 2) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-buscador]") || t.tagName === "BUTTON" || t.tagName === "TEXTAREA") return;
    if (!pasoOk[paso]) return;
    e.preventDefault();
    setPaso((p) => p + 1);
  }

  const alcanzados = alcance?.count ?? 0;
  const presets = flat ? [5000, 10000, 20000] : [5, 10, 15, 20];

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? `Editar · ${editing.name}` : "Nueva promoción"}
      maxWidth="max-w-lg"
    >
      <Pasos
        actual={paso}
        onIr={setPaso}
        alcanzable={(i) => i <= paso || pasoOk.slice(0, i).every(Boolean)}
      />

      <div className="flex min-h-[18rem] flex-col gap-4" onKeyDown={onKeyDown}>
        {/* ── 1 · cuánto descuenta ─────────────────────────────── */}
        {paso === 0 && (
          <>
            <h3 className="text-[16.5px] font-semibold tracking-tight text-text-primary">
              ¿Cuánto descuenta y cómo se llama?
            </h3>

            {!editing && plantillas.length > 0 && (
              <div>
                <span className="mb-1 block text-[11px] font-semibold text-text-tertiary">
                  Empezar desde una plantilla
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {plantillas.map((t) => {
                    const activa = usada === t.id;
                    return (
                      <span key={t.id}
                        className={`inline-flex items-center rounded-full border transition-colors ${
                          activa ? "border-brand bg-brand-soft" : "border-border-subtle bg-surface hover:border-brand"
                        }`}>
                        <button type="button" onClick={() => aplicar(t)}
                          className={`tap rounded-l-full py-1 pl-3 pr-1.5 text-[11.5px] font-semibold ${
                            activa ? "text-brand" : "text-text-secondary"
                          }`}>
                          {t.name}
                          <span className="ml-1 font-normal opacity-70">{discountLabel(t)}</span>
                        </button>
                        <button type="button" onClick={() => void borrarPlantilla(t)}
                          aria-label={`Eliminar la plantilla ${t.name}`}
                          className="tap rounded-r-full py-1 pl-0.5 pr-2 text-text-tertiary hover:text-error-text">
                          <Icon name="x" size={11} />
                        </button>
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            <Field label="Nombre de la campaña">
              <Input value={draft.name} onChange={(e) => { set({ name: e.target.value }); setUsada(null); }}
                placeholder="Pronto pago agosto" autoComplete="off" />
            </Field>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <span className="mb-1 block text-[11px] font-semibold text-text-tertiary">Descuento en</span>
                <Segmented
                  ariaLabel="Forma del descuento"
                  className="w-full"
                  value={flat ? "flat" : "pct"}
                  onChange={(v) => setFormato(v === "flat", antes)}
                  options={[{ value: "pct", label: "Porcentaje" }, { value: "flat", label: "Pesos" }]}
                />
              </div>
              <div>
                <span className="mb-1 block text-[11px] font-semibold text-text-tertiary">Sobre el</span>
                <Segmented
                  ariaLabel="Base del descuento"
                  className="w-full"
                  value={antes ? "before" : "after"}
                  onChange={(v) => setFormato(flat, v === "before")}
                  options={[{ value: "after", label: "Total" }, { value: "before", label: "Subtotal" }]}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-32 shrink-0">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] font-semibold text-text-tertiary">
                  {flat ? "$" : "%"}
                </span>
                <Input
                  className="pl-7 font-mono text-[15px] font-semibold tabular-nums"
                  type="number" min={1} max={flat ? undefined : 100} inputMode="numeric"
                  aria-label={flat ? "Monto a descontar" : "Porcentaje a descontar"}
                  value={valor}
                  onChange={(e) => set(flat ? { flatAmount: e.target.value } : { percentage: e.target.value })}
                  placeholder={flat ? "10000" : "15"}
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {presets.map((v) => (
                  <button key={v} type="button"
                    onClick={() => set(flat ? { flatAmount: String(v) } : { percentage: String(v) })}
                    className="tap rounded-full border border-dashed border-border-default px-2.5 py-1 text-[11.5px] font-semibold text-text-secondary transition-colors hover:border-brand hover:bg-brand-soft hover:text-brand">
                    {flat ? cop(v) : `${v}%`}
                  </button>
                ))}
              </div>
            </div>

            <Eco>
              {sim
                ? <>En una factura de {cop(FACTURA_EJEMPLO.total)} el cliente pagaría <V>{cop(sim.paga)}</V></>
                : "Escribe el valor y aquí verás cuánto pagaría el cliente."}
            </Eco>
          </>
        )}

        {/* ── 2 · a quién le llega ─────────────────────────────── */}
        {paso === 1 && (
          <>
            <h3 className="text-[16.5px] font-semibold tracking-tight text-text-primary">
              ¿A qué clientes les llega?
            </h3>

            <PasoPublico
              value={audience}
              onChange={setAudience}
              catalogs={catalogs}
              nombres={nombres}
              onNombre={(s) => setNombres((prev) => new Map(prev).set(s.id, s))}
            />

            <Eco tono={req[2].ok && !contando && alcanzados === 0 ? "alerta" : "normal"}>
              {contando ? "Contando clientes…"
                : !req[2].ok ? "Elige una opción para ver a cuántos clientes alcanza."
                : alcanzados === 0 ? "Ningún cliente cumple esa condición: no aparecería en ninguna factura."
                : <>Alcanza a <V>{alcanzados.toLocaleString("es-CO")}</V> clientes</>}
            </Eco>
          </>
        )}

        {/* ── 3 · vigencia ─────────────────────────────────────── */}
        {paso === 2 && (
          <>
            <h3 className="text-[16.5px] font-semibold tracking-tight text-text-primary">
              ¿Entre qué fechas?
            </h3>

            <div className="flex flex-wrap gap-1.5">
              {rangosRapidos().map((r) => {
                const activo = draft.startDate === r.desde && draft.endDate === r.hasta;
                return (
                  <button key={r.label} type="button" aria-pressed={activo}
                    onClick={() => set({ startDate: r.desde, endDate: r.hasta })}
                    className={`tap rounded-full border px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
                      activo
                        ? "border-brand bg-brand-soft text-brand"
                        : "border-dashed border-border-default text-text-secondary hover:border-brand hover:bg-brand-soft hover:text-brand"
                    }`}>
                    {r.label}
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <Field label="Inicia">
                <Input type="date" value={draft.startDate} onChange={(e) => set({ startDate: e.target.value })} />
              </Field>
              <Field label="Finaliza" error={draft.endDate < draft.startDate ? "Anterior al inicio." : undefined}>
                <Input type="date" value={draft.endDate} onChange={(e) => set({ endDate: e.target.value })} />
              </Field>
            </div>

            <Interruptor
              checked={draft.active}
              onChange={(v) => set({ active: v })}
              title={draft.active ? "Activa" : "Inactiva"}
              detail={draft.active
                ? "Empieza a descontar dentro del rango."
                : "Se guarda, pero no descuenta nada."}
            />

            {!editing && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border-subtle bg-surface-2 p-2.5">
                <input type="checkbox" className="mt-0.5 accent-brand"
                  checked={guardarPlantilla} onChange={(e) => setGuardarPlantilla(e.target.checked)} />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-text-primary">Guardar también como plantilla</span>
                  <span className="block text-[11.5px] text-text-tertiary">
                    Reutiliza el nombre, el descuento y las fechas en la próxima campaña. No guarda a qué clientes iba.
                  </span>
                </span>
              </label>
            )}

            <Eco>
              <span className="text-text-primary">{draft.name.trim() || "La promoción"}</span>
              {" le descuenta "}
              <V>{flat ? cop(Number(draft.flatAmount)) : `${draft.percentage}%`}</V>
              {" a "}
              <V>{contando ? "…" : alcanzados.toLocaleString("es-CO")}</V>
              {" clientes, del "}{fecha(draft.startDate)}{" al "}{fecha(draft.endDate)}
              {sim ? <>. Pagarían <V>{cop(sim.paga)}</V> en vez de {cop(FACTURA_EJEMPLO.total)}.</> : "."}
            </Eco>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border-subtle pt-3">
        {paso > 0 && (
          <Button variant="secondary" onClick={() => setPaso((p) => p - 1)}>Atrás</Button>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          {paso < 2 ? (
            <Button onClick={() => setPaso((p) => p + 1)} disabled={!pasoOk[paso]}>Siguiente</Button>
          ) : (
            <Button onClick={() => void guardar()} disabled={busy || !todoOk}>
              {busy ? "Guardando…" : editing ? "Guardar cambios" : "Crear promoción"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
