"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Textarea, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/inventory/DataTable";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";

type EmailTemplate = { id: string; kind: string; name: string; subject: string; bodyHtml: string; active: boolean };
type MailStatus = { enabled: boolean; host: string; port: number; from: string; secure: boolean };

const KIND_LABEL: Record<string, string> = {
  INVOICE_AVAILABLE: "Factura disponible",
  REMINDER: "Recordatorio de pago",
  OVERDUE: "Factura vencida",
  RECEIPT: "Recibo de pago",
  GENERIC: "Mensaje general",
};
const PLACEHOLDERS = "{{nombre}} {{abonado}} {{factura}} {{total}} {{deuda}} {{vence}} {{empresa}}";

function TemplateModal({ tpl, onClose, onDone }: { tpl: EmailTemplate | null; onClose: () => void; onDone: () => void }) {
  const { authFetch } = useAuth();
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (tpl) { setName(tpl.name); setSubject(tpl.subject); setBodyHtml(tpl.bodyHtml); setActive(tpl.active); setErr(null); }
  }, [tpl]);

  async function submit() {
    if (!tpl) return;
    setErr(null); setSaving(true);
    try {
      const res = await authFetch(`/admin/mail/templates/${tpl.id}`, {
        method: "PATCH", body: JSON.stringify({ name, subject, bodyHtml, active }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo guardar");
      toast("Plantilla de correo actualizada", "check");
      onDone(); onClose();
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  }

  return (
    <Modal open={!!tpl} onClose={onClose} title={tpl ? `Plantilla · ${KIND_LABEL[tpl.kind] ?? tpl.kind}` : ""} maxWidth="max-w-2xl">
      {tpl && (
        <div className="flex flex-col gap-3">
          <Field label="Nombre"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Asunto" required><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
          <Field label="Cuerpo (HTML)" required hint={`Variables: ${PLACEHOLDERS}`}><Textarea rows={8} value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)} /></Field>
          <label className="flex items-center gap-2 text-[13px] text-text-secondary"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Activa (si se desactiva, no se envía este correo)</label>
          {err && <p className="text-[12px] text-error-text">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
            <Button onClick={submit} disabled={saving}>{saving ? "Guardando…" : "Guardar"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function CorreoPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EmailTemplate | null>(null);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, t] = await Promise.all([
        authFetch("/admin/mail/status").then((r) => (r.ok ? r.json() : null)),
        authFetch("/admin/mail/templates").then((r) => (r.ok ? r.json() : [])),
      ]);
      setStatus(s); setTemplates(t);
    } finally { setLoading(false); }
  }, [authFetch]);
  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  async function sendTest() {
    if (!testTo.trim()) return;
    setTesting(true);
    try {
      const res = await authFetch("/admin/mail/test", { method: "POST", body: JSON.stringify({ to: testTo.trim() }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo enviar");
      toast(d.sent ? "Correo de prueba enviado" : (d.error || "No se envió (revisa SMTP)"), d.sent ? "check" : "alert-triangle");
    } catch (e: any) { toast(e.message, "alert-triangle"); } finally { setTesting(false); }
  }

  if (authLoading || loading) return <PageSkeleton />;

  return (
    <>
      <PageHeading icon="mail" title="Correo saliente" subtitle="Estado SMTP, plantillas de correo y prueba de envío" />

      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border-subtle bg-surface p-4 shadow-sm">
        <Badge label={status?.enabled ? "SMTP configurado" : "SMTP no configurado"} tone={status?.enabled ? "success" : "error"} />
        {status?.host && <span className="text-[12px] text-text-secondary">{status.host}:{status.port} · {status.from}</span>}
        {!status?.enabled && <span className="text-[12px] text-text-tertiary">Configura el servidor SMTP en <a href="/configuracion/ajustes" className="text-brand hover:underline">Ajustes</a>.</span>}
        <div className="ml-auto flex items-end gap-2">
          <Field label="Enviar prueba a"><Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="correo@ejemplo.com" /></Field>
          <Button size="sm" variant="secondary" onClick={sendTest} disabled={testing || !testTo.trim()}><Icon name="send" size={13} /> {testing ? "Enviando…" : "Probar"}</Button>
        </div>
      </div>

      <section className="mt-6">
        <h2 className="mb-2 text-[13px] font-bold uppercase tracking-wide text-text-tertiary">Plantillas de correo</h2>
        <DataTable
          autoHeight
          rows={templates}
          empty="Sin plantillas."
          columns={[
            { key: "kind", header: "Tipo", render: (t: EmailTemplate) => <span className="font-medium text-text-primary">{KIND_LABEL[t.kind] ?? t.kind}</span> },
            { key: "subject", header: "Asunto", render: (t: EmailTemplate) => <span className="text-text-secondary">{t.subject}</span> },
            { key: "active", header: "Estado", render: (t: EmailTemplate) => <Badge label={t.active ? "Activa" : "Inactiva"} tone={t.active ? "success" : "default"} /> },
            { key: "acc", header: "", align: "right" as const, render: (t: EmailTemplate) => (
              <button type="button" onClick={() => setEditing(t)} className="inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:underline"><Icon name="pencil" size={13} /> Editar</button>
            ) },
          ]}
        />
      </section>

      <TemplateModal tpl={editing} onClose={() => setEditing(null)} onDone={load} />
    </>
  );
}
