"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { TabStrip } from "@/components/ui/TabStrip";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

/**
 * Nuevo traspaso de material, en pantalla propia y con dos modos (2026-07-30).
 *
 * Antes era un modal con dos selectores de bodega y un desplegable libre de
 * "¿quién recibe?", lo que obligaba a saberse de memoria qué bodega es el almacén
 * de qué técnico y permitía designar a cualquiera. Ahora se elige el modo:
 *
 *  · A TÉCNICO   — se escoge la persona, no su bodega. Es lo que hace la cajera.
 *  · ENTRE BODEGAS — el movimiento clásico de almacén, sólo para bodega/admin.
 *
 * Quién recibe NO se elige: es el técnico, o el encargado de la bodega destino.
 * Todo lo que se puede ver y hacer lo decide el backend (`/inventory/transfer/context`)
 * y lo vuelve a validar al emitir; aquí no hay reglas de negocio duplicadas.
 */

type Modo = "tecnico" | "bodega";

type Bodega = {
  id: string; title: string; extra: string | null;
  isTechnician: boolean; managerId: string | null; managerName: string | null; materials: number;
};

type Tecnico = {
  warehouseId: string; warehouseTitle: string; technicianRef: string | null;
  name: string | null; linked: boolean; retired: boolean; userId: string | null;
  sedes: number[]; sedeNames: string[]; materials: number;
};

type Contexto = {
  restricted: boolean;
  canWarehouseMode: boolean;
  onlyConsumable: boolean;
  mySedeNames: string[];
  warehouses: Bodega[];
  originWarehouses: Bodega[];
  technicians: Tecnico[];
  retiredTechnicians: number;
  retiredMaterials: number;
};

type Material = { id: string; name: string; code: string | null; qty: number; price: number };

