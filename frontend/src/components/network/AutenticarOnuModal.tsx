"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/Icon";
import { Input, Select } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { trafficLabel } from "@/lib/olt";
import type { Profile, ProvisionResult, OltRow, TrafficTable } from "@/lib/olt";

type Preset = { sn?: string; frame?: number | string; slot?: number | string; port?: number | string; model?: string };

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
  const [tablas, setTablas] = useState<TrafficTable[]>([]);
  const [loadingProf, setLoadingProf] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProvisionResult | null>(null);

  const [form, setForm] = useState({
    // GEM-port por defecto 1: en esta planta todas las ONUs de internet usan 1
    // (solo cambiaría con servicios múltiples TV/voz). Igual que SmartOLT, que
    // no lo pregunta. La sugerencia del puerto lo sobreescribe si hace falta.
    sn: "", frame: "0", slot: "", port: "",
    lineprofile: "", srvprofile: "", desc: "", vlan: "", gemport: "1", user_vlan: "",
    traffic_in: "", traffic_out: "",
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
      lineprofile: olt?.defaults.lineProfile ? String(olt.defaults.lineProfile) : "",
      srvprofile: olt?.defaults.srvProfile ? String(olt.defaults.srvProfile) : "",
      vlan: olt?.defaults.vlan ? String(olt.defaults.vlan) : "",
      gemport: olt?.defaults.gemport ? String(olt.defaults.gemport) : "1",
      user_vlan: olt?.defaults.userVlan ? String(olt.defaults.userVlan) : "",
    }));
    // Cargar perfiles del equipo (line/srv) para los selects.
    setLoadingProf(true);
    void Promise.all([
      authFetch(`/network/olt/${oltId}/profiles`).then((r) => r.json()),
      authFetch(`/network/olt/${oltId}/traffic-tables`).then((r) => r.json()),
    ])
      .then(([p, t]) => { setLine(p.line ?? []); setSrv(p.srv ?? []); setTablas(t.tables ?? []); })
      .catch(() => {})
      .finally(() => setLoadingProf(false));
  }, [open, oltId, preset, olt, authFetch]);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  /**
   * Al tener slot+puerto, preguntar a la OLT cómo están dados de alta los
   * abonados que ya cuelgan de ahí y precargar con eso. Evita que el técnico
   * tenga que saberse la VLAN y el perfil de cada puerto de memoria.
   */
  const [sugerencia, setSugerencia] = useState<{ basadoEn: number } | null>(null);
  useEffect(() => {
    if (!open || form.slot === "" || form.port === "") { setSugerencia(null); return; }
    let vigente = true;
    // Debounce: slot/puerto se teclean a mano y cada consulta de sugerencia es
    // una sesión SSH real contra la OLT. Se espera a que el usuario termine de
    // escribir en vez de disparar una consulta por tecla.
    const timer = setTimeout(() => {
      const qModel = preset?.model ? `&model=${encodeURIComponent(preset.model)}` : "";
      void authFetch(`/network/olt/${oltId}/sugerencia?frame=${Number(form.frame) || 0}&slot=${form.slot}&port=${form.port}${qModel}`)
        .then((r) => r.json())
        .then((d) => {
          if (!vigente || !d?.sugerencia?.basadoEn) return;
          const s = d.sugerencia;
          setSugerencia(s);
          // Solo rellena lo que el usuario aún no tocó: nunca pisa una elección suya.
          setForm((f) => ({
            ...f,
            vlan: f.vlan || (s.vlan ?? ""),
            user_vlan: f.user_vlan || (s.user_vlan ?? ""),
            gemport: f.gemport || (s.gemport ?? ""),
            traffic_in: f.traffic_in || (s.traffic_in ?? ""),
            traffic_out: f.traffic_out || (s.traffic_out ?? ""),
            lineprofile: f.lineprofile || (s.lineprofile ?? ""),
            // El srv-profile que casa con el MODELO de la ONU: sin esto, un
            // genérico deja la config en "failed" y el abonado sin internet.
            srvprofile: f.srvprofile || (s.srvprofile ?? ""),
          }));
        })
        .catch(() => {});
    }, 500);
    return () => { vigente = false; clearTimeout(timer); };
  }, [open, oltId, form.frame, form.slot, form.port, authFetch]);

  const submit = async () => {
    if (!form.sn.trim()) { toast("Indique el SN de la ONU", "x"); return; }
    if (form.slot === "" || form.port === "") { toast("Indique slot y puerto", "x"); return; }
    if (!form.lineprofile || !form.srvprofile) { toast("Seleccione line-profile y srv-profile", "x"); return; }
    // Sin VLAN + GEM-port no se crea el service-port y la ONU queda registrada
    // pero sin servicio. Antes se enviaba igual y el alta parecía correcta.
    if (!form.vlan || !form.gemport) {
      toast("Falta VLAN y GEM-port: sin ellos la ONU queda sin servicio", "x");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const r: ProvisionResult = await authFetch(`/network/olt/${oltId}/onu/provision`, {
        method: "POST",
        body: JSON.stringify({
          // Sin ont_id: lo asigna la propia OLT (primer hueco libre del puerto).
          frame: Number(form.frame) || 0, slot: form.slot, port: form.port,
          sn: form.sn.trim(),
          lineprofile: form.lineprofile, srvprofile: form.srvprofile,
          desc: form.desc || undefined, vlan: form.vlan || undefined,
          gemport: form.gemport || undefined, user_vlan: form.user_vlan || undefined,
          traffic_in: form.traffic_in || undefined, traffic_out: form.traffic_out || undefined,
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

      {/* Velocidad = tablas de tráfico del service-port. Sin esto la ONU queda
          sin tope explícito, que es lo que pasaba antes de este cambio. */}
      <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
        <div className="mb-2 flex items-center gap-2">
          <Icon name="gauge" size={14} className="text-brand" />
          <span className="text-[13px] font-semibold text-text-primary">Velocidad del abonado</span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-[12px] text-text-secondary">
            Subida (outbound / TX)
            <Select value={form.traffic_out} onChange={(e) => set("traffic_out", e.target.value)} className="mt-0.5">
              <option value="">{loadingProf ? "Cargando…" : "Sin límite"}</option>
              {tablas.map((t) => <option key={t.id} value={t.id}>{trafficLabel(t)}</option>)}
            </Select>
          </label>
          <label className="text-[12px] text-text-secondary">
            Bajada (inbound / RX)
            <Select value={form.traffic_in} onChange={(e) => set("traffic_in", e.target.value)} className="mt-0.5">
              <option value="">{loadingProf ? "Cargando…" : "Sin límite"}</option>
              {tablas.map((t) => <option key={t.id} value={t.id}>{trafficLabel(t)}</option>)}
            </Select>
          </label>
        </div>
        <p className="mt-2 text-[11.5px] text-text-tertiary">
          Se leen de la propia OLT. Si los deja vacíos la ONU queda <b>sin tope de velocidad</b>.
          Requiere indicar VLAN y GEM-port para que se cree el service-port.
        </p>
      </div>

      {loadingProf && !line.length && (
        <p className="text-[12px] text-text-tertiary">Cargando perfiles del equipo por SSH… (si la OLT no es alcanzable puede tardar/fallar; puede escribir los IDs a mano).</p>
      )}

      {sugerencia && (
        <p className="text-[12px] text-text-tertiary">
          <Icon name="wand-sparkles" size={13} className="mr-1 inline text-brand" />
          Precargado con la configuración de los <b>{sugerencia.basadoEn}</b> servicios que ya hay en este puerto.
          Puede cambiar cualquier campo.
        </p>
      )}

      {result && (
        <div className={`rounded-lg border border-border-subtle p-3 text-[12px] ${result.ok ? "bg-surface-2" : "bg-error-soft"}`}>
          <div className="font-semibold text-text-primary">{result.ok ? (result.message ?? "OK") : (result.error ?? "Error")}</div>
          {result.ontId && <div className="mt-1">ONT-ID asignado: <span className="font-mono font-bold">{result.ontId}</span></div>}
          {result.verificacion && <Verificacion v={result.verificacion} />}
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

/**
 * Resultado de releer la ONT tras darla de alta. Que el comando no fallara no
 * significa que el abonado tenga servicio: Huawei acepta el `ont add` y luego
 * marca la config como fallida si el perfil no cuadra con el equipo real.
 */
function Verificacion({ v }: { v: NonNullable<ProvisionResult["verificacion"]> }) {
  // Online + con service-port = probablemente OK aunque config/match no sean
  // "normal" (habitual en ONUs de otra marca). Solo es fallo si hay avisos.
  const online = /online/i.test(v.run_state ?? "");
  const conServicio = v.servicePorts.length > 0;
  const problema = v.avisos.length > 0;
  const bien = !problema && online && conServicio;

  return (
    <div className={`mt-2 rounded-lg border p-2 ${problema ? "border-warning-text/40 bg-warning-soft" : "border-success-text/30 bg-success-soft"}`}>
      <div className="flex items-center gap-1.5 font-semibold text-text-primary">
        <Icon name={problema ? "alert-triangle" : "check"} size={14} className={problema ? "text-warning-text" : "text-success-text"} />
        {problema
          ? "La ONU quedó con observaciones"
          : bien
            ? "ONU online y con servicio — pruebe navegación"
            : "Alta enviada"}
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        <Badge label={`estado: ${v.run_state ?? "—"}`} tone={online ? "success" : "error"} />
        <Badge label={`config: ${v.config_state ?? "—"}`} tone={/normal/i.test(v.config_state ?? "") ? "success" : "default"} />
        <Badge label={`match: ${v.match_state ?? "—"}`} tone={/mismatch/i.test(v.match_state ?? "") ? "default" : "success"} />
        <Badge label={`${v.servicePorts.length} service-port(s)`} tone={conServicio ? "success" : "error"} />
      </div>
      {!!v.avisos.length && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-text-secondary">
          {v.avisos.map((a, i) => <li key={i}>{a}</li>)}
        </ul>
      )}
      {v.nota && !problema && (
        <p className="mt-1.5 text-[11.5px] text-text-tertiary">{v.nota}</p>
      )}
    </div>
  );
}
