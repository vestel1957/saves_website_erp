"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Select, Textarea, Field } from "@/components/ui/Field";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { listaJson, mensajeDeError } from "@/lib/errores";
import { esCajera } from "@/lib/treasury";

type Bodega = { id: string; name: string; branchLegacy: number | null; branchName: string | null };

/** "Yopal · Almacen cabecera Yopal" — la sede va delante porque es lo que decide todo. */
export function etiquetaBodega(w: { name: string; branchName?: string | null }): string {
  return w.branchName ? `${w.branchName} · ${w.name}` : `${w.name} (sin sede)`;
}

/**
 * Solicitar una transferencia (traspaso) de equipos entre bodegas.
 *
 * Salió de la pantalla de Transferencias (2026-09-14) para usarse también desde
 * Equipos disponibles de cada sede. `sedeOrigen` limita la bodega ORIGEN a las de
 * esa sede; el destino puede ser cualquiera. Las reglas no cambian: entre sedes
 * sólo el encargado de bodega, con firma de salida y de entrada, y el backend lo
 * revalida en `createTransfer`.
 */
export function NuevaTransferenciaModal({
  open, onClose, onCreated, sedeOrigen,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
  sedeOrigen?: number;
}) {
  const { authFetch, can, user } = useAuth();
  // Mandar equipo de una sede a OTRA es solo del encargado de bodega (2026-07-30).
  // La cajera trae `inventory.admin` desde 2026-09-17 pero sigue en su sede (espejo
  // de `esJefeDeBodega` en `network/bodega-scope.ts`).
  const canEntreSedes = can("inventory.admin") && !esCajera(user);

  const [warehouses, setWarehouses] = useState<Bodega[]>([]);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [observations, setObservations] = useState("");
  const [equipment, setEquipment] = useState<any[]>([]);
  const [loadingEquip, setLoadingEquip] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const origenes = useMemo(
    () => (sedeOrigen == null ? warehouses : warehouses.filter((w) => w.branchLegacy === sedeOrigen)),
    [warehouses, sedeOrigen],
  );

  // Cada apertura empieza limpia (y con la primera bodega de la sede, si viene acotada).
  useEffect(() => {
    if (!open) return;
    setToId("");
    setObservations("");
    setSelected({});
    void authFetch("/network/warehouses")
      .then(listaJson<Bodega>)
      .then((lista) => {
        setWarehouses(lista);
        const propias = sedeOrigen == null ? [] : lista.filter((w) => w.branchLegacy === sedeOrigen);
        setFromId(propias.length === 1 ? propias[0].id : "");
      })
      .catch(() => setWarehouses([]));
  }, [open, sedeOrigen, authFetch]);

  // Cargar equipos de la bodega origen
  useEffect(() => {
    if (!fromId) {
      setEquipment([]);
      setSelected({});
      return;
    }
    setLoadingEquip(true);
    setSelected({});
    const qs = new URLSearchParams({ warehouseId: fromId, pageSize: "100" });
    void authFetch(`/network/equipment?${qs}`)
      .then((r) => r.json())
      .then((d: any) => setEquipment(d?.items ?? []))
      .catch(() => setEquipment([]))
      .finally(() => setLoadingEquip(false));
  }, [fromId, authFetch]);

  const selectedIds = useMemo(() => Object.keys(selected).filter((k) => selected[k]), [selected]);

  // La sede manda: dice quién puede crear la transferencia y quién la firma.
  const sedeDe = useCallback((whId: string): string | null => warehouses.find((w) => w.id === whId)?.branchName ?? null, [warehouses]);
  const cruzaSedes = useMemo(() => {
    if (!fromId || !toId) return false;
    const a = warehouses.find((w) => w.id === fromId);
    const b = warehouses.find((w) => w.id === toId);
    return !!a && !!b && (a.branchLegacy ?? null) !== (b.branchLegacy ?? null);
  }, [fromId, toId, warehouses]);

  const submit = useCallback(async () => {
    if (!fromId || !toId) { toast("Selecciona bodega origen y destino", "alert-triangle"); return; }
    if (fromId === toId) { toast("La bodega origen y destino deben ser distintas", "alert-triangle"); return; }
    if (selectedIds.length === 0) { toast("Selecciona al menos un equipo", "alert-triangle"); return; }
    setSaving(true);
    try {
      const res = await authFetch("/network/transfers", {
        method: "POST",
        body: JSON.stringify({ fromWarehouseId: fromId, toWarehouseId: toId, observations: observations.trim() || undefined, equipmentIds: selectedIds }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(
        `Solicitud enviada (${d?.count ?? selectedIds.length} equipos) · ${
          cruzaSedes ? `pendiente de la firma de salida en ${sedeDe(fromId)}` : "pendiente de aprobación"
        }`,
      );
      onClose();
      onCreated?.();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo crear la transferencia"), "alert-triangle");
    } finally {
      setSaving(false);
    }
  }, [fromId, toId, observations, selectedIds, cruzaSedes, sedeDe, authFetch, onClose, onCreated]);

  return (
    <Modal open={open} onClose={onClose} title="Nueva transferencia de equipos" maxWidth="max-w-2xl">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Bodega origen" required hint={sedeDe(fromId) ?? undefined}>
          <Select value={fromId} onChange={(e) => setFromId(e.target.value)}>
            <option value="">Selecciona…</option>
            {origenes.map((w) => <option key={w.id} value={w.id}>{etiquetaBodega(w)}</option>)}
          </Select>
        </Field>
        <Field label="Bodega destino" required hint={sedeDe(toId) ?? undefined}>
          <Select value={toId} onChange={(e) => setToId(e.target.value)}>
            <option value="">Selecciona…</option>
            {warehouses.map((w) => <option key={w.id} value={w.id} disabled={w.id === fromId}>{etiquetaBodega(w)}</option>)}
          </Select>
        </Field>
      </div>

      {sedeOrigen != null && origenes.length === 0 && warehouses.length > 0 && (
        <div className="rounded-lg bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
          Esta sede no tiene bodegas de equipos a tu alcance, así que no hay desde dónde traspasar.
        </div>
      )}

      {/* Entre sedes solo el encargado de bodega, y con firma en las dos puntas. */}
      {cruzaSedes && (
        <div className={`rounded-lg px-3 py-2 text-[12px] ${canEntreSedes ? "bg-info-soft text-info-text" : "bg-error-soft text-error-text"}`}>
          {canEntreSedes ? (
            <>
              Va de <strong>{sedeDe(fromId)}</strong> a <strong>{sedeDe(toId)}</strong>: el equipo no sale hasta que la
              cajera encargada de {sedeDe(fromId)} <strong>firme la salida</strong> con su código, y entra cuando quien
              recibe en {sedeDe(toId)} firme la entrada.
            </>
          ) : (
            <>
              Estás mandando equipo de <strong>{sedeDe(fromId)}</strong> a <strong>{sedeDe(toId)}</strong>, y eso solo lo
              puede hacer el <strong>encargado de bodega</strong>. Dentro de tu sede sí puedes moverlo.
            </>
          )}
        </div>
      )}

      <Field
        label="Equipos a transferir"
        hint={fromId ? `${selectedIds.length} seleccionados de ${equipment.length}` : "Selecciona primero la bodega origen"}
        required
      >
        <div className="max-h-64 overflow-y-auto rounded-lg border border-border-default bg-surface">
          {!fromId ? (
            <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">Elige una bodega origen para ver sus equipos.</div>
          ) : loadingEquip ? (
            <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">Cargando equipos…</div>
          ) : equipment.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">Esta bodega no tiene equipos disponibles.</div>
          ) : (
            equipment.map((eq: any) => (
              <label key={eq.id} className="flex cursor-pointer items-center gap-3 border-b border-border-subtle px-3 py-2 last:border-0 hover:bg-surface-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-brand"
                  checked={!!selected[eq.id]}
                  onChange={(e) => setSelected((s) => ({ ...s, [eq.id]: e.target.checked }))}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[13px]">
                    <span className="font-mono font-medium text-text-primary">{eq.code}</span>
                    {eq.brand && <span className="text-text-tertiary">{eq.brand}</span>}
                  </span>
                  <span className="flex flex-wrap gap-x-3 text-[11px] text-text-tertiary">
                    {eq.mac && <span className="font-mono">MAC {eq.mac}</span>}
                    {eq.serial && <span className="font-mono">S/N {eq.serial}</span>}
                  </span>
                </span>
              </label>
            ))
          )}
        </div>
      </Field>

      <Field label="Observaciones">
        <Textarea rows={2} placeholder="Notas de la transferencia (opcional)…" value={observations} onChange={(e) => setObservations(e.target.value)} />
      </Field>

      <div className="mt-1 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>Cancelar</Button>
        <Button
          variant="primary"
          size="sm"
          disabled={saving || !fromId || !toId || fromId === toId || selectedIds.length === 0 || (cruzaSedes && !canEntreSedes)}
          onClick={submit}
        >
          <Icon name="check" size={13} /> {saving ? "Creando…" : "Crear transferencia"}
        </Button>
      </div>
    </Modal>
  );
}
