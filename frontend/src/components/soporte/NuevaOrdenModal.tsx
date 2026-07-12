"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { TICKET_TYPES as TIPOS } from "@/lib/support";

export function NuevaOrdenModal({ open, onClose, onDone, fixedSub }: { open: boolean; onClose: () => void; onDone: () => void; fixedSub?: PickedSub | null }) {
  const { authFetch } = useAuth();
  const [sub, setSub] = useState<PickedSub | null>(null);
  const [subject, setSubject] = useState("");
  const [type, setType] = useState(TIPOS[0]);
  const [assigned, setAssigned] = useState("");
  const [problem, setProblem] = useState("");
  const [section, setSection] = useState("");
  const [techs, setTechs] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSub(fixedSub ?? null); setSubject(""); setType(TIPOS[0]); setAssigned(""); setProblem(""); setSection(""); setErr(null);
    void authFetch("/support/technicians").then((r) => r.json()).then(setTechs).catch(() => {});
  }, [open, authFetch, fixedSub]);

  async function submit() {
    setErr(null);
    if (!sub) { setErr("Selecciona un cliente."); return; }
    if (!subject.trim()) { setErr("Escribe el asunto."); return; }
    setSaving(true);
    try {
      const res = await authFetch("/support/tickets", {
        method: "POST",
        body: JSON.stringify({ subscriberId: sub.id, subject: subject.trim(), type, assigned: assigned || undefined, problem: problem || undefined, section: section || undefined }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo crear la orden");
      toast(`Orden #${d.code} creada`);
      onDone(); onClose();
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Nueva orden de servicio" maxWidth="max-w-xl">
      <div className="flex flex-col gap-3">
        <Field label="Cliente" required>
          {fixedSub ? (
            <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-[13px] font-semibold text-text-primary">
              {fixedSub.name}
              {fixedSub.abonado != null && <span className="font-mono text-[11px] font-normal text-text-tertiary">#{fixedSub.abonado}</span>}
            </div>
          ) : (
            <SubscriberPicker value={sub} onChange={setSub} />
          )}
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Tipo de orden" required>
            <Select value={type} onChange={(e) => setType(e.target.value)}>{TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
          </Field>
          <Field label="Técnico asignado">
            <Select value={assigned} onChange={(e) => setAssigned(e.target.value)}>
              <option value="">— Sin asignar —</option>
              {techs.map((t) => <option key={t.id} value={t.username || t.name}>{t.name}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Asunto" required><Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Ej: Instalación nueva" /></Field>
        <Field label="Problema"><Input value={problem} onChange={(e) => setProblem(e.target.value)} placeholder="Descripción del problema" /></Field>
        <Field label="Observación / paquete"><Textarea rows={2} value={section} onChange={(e) => setSection(e.target.value)} /></Field>
        {err && <p className="text-[12px] text-error-text">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={submit} disabled={saving || !sub}>{saving ? "Creando…" : "Crear orden"}</Button>
        </div>
      </div>
    </Modal>
  );
}
