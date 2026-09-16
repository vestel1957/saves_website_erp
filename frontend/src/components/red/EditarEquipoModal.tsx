"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { can, PERM } from "@/lib/auth";
import { mensajeDeError } from "@/lib/errores";

/** Lo mínimo que la pantalla sabe del equipo para abrir el editor. */
export type EquipoEditable = {
  id: string; code: number; brand: string | null; mac: string | null; serial: string | null;
  status: string | null; observation?: string | null; warehouse: string | null;
};

const MARCAS = ["Bestcom", "Huawei", "Cisco", "Mikrotik", "ZTE", "Ubiquiti", "TP-link", "V-sol", "Grandstream", "Otro"];
/** Los que se pueden elegir a mano. "Asignado"/"Reservado" los ponen la asignación y la reserva. */
const ESTADOS = ["Disponible", "Bueno", "Malo", "Depurado"];

/** ¿Puede este usuario editar equipos? Administración o el jefe de bodega (el superusuario pasa solo). */
export function puedeEditarEquipos(user: Parameters<typeof can>[0]) {
  return can(user, ["area.administracion", PERM.INV_ADMIN]);
}

/**
 * Editar un equipo desde Administrar equipos y desde la vista de una bodega
 * (2026-09-14). Corrige lo que se tecleó al darlo de alta: marca, MAC, serial,
 * estado y observación.
 *
 * La BODEGA no se edita aquí a propósito: mover un equipo de bodega es una
 * transferencia, que entre sedes lleva firma de salida y de entrada. Cambiarla con
 * un campo se saltaría esa cadena de custodia.
 */
export function EditarEquipoModal({ equipo, onClose, onSaved }: { equipo: EquipoEditable | null; onClose: () => void; onSaved: () => void }) {
  const { authFetch } = useAuth();
  const [brand, setBrand] = useState("");
  const [mac, setMac] = useState("");
  const [serial, setSerial] = useState("");
  const [status, setStatus] = useState("");
  const [observation, setObservation] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!equipo) return;
    setBrand(equipo.brand ?? "");
    setMac(equipo.mac ?? "");
    setSerial(equipo.serial ?? "");
    setStatus(equipo.status ?? "");
    setObservation(equipo.observation ?? "");
    setErr(null);
    setSaving(false);
  }, [equipo]);

  if (!equipo) return null;

  const reservado = (equipo.status ?? "").toLowerCase() === "reservado";
  // La marca y el estado actuales se ofrecen aunque no estén en la lista (datos del legacy).
  const marcas = brand && !MARCAS.includes(brand) ? [brand, ...MARCAS] : MARCAS;
  const estados = equipo.status && !ESTADOS.includes(equipo.status) ? [equipo.status, ...ESTADOS] : ESTADOS;

  async function guardar() {
    if (!equipo) return;
    setErr(null);
    setSaving(true);
    try {
      const res = await authFetch(`/network/equipment/${equipo.id}`, {
        method: "PATCH",
        body: JSON.stringify({ brand, mac, serial, status, observation }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "No se pudo guardar el equipo");
      toast(d?.cambios === 0
        ? `Equipo #${equipo.code} sin cambios`
        : d?.soltado
          ? `Equipo #${equipo.code} actualizado y liberado del cliente que lo tenía`
          : `Equipo #${equipo.code} actualizado`);
      onSaved();
      onClose();
    } catch (e) {
      setErr(mensajeDeError(e));
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Editar equipo #${equipo.code}`}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Marca">
          <Select value={brand} onChange={(e) => setBrand(e.target.value)}>
            {!brand && <option value="">—</option>}
            {marcas.map((b) => <option key={b} value={b}>{b}</option>)}
          </Select>
        </Field>
        <Field label="Estado">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} disabled={reservado}>
            {!status && <option value="">—</option>}
            {estados.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
        <Field label="MAC"><Input value={mac} onChange={(e) => setMac(e.target.value)} placeholder="AA:BB:CC:DD:EE:FF" /></Field>
        <Field label="Serial"><Input value={serial} onChange={(e) => setSerial(e.target.value)} /></Field>
        <div className="sm:col-span-2"><Field label="Observación"><Textarea rows={2} maxLength={200} value={observation} onChange={(e) => setObservation(e.target.value)} /></Field></div>
      </div>
      <p className="text-[12px] text-text-tertiary">
        Bodega: <span className="font-medium text-text-secondary">{equipo.warehouse ?? "—"}</span>. Para cambiarla, haz una transferencia.
        {reservado && " El estado no se cambia mientras el equipo esté reservado para una orden."}
      </p>
      {err && <p className="text-[12px] text-error-text">{err}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button onClick={guardar} disabled={saving}>{saving ? "Guardando…" : "Guardar cambios"}</Button>
      </div>
    </Modal>
  );
}
