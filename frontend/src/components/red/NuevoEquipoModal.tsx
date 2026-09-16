"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";

const MARCAS = ["Bestcom", "Huawei", "Cisco", "Mikrotik", "ZTE", "Ubiquiti", "TP-link", "V-sol", "Grandstream", "Otro"];
const ESTADOS = ["Disponible", "Bueno", "Malo", "Depurado"];

/**
 * Subir (dar de alta) equipos nuevos en una de las bodegas que se le pasan.
 *
 * Nació para Equipos disponibles de cada sede (2026-09-14): la bodega sólo se elige
 * entre las de esa sede. "Guardar y agregar otro" deja el formulario abierto con la
 * misma bodega, marca y estado, para cargar un lote uno tras otro. Usa el mismo
 * `POST /network/equipment` que Ingreso de equipo.
 */
export function NuevoEquipoModal({
  open, onClose, onCreated, bodegas,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
  bodegas: { id: string; name: string }[];
}) {
  const { authFetch } = useAuth();
  const [warehouseId, setWarehouseId] = useState("");
  const [brand, setBrand] = useState(MARCAS[0]);
  const [status, setStatus] = useState(ESTADOS[0]);
  const [mac, setMac] = useState("");
  const [serial, setSerial] = useState("");
  const [observation, setObservation] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [subidos, setSubidos] = useState<number[]>([]);

  useEffect(() => {
    if (!open) return;
    setWarehouseId(bodegas[0]?.id ?? "");
    setMac(""); setSerial(""); setObservation(""); setErr(null); setSubidos([]);
  }, [open, bodegas]);

  async function guardar(otro: boolean) {
    setErr(null);
    if (!warehouseId) { setErr("Selecciona una bodega."); return; }
    if (!mac.trim() && !serial.trim()) { setErr("Escribe al menos la MAC o el serial."); return; }
    setSaving(true);
    try {
      const res = await authFetch("/network/equipment", {
        method: "POST",
        body: JSON.stringify({ warehouseId, brand, status, mac: mac.trim() || undefined, serial: serial.trim() || undefined, observation: observation.trim() || undefined }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "No se pudo subir el equipo");
      toast(`Equipo #${d.code} subido`);
      onCreated?.();
      if (otro) {
        setSubidos((s) => [...s, d.code]);
        setMac(""); setSerial("");
      } else {
        onClose();
      }
    } catch (e) {
      setErr(mensajeDeError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Subir equipo nuevo">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Bodega" required>
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {bodegas.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </Field>
        <Field label="Estado"><Select value={status} onChange={(e) => setStatus(e.target.value)}>{ESTADOS.map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
        <Field label="Marca"><Select value={brand} onChange={(e) => setBrand(e.target.value)}>{MARCAS.map((b) => <option key={b} value={b}>{b}</option>)}</Select></Field>
        <Field label="MAC"><Input value={mac} onChange={(e) => setMac(e.target.value)} placeholder="AA:BB:CC:DD:EE:FF" /></Field>
        <div className="sm:col-span-2"><Field label="Serial"><Input value={serial} onChange={(e) => setSerial(e.target.value)} /></Field></div>
        <div className="sm:col-span-2"><Field label="Observación"><Textarea rows={2} maxLength={200} value={observation} onChange={(e) => setObservation(e.target.value)} /></Field></div>
      </div>
      {subidos.length > 0 && (
        <p className="text-[12px] text-success-text">Subidos en esta tanda: {subidos.map((c) => `#${c}`).join(", ")}</p>
      )}
      {err && <p className="text-[12px] text-error-text">{err}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>Cerrar</Button>
        <Button variant="secondary" size="sm" onClick={() => void guardar(true)} disabled={saving}>Guardar y agregar otro</Button>
        <Button size="sm" onClick={() => void guardar(false)} disabled={saving}>{saving ? "Subiendo…" : "Guardar"}</Button>
      </div>
    </Modal>
  );
}