export default function NuevoTraspasoPage() {
  const router = useRouter();
  const { loading: authLoading, authFetch } = useAuth();

  const [ctx, setCtx] = useState<Contexto | null>(null);
  const [modo, setModo] = useState<Modo>("tecnico");
  const [fromWarehouseId, setFromWarehouseId] = useState("");
  const [toWarehouseId, setToWarehouseId] = useState("");
  const [observations, setObservations] = useState("");

  const [materials, setMaterials] = useState<Material[]>([]);
  const [loadingMaterials, setLoadingMaterials] = useState(false);
  const [matFilter, setMatFilter] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    void (async () => {
      try {
        setCtx(await (await authFetch("/inventory/transfer/context")).json());
      } catch (e) {
        toast(mensajeDeError(e, "No se pudo cargar el formulario de traspaso"), "alert-triangle");
      }
    })();
  }, [authLoading, authFetch]);

  const loadMaterials = useCallback(async (whId: string) => {
    if (!whId || !ctx) { setMaterials([]); setSelected({}); return; }
    setLoadingMaterials(true);
    try {
      const qs = new URLSearchParams({ warehouseId: whId, pageSize: "100" });
      // A la cajera sólo se le ofrece consumible; el backend lo exige igual al emitir.
      if (ctx.onlyConsumable) qs.set("onlyConsumable", "1");
      const d = await (await authFetch(`/inventory/materials?${qs}`)).json();
      setMaterials(d?.items ?? []);
      setSelected({});
    } finally {
      setLoadingMaterials(false);
    }
  }, [authFetch, ctx]);

  // Cambiar de modo invalida el destino (son listas distintas) pero conserva el
  // origen y lo ya marcado: es normal dudar entre entregarlo o moverlo de bodega.
  const cambiarModo = (m: Modo) => { setModo(m); setToWarehouseId(""); };

  const onFromChange = (v: string) => {
    setFromWarehouseId(v);
    setMatFilter("");
    void loadMaterials(v);
  };

  const toggle = (m: Material, checked: boolean) => {
    setSelected((s) => {
      const next = { ...s };
      if (checked) next[m.id] = String(m.qty ?? 0); // por defecto, mueve todo lo disponible
      else delete next[m.id];
      return next;
    });
  };

  const setQty = (m: Material, val: string) => {
    const max = Number(m.qty ?? 0);
    let n = Number(val);
    if (Number.isNaN(n) || n < 0) n = 0;
    if (n > max) n = max;
    setSelected((s) => ({ ...s, [m.id]: val === "" ? "" : String(n) }));
  };

  // Bodegas ofrecidas como origen: en modo técnico sólo las generales (no se saca
  // material del almacén personal de otro técnico para dárselo a un tercero).
  const origenes = useMemo(
    () => (!ctx ? [] : modo === "tecnico" ? ctx.originWarehouses : ctx.warehouses),
    [ctx, modo],
  );

  // El técnico elegido, o la bodega destino: de ahí sale quién firma la recepción.
  const tecnicoElegido = useMemo(
    () => ctx?.technicians.find((t) => t.warehouseId === toWarehouseId) ?? null,
    [ctx, toWarehouseId],
  );
  const bodegaDestino = useMemo(
    () => ctx?.warehouses.find((w) => w.id === toWarehouseId) ?? null,
    [ctx, toWarehouseId],
  );
  const recibe = useMemo(() => {
    if (modo === "tecnico") return tecnicoElegido ? { nombre: tecnicoElegido.name, rol: "Técnico" } : null;
    return bodegaDestino?.managerName ? { nombre: bodegaDestino.managerName, rol: "Encargado de la bodega" } : null;
  }, [modo, tecnicoElegido, bodegaDestino]);

  const shownMaterials = useMemo(() => {
    const q = matFilter.trim().toLowerCase();
    if (!q) return materials;
    return materials.filter((m) => `${m.name} ${m.code ?? ""}`.toLowerCase().includes(q));
  }, [materials, matFilter]);

  const summary = useMemo(() => {
    let items = 0, units = 0, value = 0;
    for (const m of materials) {
      const q = Number(selected[m.id]);
      if (selected[m.id] !== undefined && q > 0) { items += 1; units += q; value += q * Number(m.price ?? 0); }
    }
    return { items, units, value };
  }, [materials, selected]);

  const submit = async () => {
    if (!fromWarehouseId) { toast("Selecciona la bodega de donde sale el material"); return; }
    if (!toWarehouseId) { toast(modo === "tecnico" ? "Selecciona el técnico que recibe" : "Selecciona la bodega destino"); return; }
    if (fromWarehouseId === toWarehouseId) { toast("El origen y el destino no pueden ser el mismo"); return; }
    const items = Object.entries(selected).filter(([, q]) => Number(q) > 0).map(([materialId, q]) => ({ materialId, qty: Number(q) }));
    if (items.length === 0) { toast("Agrega al menos un ítem con cantidad"); return; }
    setSubmitting(true);
    try {
      const res = await authFetch("/inventory/transfer", {
        method: "POST",
        body: JSON.stringify({ fromWarehouseId, toWarehouseId, observations: observations || undefined, items }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(`Traspaso emitido · ${d?.items ?? items.length} ítem(s) en tránsito`, "check");
      router.push("/inventario/traspasos");
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo realizar el traspaso"), "alert-triangle");
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading || !ctx) return <PageSkeleton />;

  const tabs = [
    { key: "tecnico" as Modo, label: "A técnico", icon: "user", count: ctx.technicians.length },
    ...(ctx.canWarehouseMode ? [{ key: "bodega" as Modo, label: "Entre bodegas", icon: "warehouse", count: ctx.warehouses.length }] : []),
  ];

  return (
    <>
      <PageHeading
        icon="receipt"
        title="Nuevo traspaso"
        subtitle={modo === "tecnico" ? "Entrega de material a un técnico" : "Movimiento de material entre bodegas"}
        showBack
      />

      {/* Con un solo modo disponible (caja) la tira sobra: se dice en texto. */}
      {tabs.length > 1
        ? <TabStrip tabs={tabs} active={modo} onChange={cambiarModo} className="mb-4" />
        : (
          <p className="mb-4 flex flex-wrap items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-text-secondary">
            <Icon name="info" size={14} className="text-text-tertiary" />
            Entregas material <strong>consumible</strong> a los técnicos de {ctx.mySedeNames.length ? <strong>{ctx.mySedeNames.join(", ")}</strong> : "tu sede"}.
          </p>
        )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* ── Columna izquierda: qué se mueve ───────────────────────────────── */}
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Sale de la bodega" required>
              <Select value={fromWarehouseId} onChange={(e) => onFromChange(e.target.value)}>
                <option value="">Seleccionar…</option>
                {origenes.map((w) => (
                  <option key={w.id} value={w.id} disabled={w.id === toWarehouseId}>
                    {w.title}{w.isTechnician ? " · almacén de técnico" : ""}
                  </option>
                ))}
              </Select>
            </Field>

            {modo === "tecnico" ? (
              <Field label="Se le entrega a" required hint={ctx.restricted ? "Técnicos de tu sede" : undefined}>
                <Select value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)}>
                  <option value="">Seleccionar técnico…</option>
                  {ctx.technicians.map((t) => (
                    <option key={t.warehouseId} value={t.warehouseId} disabled={t.warehouseId === fromWarehouseId}>
                      {t.name ?? t.warehouseTitle}{t.linked ? "" : " · sin empleado vinculado"}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="Entra a la bodega" required>
                <Select value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)}>
                  <option value="">Seleccionar…</option>
                  {ctx.warehouses.map((w) => (
                    <option key={w.id} value={w.id} disabled={w.id === fromWarehouseId}>
                      {w.title}{w.isTechnician ? " · almacén de técnico" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>

          {/* Los almacenes de ex-técnicos no se ofrecen, pero su material existe:
              decirlo evita que la lista corta parezca completa. */}
          {modo === "tecnico" && ctx.retiredTechnicians > 0 && (
            <p className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-text-secondary">
              <Icon name="info" size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
              <span>
                No se listan {ctx.retiredTechnicians} almacenes de técnicos que ya no trabajan aquí
                {ctx.retiredMaterials > 0 && <> (guardan {ctx.retiredMaterials} materiales)</>}.
                {ctx.canWarehouseMode && " Su material se recupera desde “Entre bodegas”."}
              </span>
            </p>
          )}

          {ctx.technicians.length === 0 && modo === "tecnico" && (
            <p className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
              <Icon name="alert-triangle" size={14} className="mt-0.5 shrink-0" />
              No hay técnicos disponibles{ctx.restricted ? " en tu sede" : ""}. Cada técnico necesita su bodega en Bodegas de material.
            </p>
          )}

          {/* Selector de material de la bodega origen */}
          <div>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-text-tertiary">
                Material{ctx.onlyConsumable && " consumible"}
              </span>
              {fromWarehouseId && materials.length > 0 && (
                <div className="relative w-full max-w-[240px] sm:w-56">
                  <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
                  <Input className="h-8 pl-8 text-[12px]" placeholder="Filtrar material…" value={matFilter} onChange={(e) => setMatFilter(e.target.value)} />
                </div>
              )}
            </div>
            {!fromWarehouseId ? (
              <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-6 text-center text-[13px] text-text-tertiary">
                Selecciona la bodega de origen para ver su material.
              </div>
            ) : loadingMaterials ? (
              <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-6 text-center text-[13px] text-text-tertiary">
                Cargando material…
              </div>
            ) : materials.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-6 text-center text-[13px] text-text-tertiary">
                {ctx.onlyConsumable ? "Esta bodega no tiene material consumible disponible." : "La bodega no tiene material disponible."}
              </div>
            ) : (
              <div className="max-h-[420px] overflow-auto rounded-xl border border-border-subtle">
                {shownMaterials.length === 0 ? (
                  <div className="p-6 text-center text-[13px] text-text-tertiary">Ningún material coincide con “{matFilter}”.</div>
                ) : shownMaterials.map((m) => {
                  const checked = selected[m.id] !== undefined;
                  return (
                    <div key={m.id} className={`flex items-center gap-3 border-b border-border-subtle px-3 py-2 last:border-0 ${checked ? "bg-brand-soft/40" : ""}`}>
                      <input type="checkbox" checked={checked} onChange={(e) => toggle(m, e.target.checked)} className="h-4 w-4 shrink-0 accent-brand" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-text-primary">{m.name}</div>
                        <div className="text-[11px] text-text-tertiary">{m.code || "—"} · Disp: {m.qty ?? 0} · {cop(m.price ?? 0)}</div>
                      </div>
                      <div className="w-24 shrink-0">
                        <Input
                          type="number" min={0} max={Number(m.qty ?? 0)} disabled={!checked}
                          value={checked ? (selected[m.id] ?? "") : ""}
                          onChange={(e) => setQty(m, e.target.value)} placeholder="Cant."
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Columna derecha: quién recibe, resumen y emitir ───────────────── */}
        <div className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-xl border border-border-subtle bg-surface p-3">
            <span className="mb-2 block text-[11px] font-semibold text-text-tertiary">Recibe y firma el acta</span>
            {recibe ? (
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                  <Icon name="user" size={15} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold text-text-primary">{recibe.nombre}</span>
                  <span className="block text-[11px] text-text-tertiary">{recibe.rol}</span>
                </span>
              </div>
            ) : !toWarehouseId ? (
              <p className="text-[12px] text-text-tertiary">Elige el destino para ver quién debe recibirlo.</p>
            ) : (
              // Sin designado el acta la puede recibir cualquiera con acceso: es el
              // comportamiento histórico, pero conviene avisarlo y que lo arreglen.
              <p className="flex items-start gap-2 text-[12px] text-warning-text">
                <Icon name="alert-triangle" size={14} className="mt-0.5 shrink-0" />
                {modo !== "tecnico"
                  ? "Esta bodega no tiene encargado. Asígnaselo en Bodegas de material para que quede firmada la recepción."
                  : tecnicoElegido && !tecnicoElegido.linked
                    ? "Este almacén apunta a un usuario que ya no existe, así que nadie queda designado para firmar. Habría que revincularlo."
                    : "Este técnico no tiene un usuario activo en el sistema, así que no puede firmar el acta él mismo."}
              </p>
            )}
          </div>

          {tecnicoElegido?.sedeNames?.length ? (
            <div className="flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-text-tertiary">
              <Icon name="map-pin" size={12} />
              {tecnicoElegido.sedeNames.map((s) => <Badge key={s} label={s} tone="default" />)}
            </div>
          ) : null}

          <div className="rounded-xl border border-border-subtle bg-surface p-3">
            <span className="mb-2 block text-[11px] font-semibold text-text-tertiary">A traspasar</span>
            <dl className="flex flex-col gap-1 text-[12px]">
              <div className="flex justify-between"><dt className="text-text-tertiary">Ítems</dt><dd className="font-semibold text-text-primary">{summary.items}</dd></div>
              <div className="flex justify-between"><dt className="text-text-tertiary">Unidades</dt><dd className="font-semibold text-text-primary">{summary.units}</dd></div>
              <div className="flex justify-between border-t border-border-subtle pt-1"><dt className="text-text-tertiary">Valor</dt><dd className="font-bold text-text-primary">{cop(summary.value)}</dd></div>
            </dl>
          </div>

          <Field label="Observaciones">
            <Textarea rows={3} value={observations} onChange={(e) => setObservations(e.target.value)} placeholder="Notas del traspaso…" />
          </Field>

          <p className="text-[11px] text-text-tertiary">
            El material sale del origen y queda <strong>en tránsito</strong> hasta que {recibe?.nombre ?? "el destino"} confirme la recepción.
          </p>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => router.push("/inventario/traspasos")} disabled={submitting}>Cancelar</Button>
            <Button variant="primary" size="md" onClick={submit} disabled={submitting || summary.items === 0} className="flex-1">
              <Icon name="check" size={14} />{submitting ? "Procesando…" : "Emitir traspaso"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
