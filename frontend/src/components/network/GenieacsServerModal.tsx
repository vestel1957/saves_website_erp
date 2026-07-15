"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/Icon";
import { Field, Input } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import type { GenieacsServer } from "@/lib/genieacs";

/** Alta / edición de un servidor GenieACS (conexión al NBI, puerto 7557). */
export function GenieacsServerModal({
  open,
  onClose,
  onSaved,
  server,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  server: GenieacsServer | null; // null = alta
}) {
  const { authFetch } = useAuth();
  const editing = !!server;
  const [form, setForm] = useState({ name: "", nbiUrl: "", username: "", password: "", sedeLegacy: "0" });
  const [showPass, setShowPass] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setShowPass(false);
    if (server) {
      setForm({ name: server.name, nbiUrl: server.nbiUrl, username: server.username, password: "", sedeLegacy: String(server.sedeLegacy) });
    } else {
      setForm({ name: "", nbiUrl: "http://localhost:7557", username: "", password: "", sedeLegacy: "0" });
    }
  }, [open, server]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.nbiUrl.trim()) { toast("Nombre y URL del NBI son obligatorios", "x"); return; }
    setSaving(true);
    try {
      const body: Record<string, string> = {
        name: form.name.trim(), nbiUrl: form.nbiUrl.trim(),
        username: form.username.trim(), sedeLegacy: form.sedeLegacy,
      };
      if (form.password) body.password = form.password;
      const r = await authFetch(editing ? `/network/genieacs/servers/${server!.id}` : "/network/genieacs/servers", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) { toast(data?.message ?? "No se pudo guardar", "x"); return; }
      toast(editing ? "Servidor actualizado" : "Servidor agregado", "check");
      onSaved();
      onClose();
    } catch (err) {
      toast((err as Error).message, "x");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Editar servidor GenieACS" : "Agregar servidor GenieACS"} maxWidth="max-w-xl">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Nombre" required>
          <Input value={form.name} onChange={set("name")} placeholder="GenieACS Principal" required />
        </Field>
        <Field label="URL del NBI" required hint="API REST de GenieACS (puerto 7557). Ej: http://localhost:7557 (vía túnel).">
          <Input value={form.nbiUrl} onChange={set("nbiUrl")} placeholder="http://localhost:7557" className="font-mono" required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Usuario (opcional)" hint="Sólo si el NBI tiene basic-auth.">
            <Input value={form.username} onChange={set("username")} placeholder="(vacío)" />
          </Field>
          <Field label="Password (opcional)">
            <div className="flex gap-2">
              <Input
                value={form.password}
                onChange={set("password")}
                placeholder={editing ? "•••••••• (sin cambios)" : "(vacío)"}
                type={showPass ? "text" : "password"}
                className="font-mono"
              />
              <Button type="button" variant="secondary" size="sm" onClick={() => setShowPass((v) => !v)} title={showPass ? "Ocultar" : "Ver"}>
                <Icon name={showPass ? "eye-off" : "eye"} size={15} />
              </Button>
            </div>
          </Field>
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
