"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { AuthNotice } from "@/components/inventory/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";

type WaStatus = {
  provider: string;
  enabled: boolean;
  hasApiKey: boolean;
  hasPhoneNumberId: boolean;
  hasAppSecret: boolean;
  baseUrl: string;
  graphVersion: string;
};

export default function WhatsappPage() {
  const { user, can, authFetch } = useAuth();
  const isAdmin = can(PERM.WHATSAPP_MANAGE);

  const [status, setStatus] = useState<WaStatus | null>(null);
  const [msg, setMsg] = useState("");
  const [to, setTo] = useState("");
  const [testMsg, setTestMsg] = useState("✅ Prueba de WhatsApp desde Vestel.");
  const [sending, setSending] = useState(false);

  const [messages, setMessages] = useState<any[]>([]);

  const refresh = useCallback(async () => {
    try {
      const s = await authFetch("/admin/whatsapp/status");
      if (s.ok) setStatus(await s.json());
      const m = await authFetch("/admin/whatsapp/messages?pageSize=25");
      if (m.ok) setMessages((await m.json()).items ?? []);
    } catch {
      /* best-effort */
    }
  }, [authFetch]);

  useEffect(() => {
    if (!user || !isAdmin) return;
    void refresh();
  }, [user, isAdmin, refresh]);

  async function sendTest(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    if (!to.trim()) return setMsg("✗ Escribe un número destino (ej: 573001112233)");
    setSending(true);
    const res = await authFetch("/admin/whatsapp/test", {
      method: "POST",
      body: JSON.stringify({ to: to.trim(), message: testMsg }),
    });
    setSending(false);
    const body = await res.json().catch(() => ({}));
    setMsg(body?.ok ? "✓ Mensaje enviado" : "✗ No se envió (revisa la configuración de Kapso)");
  }

  if (!user) return <AuthNotice />;
  if (!isAdmin)
    return (
      <>
        <PageHeading icon="message-circle" title="WhatsApp" />
        <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-10 text-center text-[13px] text-text-tertiary">
          Solo administradores pueden gestionar la configuración de WhatsApp.
        </div>
      </>
    );

  const waReady = !!status?.enabled;

  return (
    <>
      <PageHeading
        icon="message-circle"
        title="WhatsApp"
        subtitle="Canal de notificaciones por WhatsApp vía Kapso (Cloud API oficial de Meta)"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge label={waReady ? "Kapso: conectado" : "Kapso: sin configurar"} tone={waReady ? "success" : "warning"} />
        {msg && (
          <span className={`text-[12px] font-medium ${msg.startsWith("✓") ? "text-success-text" : "text-error-text"}`}>{msg}</span>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Estado del canal Kapso */}
        <div className="rounded-xl border border-border-subtle bg-surface p-5">
          <h3 className="mb-3 text-[14px] font-bold text-text-primary">Canal de WhatsApp (Kapso)</h3>
          {waReady ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success-soft">
                <Icon name="shield-check" size={26} className="text-success-text" />
              </span>
              <h4 className="text-[15px] font-bold text-text-primary">Canal oficial activo</h4>
              <p className="max-w-sm text-[13px] text-text-tertiary">
                El número conectado en Kapso envía y recibe mensajes por la Cloud API oficial de Meta.
                No hay QR que escanear ni riesgo de baneo.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2 py-2 text-[12px] text-text-secondary">
              <p className="text-[13px] text-text-tertiary">
                Configura las credenciales de Kapso en el servidor (variables de entorno) y reinicia el backend:
              </p>
              <ul className="ml-1 flex flex-col gap-1">
                <li className="flex items-center gap-2">
                  <Icon name={status?.hasApiKey ? "check" : "x"} size={14} className={status?.hasApiKey ? "text-success-text" : "text-error-text"} />
                  <span className="font-mono">KAPSO_API_KEY</span>
                </li>
                <li className="flex items-center gap-2">
                  <Icon name={status?.hasPhoneNumberId ? "check" : "x"} size={14} className={status?.hasPhoneNumberId ? "text-success-text" : "text-error-text"} />
                  <span className="font-mono">KAPSO_PHONE_NUMBER_ID</span>
                </li>
                <li className="flex items-center gap-2">
                  <Icon name={status?.hasAppSecret ? "check" : "alert-circle"} size={14} className={status?.hasAppSecret ? "text-success-text" : "text-text-tertiary"} />
                  <span className="font-mono">WHATSAPP_WEBHOOK_APP_SECRET</span>
                  <span className="text-text-tertiary">(firma del webhook · recomendado)</span>
                </li>
              </ul>
            </div>
          )}
          {status && (
            <div className="mt-3 border-t border-border-subtle pt-3 text-[11px] text-text-tertiary">
              <span className="font-mono">{status.baseUrl}</span> · API {status.graphVersion}
            </div>
          )}
        </div>

        {/* Enviar prueba */}
        <div className="rounded-xl border border-border-subtle bg-surface p-5">
          <h3 className="mb-3 text-[14px] font-bold text-text-primary">Enviar mensaje de prueba</h3>
          <form onSubmit={sendTest} className="flex flex-col gap-3">
            <Field label="Número destino" hint="Formato internacional sin + (ej: 573001112233).">
              <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="573001112233" />
            </Field>
            <Field label="Mensaje">
              <Input value={testMsg} onChange={(e) => setTestMsg(e.target.value)} />
            </Field>
            <Button type="submit" disabled={sending || !waReady}>
              <Icon name="send" size={14} /> {sending ? "Enviando…" : "Enviar prueba"}
            </Button>
            {!waReady && <span className="text-[11px] text-text-tertiary">Configura Kapso primero para poder enviar.</span>}
          </form>
        </div>
      </div>

      {/* Conversaciones (entrantes + salientes) */}
      <div className="mt-5 rounded-xl border border-border-subtle bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-text-primary">Conversaciones recientes</h3>
          <button onClick={() => void refresh()} className="text-[12px] text-brand hover:underline">Actualizar</button>
        </div>
        {messages.length === 0 ? (
          <p className="text-[13px] text-text-tertiary">Aún no hay mensajes. Los entrantes aparecen aquí cuando Kapso reenvía el webhook a este servidor.</p>
        ) : (
          <div className="space-y-1.5">
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.direction === "OUT" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[75%] rounded-xl px-3 py-2 text-[13px] ${m.direction === "OUT" ? "bg-brand-soft text-text-primary" : "border border-border-subtle bg-surface-subtle text-text-primary"}`}>
                  <div className="mb-0.5 flex items-center gap-2 text-[11px] text-text-tertiary">
                    <span>{m.direction === "OUT" ? "Enviado" : "Recibido"}</span>
                    <span className="font-mono">{m.phone}</span>
                    {m.subscriberName && <span className="text-text-secondary">· {m.subscriberName}{m.abonado != null ? ` #${m.abonado}` : ""}</span>}
                    <span className="ml-auto">{new Date(m.createdAt).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })}</span>
                  </div>
                  <p>{m.hasAudio ? "🎤 " : ""}{m.body}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
