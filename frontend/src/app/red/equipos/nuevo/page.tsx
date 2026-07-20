"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { EquipmentLabelModal, type LabelEquip } from "@/components/red/EquipmentLabelModal";
import { useAuth } from "@/context/AuthProvider";

const BRANDS = ["Bestcom", "Huawei", "Cisco", "Mikrotik", "ZTE", "Ubiquiti", "TP-link", "V-sol", "Grandstream", "Otro"];
const STATES = ["Disponible", "Bueno", "Malo", "Depurado"];

export default function IngresoEquipoPage() {
  const { authFetch } = useAuth();
  const router = useRouter();
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [warehouseId, setWarehouseId] = useState("");
  const [mac, setMac] = useState("");
  const [serial, setSerial] = useState("");
  const [brand, setBrand] = useState(BRANDS[0]);
  const [status, setStatus] = useState(STATES[0]);
  const [observation, setObservation] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<LabelEquip | null>(null);

  useEffect(() => {
    void authFetch("/network/warehouses").then((r) => r.json()).then((w: any[]) => { setWarehouses(w); if (w.length) setWarehouseId(w[0].id); }).catch(() => {});
  }, [authFetch]);

  async function submit() {
    setErr(null);
    if (!warehouseId) { setErr("Selecciona una bodega."); return; }
    setSaving(true);
    try {
      const res = await authFetch("/network/equipment", { method: "POST", body: JSON.stringify({ warehouseId, mac: mac || undefined, serial: serial || undefined, brand, status, observation: observation || undefined }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo ingresar el equipo");
      toast(`Equipo #${d.code} ingresado`);
      // Muestra la etiqueta QR para imprimir de inmediato; al cerrar vuelve a la lista.
      setCreated({ code: d.code, brand, mac: mac || null, serial: serial || null });
      setSaving(false);
    } catch (e: any) { setErr(e.message); setSaving(false); }
  }

  return (
    <>
      <PageHeading icon="boxes" title="Ingreso de equipo" subtitle="Alta de un equipo en bodega" />

      <EquipmentLabelModal
        open={!!created}
        onClose={() => { setCreated(null); router.push("/red/equipos"); }}
        equip={created}
        title="Equipo ingresado · imprime su etiqueta"
      />

      <div className="mt-4 max-w-xl rounded-xl border border-border-subtle bg-surface p-5 shadow-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Bodega" required><Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
          <Field label="Estado"><Select value={status} onChange={(e) => setStatus(e.target.value)}>{STATES.map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
          <Field label="Marca"><Select value={brand} onChange={(e) => setBrand(e.target.value)}>{BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}</Select></Field>
          <Field label="MAC"><Input value={mac} onChange={(e) => setMac(e.target.value)} placeholder="AA:BB:CC:DD:EE:FF" /></Field>
          <Field label="Serial"><Input value={serial} onChange={(e) => setSerial(e.target.value)} /></Field>
          <div className="sm:col-span-2"><Field label="Observación"><Textarea rows={2} value={observation} onChange={(e) => setObservation(e.target.value)} /></Field></div>
        </div>
        {err && <p className="mt-2 text-[12px] text-error-text">{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Link href="/red/equipos"><Button variant="secondary">Cancelar</Button></Link>
          <Button onClick={submit} disabled={saving}>{saving ? "Ingresando…" : "Ingresar equipo"}</Button>
        </div>
      </div>
    </>
  );
}
