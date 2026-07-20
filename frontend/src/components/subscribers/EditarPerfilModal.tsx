"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";

/** Campos editables del perfil (contacto/identidad). */
type Form = {
  companyName: string; docType: string; docNumber: string; email: string;
  phone1: string; phone2: string; birthDate: string; estrato: string;
  addressLine: string; neighborhood: string;
};

const EMPTY: Form = {
  companyName: "", docType: "", docNumber: "", email: "",
  phone1: "", phone2: "", birthDate: "", estrato: "",
  addressLine: "", neighborhood: "",
};

const dateInput = (d?: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

export function EditarPerfilModal({
  subscriberId, current, open, onClose, onDone,
}: {
  subscriberId: string;
  current: any;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { authFetch } = useAuth();
  const [f, setF] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);

  // Precargar con los datos actuales al abrir.
  useEffect(() => {
    if (!open) return;
    setF({
      companyName: current?.companyName ?? "",
      docType: current?.docType ?? "",
      docNumber: current?.docNumber ?? "",
      email: current?.email ?? "",
      phone1: current?.phone1 ?? "",
      phone2: current?.phone2 ?? "",
      birthDate: dateInput(current?.birthDate),
      estrato: current?.estrato != null ? String(current.estrato) : "",
      addressLine: current?.addressLine ?? "",
      neighborhood: current?.neighborhood ?? "",
    });
  }, [open, current]);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit() {
    setSaving(true);
    try {
      const res = await authFetch(`/subscribers/${subscriberId}`, {
        method: "PATCH",
        body: JSON.stringify(f),
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => null);
        throw new Error(Array.isArray(msg?.message) ? msg.message[0] : msg?.message ?? "No se pudo guardar");
      }
      toast("Perfil actualizado");
      onDone();
      onClose();
    } catch (e) {
      toast(mensajeDeError(e) ?? "Error al guardar", "alert-circle");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Editar perfil del cliente" maxWidth="max-w-2xl">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Razón social / Empresa">
          <Input value={f.companyName} onChange={set("companyName")} placeholder="Opcional" />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Tipo doc.">
            <Input value={f.docType} onChange={set("docType")} placeholder="CC, NIT…" />
          </Field>
          <Field label="N° documento">
            <Input value={f.docNumber} onChange={set("docNumber")} />
          </Field>
        </div>
        <Field label="Celular">
          <Input value={f.phone1} onChange={set("phone1")} inputMode="tel" />
        </Field>
        <Field label="Celular 2">
          <Input value={f.phone2} onChange={set("phone2")} inputMode="tel" />
        </Field>
        <Field label="Correo">
          <Input value={f.email} onChange={set("email")} type="email" inputMode="email" />
        </Field>
        <Field label="Fecha de nacimiento">
          <Input value={f.birthDate} onChange={set("birthDate")} type="date" />
        </Field>
        <Field label="Dirección">
          <Input value={f.addressLine} onChange={set("addressLine")} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Barrio">
            <Input value={f.neighborhood} onChange={set("neighborhood")} />
          </Field>
          <Field label="Estrato">
            <Input value={f.estrato} onChange={set("estrato")} inputMode="numeric" />
          </Field>
        </div>
      </div>

      <div className="mt-2 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button onClick={submit} disabled={saving}>
          <Icon name={saving ? "loader" : "check"} size={15} className={saving ? "animate-spin" : ""} />
          {saving ? "Guardando…" : "Guardar cambios"}
        </Button>
      </div>
    </Modal>
  );
}
