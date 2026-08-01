"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { PagedTable } from "@/components/ui/PagedTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import {
  type WaTemplate, type WaCampaign, type WaCampaignReport, type WaHealth,
  WA_SEND_STATUS, WA_QUALITY, WA_TIER, SUBSCRIBER_STATUSES,
} from "@/lib/whatsapp";
import { mensajeDeError } from "@/lib/errores";

const fmt = (d: string | null) => (d ? new Date(d).toLocaleString("es-CO") : "—");

/**
 * Salud del número (calidad + tier de Meta). La calidad baja por bloqueos/reportes
 * de los clientes y es lo que decide si Meta sube o BAJA el cupo diario de envíos.
 */
function HealthPanel({ health }: { health: WaHealth | null }) {
  if (!health) return null;
  if (!health.ok) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-2xl border border-error-subtle bg-error-soft p-3 text-[13px] text-error-text">
        <Icon name="alert-triangle" size={15} /> WhatsApp no disponible: {health.error ?? "sin diagnóstico"}
      </div>
    );
  }
  const q = health.quality ? WA_QUALITY[health.quality.toUpperCase()] : null;
  const tier = health.tier ? (WA_TIER[health.tier.toUpperCase()] ?? health.tier) : null;
  return (
    <section className="mt-4 rounded-2xl border border-border-subtle bg-surface p-4 shadow-sm">
      <h2 className="mb-3 text-[13px] font-bold uppercase tracking-wide text-text-tertiary">Salud del número</h2>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
        <div className="flex items-center gap-2">
          <Icon name="phone" size={14} className="text-text-tertiary" />
          <span className="font-mono">{health.phone ?? "—"}</span>
          {health.name && <span className="text-text-secondary">· {health.name}</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-text-tertiary">Calidad:</span>
          {q ? <Badge label={q.label} tone={q.tone} /> : <span className="text-text-secondary">sin dato</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-text-tertiary">Límite de envío:</span>
          {tier ? <span className="font-medium text-text-primary">{tier}</span> : <span className="text-text-secondary">sin dato</span>}
        </div>
      </div>
      {(q?.tone === "error" || q?.tone === "warning") && (
        <p className="mt-2 text-[12px] text-warning-text">
          La calidad baja cuando los clientes bloquean o reportan el número. Con calidad baja Meta reduce el límite diario:
          pausa las campañas no esenciales y revisa el texto de las plantillas.
        </p>
      )}
    </section>
  );
}

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
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); }
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
          <PagedTable
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
  const [health, setHealth] = useState<WaHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<string | null>(null);
  const [campSearch, setCampSearch] = useState("");

  // Formulario de nueva campaña.
  const [name, setName] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [status, setStatus] = useState("ACTIVO");
  const [search, setSearch] = useState("");
  const [launching, setLaunching] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, c, h] = await Promise.all([
        authFetch("/admin/whatsapp/templates").then((r) => (r.ok ? r.json() : [])),
        authFetch("/admin/whatsapp/campaigns?pageSize=25").then((r) => (r.ok ? r.json() : { items: [] })),
        authFetch("/admin/whatsapp/health").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      setTemplates(t); setCampaigns(c.items ?? []); setHealth(h);
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
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setLaunching(false); }
  }

  // Filtro en cliente de las campañas ya cargadas (nombre y plantilla).
  const shownCampaigns = useMemo(() => {
    const q = campSearch.trim().toLowerCase();
    if (!q) return campaigns;
    return campaigns.filter((c) => [c.name, c.templateName].some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [campaigns, campSearch]);

  if (authLoading || loading) return <PageSkeleton />;

  return (
    <>
      <PageHeading icon="send" title="Envío masivo de WhatsApp" subtitle="Campañas por plantilla a un grupo de clientes, con reporte de entregas" />

      <HealthPanel health={health} />

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
        <ListToolbar search={campSearch} onSearch={setCampSearch} searchPlaceholder="Buscar campaña o plantilla…" />
        <PagedTable
          rows={shownCampaigns}
          empty={campSearch ? "Ninguna campaña coincide con la búsqueda." : "No hay campañas todavía."}
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
              <button type="button" onClick={() => setReport(c.id)} className="inline-flex min-h-8 items-center gap-1 text-[12px] font-medium text-brand hover:underline"><Icon name="eye" size={13} /> Ver</button>
            ) },
          ]}
        />
      </section>

      <ReportModal campaignId={report} onClose={() => setReport(null)} />
    </>
  );
}
