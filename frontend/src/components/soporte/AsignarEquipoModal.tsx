"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { listaJson, mensajeDeError } from "@/lib/errores";

const INSTALL_TYPES = ["FTTH", "EOC", "HFC", "Radioenlace", "Otro"];

type StockEq = { id: string; code: number; mac: string | null; serial: string | null; brand: string | null; installType: string | null; warehouse: string | null };

/** Un equipo del formulario. `uid` es sólo para React: no viaja al backend. */
type Eq = {
  uid: number;
  mac: string; installType: string; serial: string;
  port: string; vlan: string; nat: string; master: string;
  meters: string; accessories: string; equipmentId: string;
};

let contador = 0;
const equipoVacio = (): Eq => ({
  uid: ++contador,
  mac: "", installType: INSTALL_TYPES[0], serial: "",
  port: "", vlan: "", nat: "", master: "", meters: "", accessories: "", equipmentId: "",
});

/**
 * Modal para asignar equipos (CPE) al cliente desde la orden.
 *
 * Acepta VARIOS de una (2026-08-26). Antes era un solo formulario y una
 * instalación corriente —ONT más decodificador— obligaba a abrirlo, guardar y
 * volver a abrirlo por cada aparato. Cada equipo es una tarjeta plegable: la que
 * se está llenando queda abierta y las terminadas se recogen en una línea con su
 * MAC, que es lo que se necesita ver para saber qué se lleva registrado.
 *
 * Todo viaja en un envío (`items`), y el backend lo escribe en una transacción:
 * si el segundo equipo choca, no queda el primero asignado a medias.
 */
