"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/Icon";
import { Field, Input, Select } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { MK_TECHS, type MkBranch, type MkRouter } from "@/lib/mikrotik";

/**
 * Alta / edición de un router MikroTik — porta el modal de `mikrotics/index2.php`
 * (IP, Puerto, Nombre, Sede, Tecnología, Usuario, Password con ver/ocultar).
 */
export function MikrotikRouterModal({
  open,
  onClose,
  onSaved,
  router,
  branches,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  router: MkRouter | null; // null = alta
  branches: MkBranch[];
}) {
  const { authFetch } = useAuth();
  const editing = !!router;
  const [form, setForm] = useState({ name: "", ip: "", port: "8728", tech: "", branchId: "", username: "", password: "" });
  const [showPass, setShowPass] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setShowPass(false);
    if (router) {
      setForm({
        name: router.name, ip: router.ip, port: router.port, tech: router.tech,
        branchId: router.branchId ?? "", username: router.username,
        password: "", // en edición se deja vacío: sólo se cambia si se escribe.
      });
    } else {
      setForm({ name: "", ip: "", port: "8728", tech: "", branchId: branches[0]?.id ?? "", username: "", password: "" });
    }
  }, [open, router, branches]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.ip.trim() || !form.branchId) { toast("IP y sede son obligatorios", "x"); return; }
    setSaving(true);
    try {
      const body: Record<string, string> = {
        name: form.name.trim() || form.ip.trim(),
        ip: form.ip.trim(), port: form.port.trim() || "8728", tech: form.tech,
        branchId: form.branchId, username: form.username.trim(),
      };
      if (form.password) body.password = form.password;
      const r = await authFetch(editing ? `/network/mikrotik/routers/${router!.id}` : "/network/mikrotik/routers", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) { toast(data?.message ?? "No se pudo guardar", "x"); return; }
      toast(editing ? "Mikrotik actualizada" : "Mikrotik agregada", "check");
      onSaved();
      onClose();
    } catch (err) {
      toast((err as Error).message, "x");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Editar Mikrotik" : "Agregar Mikrotik"} maxWidth="max-w-xl">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="IP" required>
            <Input value={form.ip} onChange={set("ip")} placeholder="181.118.150.29" className="font-mono" required />
          </Field>
          <Field label="Puerto" required>
            <Input value={form.port} onChange={set("port")} placeholder="8728" type="number" required />
          </Field>
          <Field label="Nombre">
            <Input value={form.name} onChange={set("name")} placeholder="MK Yopal Principal" />
          </Field>
          <Field label="Sede" required>
            <Select value={form.branchId} onChange={set("branchId")} required>
              <option value="">Seleccione…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Tecnología">
            <Select value={form.tech} onChange={set("tech")}>
              {MK_TECHS.map((t) => (
                <option key={t || "none"} value={t}>{t || "Sin tecnología"}</option>
              ))}
            </Select>
          </Field>
          <Field label="Usuario">
            <Input value={form.username} onChange={set("username")} placeholder="api.crmvestel" />
          </Field>
        </div>

        <Field label="Password" hint={editing ? "Déjalo vacío para conservar la contraseña actual." : undefined}>
          <div className="flex gap-2">
            <Input
              value={form.password}
              onChange={set("password")}
              placeholder={editing ? "•••••••• (sin cambios)" : "Contraseña de la API"}
              type={showPass ? "text" : "password"}
              className="font-mono"
            />
            <Button type="button" variant="secondary" size="sm" onClick={() => setShowPass((v) => !v)} title={showPass ? "Ocultar" : "Ver"}>
              <Icon name={showPass ? "eye-off" : "eye"} size={15} />
            </Button>
          </div>
        </Field>

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
