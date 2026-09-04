"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/Icon";
import { Input, Select } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import type { OltRow, Profile } from "@/lib/olt";

/**
 * Alta y edición de una OLT: datos de conexión + DEFAULTS de aprovisionamiento.
 * Los defaults (VLAN, line/srv-profile, GEM-port, user-VLAN) pre-llenan el modal
 * "Autenticar ONU", así el técnico no reescribe la VLAN en cada autenticación.
 *
 * Con `olt = null` el modal da de ALTA. Antes solo editaba, y no había ninguna
 * forma de registrar un equipo desde la interfaz aunque el backend ya lo
 * aceptara: las sedes sin OLT dada de alta se quedaban sin botón de autenticar
 * en sus órdenes de instalación.
 *
 * La SEDE es obligatoria y no es un adorno: la orden de instalación busca la OLT
 * por la sede del abonado (`oltDeSede`). Una OLT sin sede no la encuentra nadie.
 */
export function OltEditModal({
  open, onClose, onSaved, olt, brands,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** null = alta de una OLT nueva. */
  olt: OltRow | null;
  brands: string[];
}) {
  const { authFetch } = useAuth();
  const [form, setForm] = useState({
    name: "", brand: "Huawei", ip: "", port: "22", tech: "GPON", transport: "ssh", username: "", password: "", branchId: "",
    defaultLineProfile: "", defaultSrvProfile: "", defaultVlan: "", defaultGemport: "", defaultUserVlan: "",
  });
  const [sedes, setSedes] = useState<{ id: string; name: string }[]>([]);
  const alta = !olt;
  const [showPass, setShowPass] = useState(false);
  const [saving, setSaving] = useState(false);
  const [line, setLine] = useState<Profile[]>([]);
  const [srv, setSrv] = useState<Profile[]>([]);
  const [loadingProf, setLoadingProf] = useState(false);

  // Las sedes se cargan siempre que se abre: hacen falta tanto para dar de alta
  // como para corregir la sede de una que ya existe.
  useEffect(() => {
    if (!open) return;
    void authFetch("/network/branches")
      .then((r) => (r.ok ? r.json() : []))
      .then(setSedes)
      .catch(() => setSedes([]));
  }, [open, authFetch]);

  useEffect(() => {
    if (!open) return;
    setShowPass(false);
    setLine([]); setSrv([]);
    if (!olt) {
      setForm({
        name: "", brand: "Huawei", ip: "", port: "22", tech: "GPON", transport: "ssh", username: "", password: "", branchId: "",
        defaultLineProfile: "", defaultSrvProfile: "", defaultVlan: "", defaultGemport: "", defaultUserVlan: "",
      });
      return;
    }
    setForm({
      name: olt.name, brand: olt.brand || "Huawei", ip: olt.ip, port: String(olt.port),
      tech: olt.tech || "GPON", transport: olt.transport || "ssh",
      username: olt.username, password: "", branchId: olt.branchId ?? "",
      defaultLineProfile: olt.defaults.lineProfile != null ? String(olt.defaults.lineProfile) : "",
      defaultSrvProfile: olt.defaults.srvProfile != null ? String(olt.defaults.srvProfile) : "",
      defaultVlan: olt.defaults.vlan != null ? String(olt.defaults.vlan) : "",
      defaultGemport: olt.defaults.gemport != null ? String(olt.defaults.gemport) : "",
      defaultUserVlan: olt.defaults.userVlan != null ? String(olt.defaults.userVlan) : "",
    });
    // Cargar perfiles del equipo por SSH para elegir los defaults desde un desplegable
    // (si la OLT no responde, quedan los inputs manuales igual). En el alta no hay
    // equipo al que preguntarle todavía: los perfiles se eligen al editarla después.
    setLoadingProf(true);
    void authFetch(`/network/olt/${olt.id}/profiles`)
      .then((r) => r.json())
      .then((d) => { setLine(d.line ?? []); setSrv(d.srv ?? []); })
      .catch(() => {})
      .finally(() => setLoadingProf(false));
  }, [open, olt, authFetch]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.ip.trim()) { toast("Nombre e IP son obligatorios", "x"); return; }
    if (!form.branchId) { toast("Elija la sede: sin ella las órdenes de instalación no encuentran la OLT", "x"); return; }
    // En el alta la contraseña es obligatoria; al editar, vacío = se deja la que hay.
    if (alta && !form.password) { toast("La contraseña es obligatoria para dar de alta la OLT", "x"); return; }
    setSaving(true);
    try {
      const body: Record<string, string> = {
        name: form.name.trim(), brand: form.brand, ip: form.ip.trim(), port: form.port,
        tech: form.tech, transport: form.transport, username: form.username.trim(), branchId: form.branchId,
        // Defaults: string vacío => se limpia (null) en el backend.
        defaultLineProfile: form.defaultLineProfile, defaultSrvProfile: form.defaultSrvProfile,
        defaultVlan: form.defaultVlan, defaultGemport: form.defaultGemport, defaultUserVlan: form.defaultUserVlan,
      };
      if (form.password) body.password = form.password;
      const r = alta
        ? await authFetch("/network/olt/olts", { method: "POST", body: JSON.stringify(body) })
        : await authFetch(`/network/olt/olts/${olt!.id}`, { method: "PATCH", body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) { toast(data?.message ?? "No se pudo guardar", "x"); return; }
      toast(alta ? "OLT registrada. Pruebe la conexión y configure la velocidad por plan." : "OLT actualizada", "check");
      onSaved();
      onClose();
    } catch (err) {
      toast((err as Error).message, "x");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={olt ? `Editar ${olt.name}` : "Nueva OLT"} maxWidth="max-w-2xl">
      <form onSubmit={submit} className="space-y-3">
        {/* Conexión */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <label className="col-span-2 sm:col-span-1 text-[12px] text-text-secondary">Nombre
            <Input value={form.name} onChange={set("name")} className="mt-0.5" required />
          </label>
          <label className="text-[12px] text-text-secondary">Marca
            <Select value={form.brand} onChange={set("brand")} className="mt-0.5">
              {brands.map((b) => <option key={b} value={b}>{b}</option>)}
            </Select>
          </label>
          <label className="text-[12px] text-text-secondary">Tecnología
            <Select value={form.tech} onChange={set("tech")} className="mt-0.5">
              <option value="GPON">GPON</option>
              <option value="EPON">EPON</option>
            </Select>
          </label>
          <label className="col-span-2 text-[12px] text-text-secondary">IP
            <Input value={form.ip} onChange={set("ip")} className="mt-0.5 font-mono" required />
          </label>
          <label className="col-span-2 text-[12px] text-text-secondary">
            Sede
            <Select value={form.branchId} onChange={set("branchId")} className="mt-0.5" required>
              <option value="">— Elija la sede —</option>
              {sedes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
            <span className="mt-0.5 block text-[11px] text-text-tertiary">
              Las órdenes de instalación buscan la OLT por la sede del abonado.
            </span>
          </label>
          <label className="text-[12px] text-text-secondary">Conexión
            <Select
              value={form.transport}
              onChange={(e) => {
                // El puerto sigue al transporte, pero solo si venía en el otro
                // por defecto: un equipo con SSH en un puerto raro (Yopal usa el
                // 5022) no debe perder su puerto por tocar el desplegable.
                const t = e.target.value;
                const porDefecto = t === "telnet" ? "23" : "22";
                const eraPorDefecto = form.port === "22" || form.port === "23" || !form.port;
                setForm((f) => ({ ...f, transport: t, port: eraPorDefecto ? porDefecto : f.port }));
              }}
              className="mt-0.5"
            >
              <option value="ssh">SSH</option>
              <option value="telnet">Telnet</option>
            </Select>
          </label>
          <label className="text-[12px] text-text-secondary">Puerto {form.transport === "telnet" ? "Telnet" : "SSH"}
            <Input value={form.port} onChange={set("port")} className="mt-0.5 font-mono" />
          </label>
          <label className="text-[12px] text-text-secondary">Usuario
            <Input value={form.username} onChange={set("username")} className="mt-0.5 font-mono" />
          </label>
          <label className="col-span-2 text-[12px] text-text-secondary">Contraseña
            <div className="mt-0.5 flex gap-1.5">
              <Input value={form.password} onChange={set("password")} type={showPass ? "text" : "password"}
                placeholder="•••••••• (sin cambios)" className="font-mono" />
              <Button type="button" variant="secondary" size="sm" onClick={() => setShowPass((v) => !v)} title={showPass ? "Ocultar" : "Ver"}>
                <Icon name={showPass ? "eye-off" : "eye"} size={15} />
              </Button>
            </div>
          </label>
        </div>

        {/* Defaults de aprovisionamiento */}
        <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-text-primary">
            <Icon name="wand-sparkles" size={14} className="text-brand" />
            Defaults de aprovisionamiento
          </div>
          <p className="mb-2 text-[11px] text-text-tertiary">
            Se usan para <b>pre-llenar</b> el formulario de "Autenticar ONU". Configura aquí la VLAN
            (y perfiles) una vez, y no tendrás que escribirlos en cada autenticación.
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <label className="text-[12px] text-text-secondary">Line-profile
              <Select value={form.defaultLineProfile} onChange={set("defaultLineProfile")} className="mt-0.5">
                <option value="">{loadingProf ? "Cargando…" : "— sin default —"}</option>
                {line.map((p) => <option key={p.id} value={p.id}>{p.id} · {p.name}</option>)}
              </Select>
            </label>
            <label className="text-[12px] text-text-secondary">Srv-profile
              <Select value={form.defaultSrvProfile} onChange={set("defaultSrvProfile")} className="mt-0.5">
                <option value="">{loadingProf ? "Cargando…" : "— sin default —"}</option>
                {srv.map((p) => <option key={p.id} value={p.id}>{p.id} · {p.name}</option>)}
              </Select>
            </label>
            <label className="text-[12px] text-text-secondary">VLAN
              <Input value={form.defaultVlan} onChange={set("defaultVlan")} placeholder="ej. 100" className="mt-0.5 font-mono" />
            </label>
            <label className="text-[12px] text-text-secondary">GEM-port
              <Input value={form.defaultGemport} onChange={set("defaultGemport")} placeholder="ej. 1" className="mt-0.5 font-mono" />
            </label>
            <label className="text-[12px] text-text-secondary">User-VLAN
              <Input value={form.defaultUserVlan} onChange={set("defaultUserVlan")} placeholder="= VLAN si vacío" className="mt-0.5 font-mono" />
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>
            <Icon name={saving ? "loader" : "save"} size={15} className={saving ? "animate-spin" : ""} />
            {saving ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