export function AsignarEquipoModal({ open, onClose, onDone, ticketId }: { open: boolean; onClose: () => void; onDone: () => void; ticketId: string }) {
  const { authFetch } = useAuth();
  const [equipos, setEquipos] = useState<Eq[]>([equipoVacio()]);
  const [abierto, setAbierto] = useState<number>(0);
  const [stock, setStock] = useState<StockEq[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const inicial = equipoVacio();
    setEquipos([inicial]); setAbierto(inicial.uid); setErr(null);
    void authFetch("/support/equipment/available").then(listaJson).then(setStock).catch(() => setStock([]));
  }, [open, authFetch]);

  const set = (uid: number, campo: keyof Eq, valor: string) =>
    setEquipos((prev) => prev.map((e) => (e.uid === uid ? { ...e, [campo]: valor } : e)));

  /** Al elegir una unidad de stock, pre-llena MAC/serial/tipo de esa tarjeta. */
  const pickStock = (uid: number, id: string) => {
    const e = stock.find((x) => x.id === id);
    setEquipos((prev) => prev.map((q) => (q.uid !== uid ? q : {
      ...q, equipmentId: id,
      mac: e?.mac || q.mac, serial: e?.serial || q.serial, installType: e?.installType || q.installType,
    })));
  };

  const añadir = () => {
    const nuevo = equipoVacio();
    setEquipos((prev) => [...prev, nuevo]);
    setAbierto(nuevo.uid);
    setErr(null);
  };
  const quitar = (uid: number) => {
    setEquipos((prev) => {
      const next = prev.filter((e) => e.uid !== uid);
      return next.length ? next : [equipoVacio()];
    });
  };

  // Una unidad de inventario no se puede entregar dos veces en el mismo acto.
  const stockTomado = useMemo(
    () => new Map(equipos.filter((e) => e.equipmentId).map((e) => [e.equipmentId, e.uid])),
    [equipos],
  );

  /** Devuelve el problema de un equipo, o null si está completo. */
  const problema = (e: Eq): string | null => {
    if (!e.mac.trim()) return "Ingresa la MAC del equipo.";
    if (e.installType === "FTTH" && (!e.port.trim() || !e.nat.trim())) return "En FTTH indica puerto y caja NAT.";
    if (e.installType === "EOC" && !e.master.trim()) return "En EOC indica la master.";
    return null;
  };

  const listos = equipos.filter((e) => !problema(e)).length;

  async function submit() {
    setErr(null);
    // El primero que falle se abre: corregir a ciegas una tarjeta plegada no se puede.
    for (const e of equipos) {
      const p = problema(e);
      if (p) { setAbierto(e.uid); setErr(`Equipo ${equipos.indexOf(e) + 1}: ${p}`); return; }
    }
    const macs = equipos.map((e) => e.mac.trim().toLowerCase());
    const repetida = macs.find((m, i) => macs.indexOf(m) !== i);
    if (repetida) { setErr(`La MAC ${repetida.toUpperCase()} está dos veces en la lista.`); return; }

    setSaving(true);
    try {
      const items = equipos.map((e) => {
        const it: Record<string, unknown> = {
          mac: e.mac.trim(), installType: e.installType,
          equipmentId: e.equipmentId || undefined,
          serial: e.serial.trim() || undefined,
          master: e.master.trim() || undefined,
          accessories: e.accessories.trim() || undefined,
        };
        if (e.port.trim()) it.port = Number(e.port);
        if (e.vlan.trim()) it.vlan = Number(e.vlan);
        if (e.nat.trim()) it.nat = Number(e.nat);
        if (e.meters.trim()) it.meters = Number(e.meters);
        return it;
      });
      const res = await authFetch(`/support/tickets/${ticketId}/equipment`, { method: "POST", body: JSON.stringify({ items }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo asignar el equipo");
      toast(items.length > 1 ? `${d.total ?? items.length} equipos asignados` : `Equipo ${d.mac} asignado`);
      onDone(); onClose();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={equipos.length > 1 ? `Asignar equipos (${equipos.length})` : "Asignar equipo"} maxWidth="max-w-2xl">
      <div className="flex flex-col gap-3">
        {equipos.map((e, i) => {
          const expandido = abierto === e.uid;
          const isFTTH = e.installType === "FTTH";
          const isEOC = e.installType === "EOC";
          const incompleto = problema(e);
          const disponibles = stock.filter((s) => !stockTomado.has(s.id) || stockTomado.get(s.id) === e.uid);
          return (
            <div key={e.uid} className="rounded-xl border border-border-subtle bg-surface">
              {/* Cabecera: plegar/desplegar y quitar */}
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button" onClick={() => setAbierto(expandido ? 0 : e.uid)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  aria-expanded={expandido}
                >
                  <Icon name={expandido ? "chevron-down" : "chevron-right"} size={14} className="shrink-0 text-text-tertiary" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold text-text-primary">
                      {e.mac.trim() ? e.mac.trim().toUpperCase() : `Equipo ${i + 1}`}
                    </span>
                    <span className="block text-[11px] text-text-tertiary">
                      {e.installType}
                      {e.serial.trim() ? ` · ${e.serial.trim()}` : ""}
                      {e.equipmentId ? " · de inventario" : ""}
                    </span>
                  </span>
                </button>
                {incompleto
                  ? <Icon name="alert-triangle" size={14} className="shrink-0 text-warning-text" />
                  : <Icon name="check" size={14} className="shrink-0 text-success-text" />}
                {equipos.length > 1 && (
                  <button
                    type="button" onClick={() => quitar(e.uid)} title="Quitar este equipo"
                    className="shrink-0 rounded-lg p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-error-text"
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </div>

              {expandido && (
                <div className="flex flex-col gap-3 border-t border-border-subtle px-3 py-3">
                  {disponibles.length > 0 && (
                    <Field label="Tomar de inventario (opcional)">
                      <Select value={e.equipmentId} onChange={(ev) => pickStock(e.uid, ev.target.value)}>
                        <option value="">— MAC manual (sin stock) —</option>
                        {disponibles.map((s) => (
                          <option key={s.id} value={s.id}>{[s.mac || `Cod ${s.code}`, s.brand, s.warehouse].filter(Boolean).join(" · ")}</option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="MAC" required>
                      <Input value={e.mac} onChange={(ev) => set(e.uid, "mac", ev.target.value)} placeholder="AA:BB:CC:DD:EE:FF" className="font-mono" />
                    </Field>
                    <Field label="Tipo de instalación" required>
                      <Select value={e.installType} onChange={(ev) => set(e.uid, "installType", ev.target.value)}>
                        {INSTALL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </Select>
                    </Field>
                    <Field label="Serial"><Input value={e.serial} onChange={(ev) => set(e.uid, "serial", ev.target.value)} className="font-mono" /></Field>
                    {isEOC && <Field label="Master" required><Input value={e.master} onChange={(ev) => set(e.uid, "master", ev.target.value)} /></Field>}
                    {isFTTH && <Field label="Puerto NAT" required><Input value={e.port} onChange={(ev) => set(e.uid, "port", ev.target.value)} inputMode="numeric" /></Field>}
                    {isFTTH && <Field label="Caja NAT" required><Input value={e.nat} onChange={(ev) => set(e.uid, "nat", ev.target.value)} inputMode="numeric" /></Field>}
                    {isFTTH && <Field label="VLAN"><Input value={e.vlan} onChange={(ev) => set(e.uid, "vlan", ev.target.value)} inputMode="numeric" /></Field>}
                    <Field label="Metros de cable"><Input value={e.meters} onChange={(ev) => set(e.uid, "meters", ev.target.value)} inputMode="numeric" /></Field>
                    <Field label="Accesorios"><Input value={e.accessories} onChange={(ev) => set(e.uid, "accessories", ev.target.value)} placeholder="Conectores, rosetas…" /></Field>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <div>
          <Button variant="secondary" size="sm" onClick={añadir} disabled={saving}>
            <Icon name="plus" size={14} /> Añadir otro equipo
          </Button>
        </div>

        {err && <p className="text-[12px] text-error-text">{err}</p>}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {equipos.length > 1 && (
            <span className="mr-auto text-[11px] text-text-tertiary">{listos} de {equipos.length} listos</span>
          )}
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={submit} disabled={saving || listos === 0}>
            {saving ? "Asignando…" : equipos.length > 1 ? `Asignar ${equipos.length} equipos` : "Asignar equipo"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
