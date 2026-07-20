"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";

const INSTALL_TYPES = ["FTTH", "EOC", "HFC", "Radioenlace", "Otro"];

type StockEq = { id: string; code: number; mac: string | null; serial: string | null; brand: string | null; installType: string | null; warehouse: string | null };

/** Modal para asignar un equipo (CPE) al cliente desde la orden. Puede tomar una unidad de stock. */
export function AsignarEquipoModal({ open, onClose, onDone, ticketId }: { open: boolean; onClose: () => void; onDone: () => void; ticketId: string }) {
  const { authFetch } = useAuth();
  const [mac, setMac] = useState("");
  const [installType, setInstallType] = useState(INSTALL_TYPES[0]);
  const [serial, setSerial] = useState("");
  const [port, setPort] = useState("");
  const [vlan, setVlan] = useState("");
  const [nat, setNat] = useState("");
  const [master, setMaster] = useState("");
  const [meters, setMeters] = useState("");
  const [accessories, setAccessories] = useState("");
  const [equipmentId, setEquipmentId] = useState("");
  const [stock, setStock] = useState<StockEq[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMac(""); setInstallType(INSTALL_TYPES[0]); setSerial(""); setPort(""); setVlan(""); setNat(""); setMaster(""); setMeters(""); setAccessories(""); setEquipmentId(""); setErr(null);
    void authFetch("/support/equipment/available").then((r) => r.json()).then(setStock).catch(() => setStock([]));
  }, [open, authFetch]);

  /** Al elegir una unidad de stock, pre-llena MAC/serial/tipo. */
  function pickStock(id: string) {
    setEquipmentId(id);
    const e = stock.find((x) => x.id === id);
    if (e) {
      if (e.mac) setMac(e.mac);
      if (e.serial) setSerial(e.serial);
      if (e.installType) setInstallType(e.installType);
    }
  }

  const isFTTH = installType === "FTTH";
  const isEOC = installType === "EOC";

  async function submit() {
    setErr(null);
    if (!mac.trim()) { setErr("Ingresa la MAC del equipo."); return; }
    if (isFTTH && (!port.trim() || !nat.trim())) { setErr("En FTTH indica puerto y caja NAT."); return; }
    if (isEOC && !master.trim()) { setErr("En EOC indica la master."); return; }
    setSaving(true);
    try {
      const body: any = { mac: mac.trim(), installType, equipmentId: equipmentId || undefined, serial: serial.trim() || undefined, master: master.trim() || undefined, accessories: accessories.trim() || undefined };
      if (port.trim()) body.port = Number(port);
      if (vlan.trim()) body.vlan = Number(vlan);
      if (nat.trim()) body.nat = Number(nat);
      if (meters.trim()) body.meters = Number(meters);
      const res = await authFetch(`/support/tickets/${ticketId}/equipment`, { method: "POST", body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo asignar el equipo");
      toast(`Equipo ${d.mac} asignado`);
      onDone(); onClose();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Asignar equipo" maxWidth="max-w-lg">
      <div className="flex flex-col gap-3">
        {stock.length > 0 && (
          <Field label="Tomar de inventario (opcional)">
            <Select value={equipmentId} onChange={(e) => pickStock(e.target.value)}>
              <option value="">— MAC manual (sin stock) —</option>
              {stock.map((e) => <option key={e.id} value={e.id}>{[e.mac || `Cod ${e.code}`, e.brand, e.warehouse].filter(Boolean).join(" · ")}</option>)}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="MAC" required><Input value={mac} onChange={(e) => setMac(e.target.value)} placeholder="AA:BB:CC:DD:EE:FF" className="font-mono" /></Field>
          <Field label="Tipo de instalación" required>
            <Select value={installType} onChange={(e) => setInstallType(e.target.value)}>{INSTALL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
          </Field>
          <Field label="Serial"><Input value={serial} onChange={(e) => setSerial(e.target.value)} className="font-mono" /></Field>
          {isEOC && <Field label="Master" required><Input value={master} onChange={(e) => setMaster(e.target.value)} /></Field>}
          {isFTTH && <Field label="Puerto NAT" required><Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" /></Field>}
          {isFTTH && <Field label="Caja NAT" required><Input value={nat} onChange={(e) => setNat(e.target.value)} inputMode="numeric" /></Field>}
          {isFTTH && <Field label="VLAN"><Input value={vlan} onChange={(e) => setVlan(e.target.value)} inputMode="numeric" /></Field>}
          <Field label="Metros de cable"><Input value={meters} onChange={(e) => setMeters(e.target.value)} inputMode="numeric" /></Field>
          <Field label="Accesorios"><Input value={accessories} onChange={(e) => setAccessories(e.target.value)} placeholder="Conectores, rosetas…" /></Field>
        </div>
        {err && <p className="text-[12px] text-error-text">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={submit} disabled={saving || !mac.trim()}>{saving ? "Asignando…" : "Asignar equipo"}</Button>
        </div>
      </div>
    </Modal>
  );
}
