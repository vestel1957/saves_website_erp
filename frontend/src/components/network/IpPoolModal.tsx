"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/Icon";
import { Field, Input, Select } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";

export type IpPool = {
  id: string;
  name: string;
  ipLocal: string;
  ipRemote: string;
  tech: string;
  isDefault: boolean;
  profiles: string;
  branch: string | null;
  branchId: string | null;
};

type Branch = { id: string; name: string };

/**
 * Alta / edición de un pool de IP (legacy `ips_users_mk`). Espeja el formulario del
 * legacy (views/mikrotiks/ips_users.php): nombre, IP local, IP remota, tecnología,
 * sede y perfiles.
 *
 * No hay borrar: el legacy tampoco lo tiene, y estos pools los referencian los
 * perfiles PPPoE de los abonados.
 */
export function IpPoolModal({
  open,
  onClose,
  onSaved,
  pool,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  pool: IpPool | null; // null = alta
}) {
  const { authFetch } = useAuth();
  const editing = !!pool;

  const [branches, setBranches] = useState<Branch[]>([]);
  const [form, setForm] = useState({ name: "", ipLocal: "", ipRemote: "", tech: "", branchId: "", profiles: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({
      name: pool?.name ?? "",
      ipLocal: pool?.ipLocal ?? "",
      ipRemote: pool?.ipRemote ?? "",
      tech: pool?.tech ?? "",
      branchId: pool?.branchId ?? "",
      profiles: pool?.profiles ?? "",
    });
    void authFetch("/network/branches")
      .then((r) => (r.ok ? r.json() : []))
      .then(setBranches)
      .catch(() => setBranches([]));
  }, [open, pool, authFetch]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.ipLocal.trim() || !form.ipRemote.trim() || !form.branchId) {
      toast("Nombre, IP local, IP remota y sede son obligatorios.", "x");
      return;
    }
    setSaving(true);
    try {
      const r = await authFetch(editing ? `/network/ip-pools/${pool!.id}` : "/network/ip-pools", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify(form),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast(Array.isArray(j.message) ? j.message.join("; ") : (j.message ?? `Error ${r.status}`), "x");
        return;
      }
      toast(editing ? "Pool actualizado." : "Pool creado.", "check");
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const nPerfiles = form.profiles.split(",").map((p) => p.trim()).filter(Boolean).length;

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Editar pool · ${pool!.name}` : "Nuevo pool de IP"} maxWidth="max-w-xl">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Nombre" required>
          <Input value={form.name} onChange={set("name")} placeholder="Yopal GPON" />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="IP local" required>
            <Input value={form.ipLocal} onChange={set("ipLocal")} placeholder="10.100.0.1" />
          </Field>
          <Field label="IP remota" required>
            <Input value={form.ipRemote} onChange={set("ipRemote")} placeholder="10.100.0.2" />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Sede" required>
            <Select value={form.branchId} onChange={set("branchId")}>
              <option value="">— Seleccionar —</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Tecnología" hint="Vacío = aplica a todas">
            <Select value={form.tech} onChange={set("tech")}>
              <option value="">— Todas —</option>
              <option value="GPON">GPON</option>
              <option value="EPON">EPON</option>
              <option value="EOC">EOC</option>
              <option value="RADIO">RADIO</option>
              <option value="FIBRA">FIBRA</option>
            </Select>
          </Field>
        </div>

        <Field label="Perfiles PPPoE" hint={`Separados por coma · ${nPerfiles} perfil(es)`}>
          <textarea
            className="min-h-[90px] w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[12px] outline-none focus:border-brand"
            value={form.profiles}
            onChange={set("profiles")}
            placeholder="3Megas,5Megas,10Megas…"
          />
        </Field>

        {!editing && (
          <p className="text-xs text-text-secondary">
            Si es el primer pool de la sede, queda marcado como predeterminado automáticamente.
          </p>
        )}

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
