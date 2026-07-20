"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import {
  type WaTemplate, type WaCampaign, type WaCampaignReport,
  WA_SEND_STATUS, SUBSCRIBER_STATUSES,
} from "@/lib/whatsapp";

const fmt = (d: string | null) => (d ? new Date(d).toLocaleString("es-CO") : "—");

/** Reporte de una campaña (envíos por estado + reintento). */
function ReportModal({ campaignId, onClose }: { campaignId: string | null; onClose: () => void }) {
  const { authFetch } = useAuth();
  const [data, setData] = useState<WaCampaignReport | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!campaignId) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ pageSize: "200" });
      if (statusFilter) qs.set("status", statusFilter);
      const r = await authFetch(`/admin/whatsapp/campaigns/${campaignId}?${qs}`);
      setData(r.ok ? await r.json() : null);
    } finally { setLoading(false); }
  }, [authFetch, campaignId, statusFilter]);
  useEffect(() => { void load(); }, [load]);

  async function retry() {
    if (!campaignId) return;
    try {
      const r = await authFetch(`/admin/whatsapp/campaigns/${campaignId}/retry`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "No se pudo reintentar");
      toast(`Reencolados ${d.requeued} envíos fallidos`, "check");
      setTimeout(load, 800);
    } catch (e: any) { toast(e.message, "alert-triangle"); }
  }

  const c = data?.campaign;
  return (
    <Modal open={!!campaignId} onClose={onClose} title={c ? `Campaña · ${c.name}` : "Campaña"} maxWidth="max-w-3xl">
      {!data ? <PageSkeleton /> : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {([["Total", c!.total, "default"], ["Enviados", c!.sent, "info"], ["Entregados", c!.delivered, "success"], ["Leídos", c!.read, "success"], ["Fallidos", c!.failed, "error"]] as const).map(([lbl, val]) => (
              <div key={lbl} className="rounded-lg border border-border-subtle bg-surface-2 p-2 text-center">
                <div className="text-[18px] font-bold tabular-nums text-text-primary">{val}</div>
                <div className="text-[11px] text-text-tertiary">{lbl}</div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="max-w-[200px]">
              <option value="">Todos los estados</option>
              {Object.entries(WA_SEND_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
            {c!.failed > 0 && <Button size="sm" variant="secondary" onClick={retry}><Icon name="refresh-cw" size={13} /> Reintentar fallidos</Button>}
          </div>
          <DataTable
            autoHeight
            rows={data.sends}
            empty="Sin envíos."
            columns={[
              { key: "name", header: "Cliente", render: (s) => s.name || "—" },
              { key: "phone", header: "Teléfono", render: (s) => <span className="font-mono text-[12px]">{s.phone}</span> },
              { key: "status", header: "Estado", render: (s) => <Badge label={WA_SEND_STATUS[s.status]?.label ?? s.status} tone={WA_SEND_STATUS[s.status]?.tone ?? "default"} /> },
              { key: "sent", header: "Enviado", render: (s) => fmt(s.sentAt) },
              { key: "err", header: "Error", render: (s) => s.error ? <span className="text-[12px] text-error-text">{s.error}</span> : "—" },
            ]}
          />
          {loading && <p className="text-center text-[12px] text-text-tertiary">Actualizando…</p>}
        </div>
      )}
    </Modal>
  );
}

export default function MasivoPage() {
  const { loading: authLoading, authFetch, can } = useAuth();
  const isAdmin = can(PERM.WHATSAPP_MANAGE);
  const [templates, setTemplates] = useState<WaTemplate[]>([]);
  const [campaigns, setCampaigns] = useState<WaCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<string | null>(null);

  // Formulario de nueva campaña.
  const [name, setName] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [status, setStatus] = useState("ACTIVO");
  const [search, setSearch] = useState("");
  const [launching, setLaunching] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, c] = await Promise.all([
        authFetch("/admin/whatsapp/templates").then((r) => (r.ok ? r.json() : [])),
        authFetch("/admin/whatsapp/campaigns?pageSize=25").then((r) => (r.ok ? r.json() : { items: [] })),
      ]);
      setTemplates(t); setCampaigns(c.items ?? []);
      if (!templateName && t.length) setTemplateName(t[0].name);
    } finally { setLoading(false); }
  }, [authFetch, templateName]);
  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  async function launch() {
    if (!name.trim() || !templateName) { toast("Indica un nombre y una plantilla.", "alert-triangle"); return; }
    const tpl = templates.find((t) => t.name === templateName);
    setLaunching(true);
    try {
      const res = await authFetch("/admin/whatsapp/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(), templateName, templateId: tpl?.id,
          language: tpl?.language, filter: { status, search: search || undefined },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo lanzar la campaña");
      toast(`Campaña lanzada a ${data.total} destinatarios`, "check");
      setName(""); setSearch("");
      setTimeout(load, 800);
    } catch (e: any) { toast(e.message, "alert-triangle"); } finally { setLaunching(false); }
  }

  if (authLoading || loading) return <PageSkeleton />;

  return (
    <>
      <PageHeading icon="send" title="Envío masivo de WhatsApp" subtitle="Campañas por plantilla a un grupo de clientes, con reporte de entregas" />

      {isAdmin && (
        <section className="mt-4 rounded-2xl border border-border-subtle bg-surface p-4 shadow-sm">
          <h2 className="mb-3 text-[13px] font-bold uppercase tracking-wide text-text-tertiary">Nueva campaña</h2>
          {templates.length === 0 ? (
            <p className="text-[13px] text-text-secondary">Primero crea una <a href="/configuracion/whatsapp/plantillas" className="text-brand hover:underline">plantilla</a>.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Nombre de la campaña" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Factura julio" /></Field>
              <Field label="Plantilla" required><Select value={templateName} onChange={(e) => setTemplateName(e.target.value)}>{templates.filter((t) => t.active).map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}</Select></Field>
              <Field label="Clientes con estado"><Select value={status} onChange={(e) => setStatus(e.target.value)}>{SUBSCRIBER_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
              <Field label="Filtro (opcional)" hint="Nombre, cédula o teléfono"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar…" /></Field>
              <div className="sm:col-span-2 lg:col-span-4">
                <Button onClick={launch} disabled={launching}><Icon name="send" size={14} /> {launching ? "Lanzando…" : "Lanzar campaña"}</Button>
                <p className="mt-1 text-[11px] text-text-tertiary">Se enviará la plantilla a todos los clientes con estado «{status}»{search ? ` que coincidan con «${search}»` : ""} y teléfono válido.</p>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-2 text-[13px] font-bold uppercase tracking-wide text-text-tertiary">Campañas</h2>
        <DataTable
          autoHeight
          rows={campaigns}
          empty="No hay campañas todavía."
          columns={[
            { key: "name", header: "Campaña", render: (c: WaCampaign) => <span className="font-medium text-text-primary">{c.name}</span> },
            { key: "tpl", header: "Plantilla", render: (c: WaCampaign) => <span className="font-mono text-[12px] text-text-secondary">{c.templateName}</span> },
            { key: "total", header: "Total", align: "right" as const, render: (c: WaCampaign) => c.total },
            { key: "sent", header: "Enviados", align: "right" as const, render: (c: WaCampaign) => c.sent },
            { key: "deliv", header: "Entregados", align: "right" as const, render: (c: WaCampaign) => c.delivered },
            { key: "read", header: "Leídos", align: "right" as const, render: (c: WaCampaign) => c.read },
            { key: "fail", header: "Fallidos", align: "right" as const, render: (c: WaCampaign) => c.failed ? <span className="text-error-text">{c.failed}</span> : 0 },
            { key: "st", header: "Estado", render: (c: WaCampaign) => <Badge label={c.status === "done" ? "Finalizada" : c.status === "running" ? "En curso" : c.status} tone={c.status === "done" ? "success" : "info"} /> },
            { key: "date", header: "Fecha", render: (c: WaCampaign) => fmt(c.createdAt) },
            { key: "acc", header: "", align: "right" as const, render: (c: WaCampaign) => (
              <button type="button" onClick={() => setReport(c.id)} className="inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:underline"><Icon name="eye" size={13} /> Ver</button>
            ) },
          ]}
        />
      </section>

      <ReportModal campaignId={report} onClose={() => setReport(null)} />
    </>
  );
}
