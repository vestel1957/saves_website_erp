"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { type WaTemplate, WA_VAR_SOURCES } from "@/lib/whatsapp";
import { mensajeDeError } from "@/lib/errores";

/** Sustituye los {{n}} del cuerpo por una etiqueta legible de cada variable. */
function renderPreview(tpl: WaTemplate): string {
  const vars = tpl.variables ?? [];
  return (tpl.bodyText || "").replace(/\{\{(\d+)\}\}/g, (_m, n) => {
    const v = vars.find((x) => x.index === Number(n));
    if (!v) return `{{${n}}}`;
    if (v.source === "custom") return v.value ?? "";
    const label = WA_VAR_SOURCES.find((s) => s.value === v.source)?.label ?? v.source;
    return `«${label}»`;
  });
}

/**
 * Modal de envío masivo de WhatsApp a un conjunto explícito de clientes
 * (por `subscriberIds`). Crea una campaña por plantilla vía
 * `POST /admin/whatsapp/campaigns` y muestra el resultado.
 */
export function BulkWhatsappModal({
  open,
  onClose,
  subscriberIds,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  subscriberIds: string[];
  onSent?: () => void;
}) {
  const { authFetch } = useAuth();
  const [templates, setTemplates] = useState<WaTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [launching, setLaunching] = useState(false);
  const selectedTpl = templates.find((t) => t.name === templateName) ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const t: WaTemplate[] = await authFetch("/admin/whatsapp/templates").then((r) => (r.ok ? r.json() : []));
      // Solo plantillas activas y aprobadas en Meta (PENDING/REJECTED fallarían al enviar).
      const active = t.filter((x) => x.active && (x.metaStatus == null || x.metaStatus === "APPROVED"));
      setTemplates(active);
      if (active.length) setTemplateName((prev) => prev || active[0].name);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function launch() {
    if (!name.trim() || !templateName) {
      toast("Indica un nombre y una plantilla.", "alert-triangle");
      return;
    }
    if (!subscriberIds.length) {
      toast("No hay clientes seleccionados.", "alert-triangle");
      return;
    }
      const tpl = templates.find((t) => t.name === templateName);
    setLaunching(true);
    try {
      const res = await authFetch("/admin/whatsapp/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          templateName,
          templateId: tpl?.id,
          language: tpl?.language,
          subscriberIds,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo lanzar la campaña");
      toast(`Campaña lanzada a ${data.total} destinatario${data.total === 1 ? "" : "s"}`, "check");
      setName("");
      onSent?.();
      onClose();
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally {
      setLaunching(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Enviar WhatsApp masivo" maxWidth="max-w-lg">
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-[13px] text-text-secondary">
          <Icon name="users" size={14} className="mr-1 inline align-[-2px] text-brand" />
          Se enviará a <span className="font-semibold text-text-primary">{subscriberIds.length}</span> cliente
          {subscriberIds.length === 1 ? "" : "s"} seleccionado{subscriberIds.length === 1 ? "" : "s"}
          {" "}con teléfono válido.
        </div>

        {loading ? (
          <p className="py-4 text-center text-[13px] text-text-tertiary">Cargando plantillas…</p>
        ) : templates.length === 0 ? (
          <p className="text-[13px] text-text-secondary">
            Primero crea una{" "}
            <Link href="/configuracion/whatsapp/plantillas" className="text-brand hover:underline">
              plantilla aprobada
            </Link>{" "}
            en Meta.
          </p>
        ) : (
          <>
            <Field label="Nombre de la campaña" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Aviso de corte julio" />
            </Field>
            <Field label="Plantilla" required>
              <Select value={templateName} onChange={(e) => setTemplateName(e.target.value)}>
                {templates.map((t) => (
                  <option key={t.id} value={t.name}>{t.name}</option>
                ))}
              </Select>
            </Field>

            {/* Vista previa del mensaje que se enviará (estilo WhatsApp). */}
            {selectedTpl && (
              <div>
                <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
                  Vista previa del mensaje
                </span>
                <div className="rounded-xl bg-[#0b141a] p-3">
                  <div className="ml-auto max-w-[85%] rounded-lg rounded-tr-sm bg-[#005c4b] px-3 py-2 text-[13px] leading-relaxed text-white shadow-sm">
                    {selectedTpl.headerText && (
                      <div className="mb-1 font-semibold">{selectedTpl.headerText}</div>
                    )}
                    <div className="whitespace-pre-wrap">{renderPreview(selectedTpl)}</div>
                  </div>
                </div>
                <p className="mt-1.5 text-[11px] text-text-tertiary">
                  Los campos entre «comillas» se reemplazan por los datos reales de cada cliente al enviar. El envío
                  queda con reporte de entregas en{" "}
                  <Link href="/whatsapp/masivo" className="text-brand hover:underline">Mensajes masivos</Link>.
                </p>
              </div>
            )}
            <div className="mt-1 flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose} disabled={launching}>Cancelar</Button>
              <Button onClick={launch} disabled={launching}>
                <Icon name="send" size={14} /> {launching ? "Lanzando…" : "Lanzar campaña"}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
