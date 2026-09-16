"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { fullCurrency } from "@/lib/format";
import { Segmented } from "@/components/ui/Segmented";
import { type Bundle, type Plan, type ChangePlanResult, type ServiceKind, SERVICE_KIND_LABEL } from "@/lib/plans";

type SubService = { kind: ServiceKind | string; planName?: string | null; price?: number; qty?: number };

/** Orden en que se muestran los servicios en el modal. */
const KIND_ORDER: ServiceKind[] = ["INTERNET", "TV", "PUNTOS", "STREAMING"];

/** Valor del selector que significa "ya no contrata este servicio" (el "No" del legacy). */
const QUITAR = "__quitar__";

/**
 * Cambia los planes de un abonado desde el catálogo. Internet y TV se manejan
 * por separado: hay un selector por cada servicio y se pueden cambiar juntos o
 * uno solo. El nuevo precio manda la facturación mensual (no reprecia facturas
 * ya emitidas) y el perfil del plan se empuja al router (dry-run salvo LIVE).
 */
export function CambiarPlanModal({
  subscriberId,
  services = [],
  open,
  onClose,
  onDone,
}: {
  subscriberId: string;
  services?: SubService[];
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { authFetch } = useAuth();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [bundles, setBundles] = useState<Bundle[]>([]);
  /**
   * Selección por kind: kind → planId elegido ("" = mantener el actual, QUITAR = el
   * cliente deja de tener ese servicio; es la opción "No" del selector del legacy).
   */
  const [sel, setSel] = useState<Record<string, string>>({});
  /**
   * Se vende de dos maneras. Arranca en "sueltos" —lo de siempre— para no
   * cambiarle el gesto a quien lleva meses cambiando planes de a uno.
   */
  const [modo, setModo] = useState<"sueltos" | "combo">("sueltos");
  const [comboSel, setComboSel] = useState("");
  /**
   * Puntos de TV: aquí no se elige plan sino CUÁNTOS televisores extra tiene.
   * `null` = no se tocan (es lo que se envía si nadie lo mueve).
   */
  const [puntos, setPuntos] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ChangePlanResult[] | null>(null);
  /** Servicios dados de baja en la última aplicación (para el resumen del final). */
  const [bajas, setBajas] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setResults(null);
    setBajas([]);
    setSel({});
    setModo("sueltos");
    setComboSel("");
    setPuntos(null);
    void authFetch(`/plans?activeOnly=true`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setPlans)
      .catch(() => setPlans([]));
    void authFetch(`/plan-bundles?activeOnly=true`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setBundles(Array.isArray(d) ? d : []))
      .catch(() => setBundles([]));
  }, [open, authFetch]);

  // Planes agrupados por kind, respetando el orden de KIND_ORDER.
  const byKind = useMemo(() => {
    const map = new Map<string, Plan[]>();
    for (const p of plans ?? []) {
      if (!map.has(p.kind)) map.set(p.kind, []);
      map.get(p.kind)!.push(p);
    }
    // Un servicio que el abonado YA tiene sale aunque el catálogo no tenga ningún plan
    // activo de ese tipo (la mayoría del catálogo está oculta): si no, no habría por
    // dónde quitárselo. Queda con su lista vacía y sólo la opción de darlo de baja.
    const suyos = new Set(services.map((s) => s.kind));
    // PUNTOS se saca del selector: no se elige un plan, se dice cuántos son.
    return KIND_ORDER
      .filter((k) => k !== "PUNTOS" && (map.has(k) || suyos.has(k)))
      .map((k) => ({ kind: k, plans: map.get(k) ?? [] }));
  }, [plans, services]);

  const currentByKind = useMemo(() => {
    const m: Record<string, string | null | undefined> = {};
    for (const s of services) m[s.kind] = s.planName;
    return m;
  }, [services]);

  /**
   * Qué servicios tiene HOY contratados. Va aparte del nombre del plan porque hay
   * fichas heredadas del legacy con el servicio puesto y el nombre vacío, y a ésas
   * también hay que poder quitárselo.
   */
  const tieneByKind = useMemo(() => {
    const m: Record<string, boolean> = {};
    for (const s of services) m[s.kind] = true;
    return m;
  }, [services]);

  const chosenIds = Object.values(sel).filter((v) => v && v !== QUITAR);
  // Los servicios que se dan de baja. Sólo tiene sentido quitar lo que hoy tiene.
  const quitados = Object.entries(sel).filter(([, v]) => v === QUITAR).map(([k]) => k);
  const combo = bundles.find((b) => b.id === comboSel) ?? null;
  const puntosPlan = (plans ?? []).find((p) => p.kind === "PUNTOS") ?? null;
  const suPunto = services.find((x) => x.kind === "PUNTOS");
  const puntosActuales = suPunto?.qty ?? 0;
  // Respeta la tarifa negociada del abonado (hay comerciales por encima del
  // precio de lista); solo cae al catálogo cuando todavía no tiene puntos.
  const precioPunto = suPunto?.price ?? puntosPlan?.price ?? 0;
  const puntosCambian = puntos !== null && puntos !== puntosActuales;
  const puedeAplicar = modo === "combo" ? Boolean(combo) : chosenIds.length > 0 || quitados.length > 0 || puntosCambian;

  async function apply() {
    if (!puedeAplicar) return;
    setBusy(true);
    try {
      // Vender un combo no es mandar sus planes por la ruta de siempre: el
      // precio del paquete lo pone el backend a partir del combo, no la pantalla.
      // Los puntos van por su propia ruta: es una cantidad sobre el servicio de
      // TV, no un plan del catálogo, y se puede cambiar sin tocar ningún plan.
      if (modo === "sueltos" && puntosCambian) {
        const rp = await authFetch(`/subscribers/${subscriberId}/puntos`, {
          method: "POST",
          body: JSON.stringify({ qty: puntos }),
        });
        if (!rp.ok) {
          const msg = await rp.json().catch(() => null);
          throw new Error(msg?.message || "No se pudo cambiar la cantidad de puntos");
        }
      }

      let results: ChangePlanResult[] = [];
      if (modo === "combo" || chosenIds.length > 0 || quitados.length > 0) {
        const res = modo === "combo"
          ? await authFetch(`/subscribers/${subscriberId}/bundle`, {
              method: "POST",
              body: JSON.stringify({ bundleId: comboSel }),
            })
          : await authFetch(`/subscribers/${subscriberId}/plans`, {
              method: "POST",
              // `remove` viaja en la misma llamada que los cambios: quitarle la TV y
              // subirle el internet es UN solo movimiento para quien atiende.
              body: JSON.stringify({ planIds: chosenIds, remove: quitados }),
            });
        if (!res.ok) {
          const msg = await res.json().catch(() => null);
          throw new Error(msg?.message || "No se pudieron cambiar los planes");
        }
        const data: { ok: boolean; results: ChangePlanResult[] } = await res.json();
        results = data.results ?? [];
      }
      setResults(results);
      setBajas(quitados);
      toast(
        modo === "combo" ? `Combo “${combo?.name}” aplicado`
          : chosenIds.length === 0 && quitados.length === 0 ? `Puntos de TV: ${puntos}`
          : quitados.length > 0 && chosenIds.length === 0
            ? `Servicio dado de baja: ${quitados.map((k) => SERVICE_KIND_LABEL[k as ServiceKind] ?? k).join(", ")}`
            : "Planes actualizados",
        "check",
      );
      onDone?.();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Cambiar planes del abonado">
      {/* Resultado (tras aplicar) */}
      {results ? (
        <div className="flex flex-col gap-3">
          {bajas.map((kind) => (
            <div key={`baja-${kind}`} className="rounded-lg border border-border-subtle bg-surface-2 p-3">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold text-text-primary">
                  {SERVICE_KIND_LABEL[kind as ServiceKind] ?? kind}
                </span>
                <Badge tone="warning" label="DADO DE BAJA" />
              </div>
              <p className="mt-1 text-[11px] text-text-tertiary">Ya no lo tiene contratado; deja de cobrarse.</p>
            </div>
          ))}
          {results.map((result, idx) => (
            <div key={idx} className="rounded-lg border border-border-subtle bg-surface-2 p-3">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold text-text-primary">{result.plan.name}</span>
                <span className="text-[14px] font-bold text-text-primary">{fullCurrency(result.plan.price)}/mes</span>
              </div>
              {result.router && (
                <div className="mt-2 flex items-center gap-2">
                  <Icon name="router" size={14} />
                  <span className="text-[11px] font-semibold text-text-secondary">Router</span>
                  <Badge
                    tone={result.router.dryRun ? "warning" : result.router.ok ? "success" : "error"}
                    label={result.router.dryRun ? "DRY-RUN" : result.router.ok ? "APLICADO" : "ERROR"}
                  />
                  <span className="truncate text-[11px] text-text-tertiary">{result.router.message}</span>
                </div>
              )}
            </div>
          ))}
          <p className="text-[12px] text-text-tertiary">
            Los nuevos valores se facturan desde la próxima facturación mensual. Las facturas ya emitidas no cambian.
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Listo</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {!plans && <p className="text-[12px] text-text-tertiary">Cargando planes…</p>}

          {plans && byKind.length === 0 && (
            <p className="text-[12px] text-text-tertiary">
              No hay planes en el catálogo. Créalos en Configuración → Planes.
            </p>
          )}

          {/* El selector solo aparece si de verdad hay algo que vender en combo. */}
          {bundles.length > 0 && (
            <Segmented
              ariaLabel="Forma de venta"
              value={modo}
              onChange={setModo}
              options={[
                { value: "sueltos", label: "Planes sueltos" },
                { value: "combo", label: `Combos (${bundles.length})` },
              ]}
            />
          )}

          {modo === "combo" && (
            <div className="flex flex-col gap-2">
              <Select value={comboSel} onChange={(e) => setComboSel(e.target.value)}>
                <option value="">— Elige un combo —</option>
                {bundles.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} — {fullCurrency(b.total)}/mes
                  </option>
                ))}
              </Select>
              {combo && (
                <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
                  {combo.description && <p className="mb-1.5 text-[12px] text-text-tertiary">{combo.description}</p>}
                  {combo.items.map((it) => (
                    <div key={it.planId} className="flex items-baseline justify-between gap-2 text-[12.5px]">
                      <span className="truncate text-text-secondary">
                        <span className="text-text-tertiary">{SERVICE_KIND_LABEL[it.kind]}:</span> {it.planName}
                      </span>
                      <span className="shrink-0 font-mono text-text-primary">{fullCurrency(it.price)}</span>
                    </div>
                  ))}
                  <div className="mt-1.5 flex items-baseline justify-between border-t border-border-subtle pt-1.5">
                    <span className="text-[13px] font-semibold text-text-primary">Total</span>
                    <span className="font-mono text-[14px] font-bold text-text-primary">{fullCurrency(combo.total)}/mes</span>
                  </div>
                  {combo.savings > 0 && (
                    <p className="mt-1 text-right text-[11.5px] font-semibold text-success-text">
                      Ahorra {fullCurrency(combo.savings)}/mes contra {fullCurrency(combo.listTotal)} por separado
                    </p>
                  )}
                  <p className="mt-1.5 text-[11px] text-text-tertiary">
                    Se le cambian {combo.items.length} servicio(s) de una vez, cada uno al precio del combo.
                  </p>
                </div>
              )}
            </div>
          )}

          {modo === "sueltos" && byKind.map(({ kind, plans: kindPlans }) => {
            const current = currentByKind[kind];
            const selected = kindPlans.find((p) => p.id === sel[kind]) ?? null;
            return (
              <div key={kind} className="rounded-lg border border-border-subtle p-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[13px] font-semibold text-text-primary">{SERVICE_KIND_LABEL[kind]}</span>
                  <span className="text-[11px] text-text-tertiary">
                    Actual: <span className="font-medium text-text-secondary">{current || "sin plan"}</span>
                  </span>
                </div>
                <Select value={sel[kind] ?? ""} onChange={(e) => setSel((s) => ({ ...s, [kind]: e.target.value }))}>
                  <option value="">— Mantener actual —</option>
                  {kindPlans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {fullCurrency(p.price)}/mes{p.pppProfile ? ` (${p.pppProfile})` : ""}
                    </option>
                  ))}
                  {/* La opción "No" del legacy: se ofrece sólo si hoy tiene el servicio,
                      porque quitar lo que no tiene no significa nada. */}
                  {tieneByKind[kind] && <option value={QUITAR}>No — quitarle {SERVICE_KIND_LABEL[kind].toLowerCase()}</option>}
                </Select>
                {sel[kind] === QUITAR && (
                  <p className="mt-1.5 text-[11px] text-warning-text">
                    Deja de tener {SERVICE_KIND_LABEL[kind].toLowerCase()}: no se le cobra desde la próxima
                    facturación mensual. No toca los equipos ni el router
                    {kind === "INTERNET" ? " — para dar de baja el servicio abre una orden de retiro." : "."}
                  </p>
                )}
                {selected && (
                  <p className="mt-1.5 text-[11px] text-text-tertiary">
                    {selected.pppProfile
                      ? `Se empuja el perfil "${selected.pppProfile}" al router (dry-run si el backend no está en LIVE).`
                      : "Este plan no tiene perfil de router; solo actualiza la mensualidad."}
                  </p>
                )}
              </div>
            );
          })}

          {/* Puntos de TV: televisores extra en la misma casa. Es una cantidad
              sobre el servicio de televisión —no un plan— y por eso se pide con
              un contador y no con un desplegable. */}
          {modo === "sueltos" && puntosPlan && (
            <div className="rounded-lg border border-border-subtle p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[13px] font-semibold text-text-primary">{SERVICE_KIND_LABEL.PUNTOS}</span>
                <span className="text-[11px] text-text-tertiary">
                  Actual: <span className="font-medium text-text-secondary">{puntosActuales}</span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setPuntos(Math.max(0, (puntos ?? puntosActuales) - 1))}
                  disabled={(puntos ?? puntosActuales) <= 0}
                  aria-label="Quitar un punto"
                >
                  <Icon name="minus" size={15} />
                </Button>
                <input
                  type="number"
                  min={0}
                  max={200}
                  value={puntos ?? puntosActuales}
                  onChange={(e) => setPuntos(Math.max(0, Math.min(200, Number(e.target.value) || 0)))}
                  className="w-16 rounded-md border border-border-subtle bg-surface px-2 py-1 text-center text-[13px] text-text-primary"
                />
                <Button
                  variant="secondary"
                  onClick={() => setPuntos(Math.min(200, (puntos ?? puntosActuales) + 1))}
                  disabled={(puntos ?? puntosActuales) >= 200}
                  aria-label="Agregar un punto"
                >
                  <Icon name="plus" size={15} />
                </Button>
                <span className="text-[11px] text-text-tertiary">
                  televisor(es) extra · {fullCurrency(precioPunto)} c/u
                </span>
              </div>
              {puntosCambian && (
                <p className="mt-1.5 text-[11px] text-text-tertiary">
                  {puntos === 0
                    ? "Se le quitan los puntos: dejan de cobrarse en la próxima factura."
                    : `Suma ${fullCurrency(precioPunto * (puntos ?? 0))}/mes a partir de la próxima factura.`}
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-text-tertiary">
              {modo === "combo"
                ? combo ? `${combo.items.length} servicio(s) por cambiar.` : "Elige un combo."
                : chosenIds.length === 0 && quitados.length === 0 ? "Elige al menos un servicio a cambiar."
                : [
                    chosenIds.length ? `${chosenIds.length} servicio(s) por cambiar` : null,
                    quitados.length ? `${quitados.length} por quitar` : null,
                  ].filter(Boolean).join(" · ") + "."}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={onClose}>Cancelar</Button>
              <Button onClick={apply} disabled={!puedeAplicar || busy}>
                {busy ? "Aplicando…" : modo === "combo" ? "Aplicar combo" : "Cambiar planes"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
