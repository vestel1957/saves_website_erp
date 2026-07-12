"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/Icon";
import { Input, Select } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import type { Profile, ProvisionResult, OltRow } from "@/lib/olt";

type Preset = { sn?: string; frame?: number | string; slot?: number | string; port?: number | string };

/**
 * Wizard para AUTENTICAR (aprovisionar) una ONU en la OLT por SSH.
 * Refleja el modo del backend: en DRY-RUN muestra el plan de comandos sin tocar
 * el equipo; en LIVE ejecuta y devuelve el ONT-ID asignado.
 */
export function AutenticarOnuModal({
  open, onClose, oltId, olt, live, preset, onDone,
}: {
  open: boolean;
  onClose: () => void;
  oltId: string;
  olt?: OltRow | null;
  live: boolean;
  preset?: Preset;
  onDone?: () => void;
}) {
  const { authFetch } = useAuth();
  const [line, setLine] = useState<Profile[]>([]);
  const [srv, setSrv] = useState<Profile[]>([]);
  const [loadingProf, setLoadingProf] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProvisionResult | null>(null);

  const [form, setForm] = useState({
    sn: "", frame: "0", slot: "", port: "", ont_id: "",
    lineprofile: "", srvprofile: "", desc: "", vlan: "", gemport: "", user_vlan: "",
  });

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setForm((f) => ({
      ...f,
      sn: preset?.sn ?? "",
      frame: preset?.frame !== undefined ? String(preset.frame) : "0",
      slot: preset?.slot !== undefined ? String(preset.slot) : "",
      port: preset?.port !== undefined ? String(preset.port) : "",
      ont_id: "",
      lineprofile: olt?.defaults.lineProfile ? String(olt.defaults.lineProfile) : "",
      srvprofile: olt?.defaults.srvProfile ? String(olt.defaults.srvProfile) : "",
      vlan: olt?.defaults.vlan ? String(olt.defaults.vlan) : "",
      gemport: olt?.defaults.gemport ? String(olt.defaults.gemport) : "",
      user_vlan: olt?.defaults.userVlan ? String(olt.defaults.userVlan) : "",
    }));
    // Cargar perfiles del equipo (line/srv) para los selects.
    setLoadingProf(true);
    void authFetch(`/network/olt/${oltId}/profiles`)
      .then((r) => r.json())
      .then((d) => { setLine(d.line ?? []); setSrv(d.srv ?? []); })
      .catch(() => {})
      .finally(() => setLoadingProf(false));
  }, [open, oltId, preset, olt, authFetch]);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.sn.trim()) { toast("Indique el SN de la ONU", "x"); return; }
    if (form.slot === "" || form.port === "") { toast("Indique slot y puerto", "x"); return; }
    if (!form.lineprofile || !form.srvprofile) { toast("Seleccione line-profile y srv-profile", "x"); return; }
    setBusy(true);
    setResult(null);
    try {
      const r: ProvisionResult = await authFetch(`/network/olt/${oltId}/onu/provision`, {
        method: "POST",
        body: JSON.stringify({
          frame: Number(form.frame) || 0, slot: form.slot, port: form.port,
          ont_id: form.ont_id || undefined, sn: form.sn.trim(),
          lineprofile: form.lineprofile, srvprofile: form.srvprofile,
          desc: form.desc || undefined, vlan: form.vlan || undefined,
          gemport: form.gemport || undefined, user_vlan: form.user_vlan || undefined,
        }),
      }).then((x) => x.json());
      setResult(r);
      if (r.ok) { toast(r.dryRun ? "Plan generado (dry-run)" : "ONU autenticada", "check"); onDone?.(); }
      else { toast(r.error || "No se pudo autenticar", "x"); }
    } catch {
      toast("Error en la autenticación", "x");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Autenticar / aprovisionar ONU" maxWidth="max-w-2xl">
      <div className="flex items-center gap-2 text-[12px]">
        <Badge label={live ? "MODO LIVE" : "DRY-RUN"} tone={live ? "error" : "info"} />
        <span className="text-text-tertiary">
          {live ? "Se ejecutará contra la OLT real." : "No se contacta la OLT: se muestra el plan de comandos."}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label className="col-span-2 sm:col-span-3 text-[12px] text-text-secondary">
          Serial (SN)
          <Input value={form.sn} onChange={(e) => set("sn", e.target.value)} placeholder="48575443XXXXXXXX" className="mt-0.5 font-mono" />
        </label>
        <label className="text-[12px] text-text-secondary">Frame<Input value={form.frame} onChange={(e) => set("frame", e.target.value)} className="mt-0.5" /></label>
        <label className="text-[12px] text-text-secondary">Slot<Input value={form.slot} onChange={(e) => set("slot", e.target.value)} className="mt-0.5" /></label>
        <label className="text-[12px] text-text-secondary">Puerto<Input value={form.port} onChange={(e) => set("port", e.target.value)} className="mt-0.5" /></label>
        <label className="text-[12px] text-text-secondary">ONT-ID (opcional)<Input value={form.ont_id} onChange={(e) => set("ont_id", e.target.value)} placeholder="auto" className="mt-0.5" /></label>
        <label className="text-[12px] text-text-secondary">
          Line-profile
          <Select value={form.lineprofile} onChange={(e) => set("lineprofile", e.target.value)} className="mt-0.5">
            <option value="">{loadingProf ? "Cargando…" : "Seleccione…"}</option>
            {line.map((p) => <option key={p.id} value={p.id}>{p.id} · {p.name}</option>)}
          </Select>
        </label>
        <label className="text-[12px] text-text-secondary">
          Srv-profile
          <Select value={form.srvprofile} onChange={(e) => set("srvprofile", e.target.value)} className="mt-0.5">
            <option value="">{loadingProf ? "Cargando…" : "Seleccione…"}</option>
            {srv.map((p) => <option key={p.id} value={p.id}>{p.id} · {p.name}</option>)}
          </Select>
        </label>
        <label className="col-span-2 sm:col-span-3 text-[12px] text-text-secondary">Descripción<Input value={form.desc} onChange={(e) => set("desc", e.target.value)} placeholder="Nombre/abonado del cliente" className="mt-0.5" /></label>
        <label className="text-[12px] text-text-secondary">VLAN (opcional)<Input value={form.vlan} onChange={(e) => set("vlan", e.target.value)} className="mt-0.5" /></label>
        <label className="text-[12px] text-text-secondary">GEM-port (opcional)<Input value={form.gemport} onChange={(e) => set("gemport", e.target.value)} className="mt-0.5" /></label>
        <label className="text-[12px] text-text-secondary">User-VLAN (opcional)<Input value={form.user_vlan} onChange={(e) => set("user_vlan", e.target.value)} className="mt-0.5" /></label>
      </div>

      {loadingProf && !line.length && (
        <p className="text-[12px] text-text-tertiary">Cargando perfiles del equipo por SSH… (si la OLT no es alcanzable puede tardar/fallar; puede escribir los IDs a mano).</p>
      )}

      {result && (
        <div className={`rounded-lg border border-border-subtle p-3 text-[12px] ${result.ok ? "bg-surface-2" : "bg-error-soft"}`}>
          <div className="font-semibold text-text-primary">{result.ok ? (result.message ?? "OK") : (result.error ?? "Error")}</div>
          {result.ontId && <div className="mt-1">ONT-ID asignado: <span className="font-mono font-bold">{result.ontId}</span></div>}
          {result.commands?.length && (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-black/80 p-2 font-mono text-[11px] text-green-300">{result.commands.join("\n")}</pre>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cerrar</Button>
        <Button onClick={submit} disabled={busy}>
          <Icon name="wand-sparkles" size={15} className="mr-1" />
          {busy ? "Procesando…" : live ? "Autenticar ONU" : "Generar plan (dry-run)"}
        </Button>
      </div>
    </Modal>
  );
}
