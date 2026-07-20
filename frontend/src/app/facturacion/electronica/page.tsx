"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Input, Select } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/inventory/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import { fmtDate } from "@/lib/format";

const n = (v: number) => (v ?? 0).toLocaleString("es-CO");

type Tab = "sedes" | "historico" | "errores";
type Branch = { id: string; name: string; subscribers: number; tv: number; internet: number };

export default function EfacturaPage() {
  const { loading: authLoading, authFetch, can, isSuperadmin } = useAuth();
  const canEmit = isSuperadmin || can(PERM.AREA_CONTABILIDAD);

  const [tab, setTab] = useState<Tab>("sedes");
  const [eMode, setEMode] = useState<{ live: boolean } | null>(null);

  // Por sede
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [emittingBranch, setEmittingBranch] = useState<string | null>(null);

  // Histórico
  const [stats, setStats] = useState<any>(null);
  const [data, setData] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [all, setAll] = useState("1");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<any>(null);

  // Errores
  const [errData, setErrData] = useState<any>(null);
  const [errLoading, setErrLoading] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const errCount = stats?.tipos?.ERROR ?? 0;

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/einvoice/stats").then((r) => r.json()).then(setStats).catch(() => {});
    void authFetch("/einvoice/mode").then((r) => (r.ok ? r.json() : null)).then(setEMode).catch(() => {});
    void authFetch("/einvoice/branches").then((r) => (r.ok ? r.json() : [])).then(setBranches).catch(() => setBranches([]));
  }, [authLoading, authFetch]);

  const loadBranches = useCallback(() => {
    void authFetch("/einvoice/branches").then((r) => (r.ok ? r.json() : [])).then(setBranches).catch(() => {});
  }, [authFetch]);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: "25" });
    if (search.trim()) qs.set("search", search.trim());
    if (type) qs.set("type", type);
    if (all) qs.set("all", all);
    try { setData(await (await authFetch(`/einvoice?${qs}`)).json()); } finally { setLoading(false); }
  }, [authFetch, page, search, type, all]);

  useEffect(() => { if (!authLoading && tab === "historico") { const t = setTimeout(load, search ? 350 : 0); return () => clearTimeout(t); } }, [authLoading, tab, load, search]);
  useEffect(() => { setPage(1); }, [search, type, all]);

  async function openDetail(rid: string) {
    setDetail({ loading: true });
    const d = await (await authFetch(`/einvoice/${rid}`)).json();
    setDetail(d);
  }

  const loadErrors = useCallback(async () => {
    setErrLoading(true);
    try { setErrData(await (await authFetch("/einvoice?type=ERROR&all=1&pageSize=100")).json()); }
    finally { setErrLoading(false); }
  }, [authFetch]);

  useEffect(() => { if (!authLoading && tab === "errores") void loadErrors(); }, [authLoading, tab, loadErrors]);

  function refreshStats() {
    void authFetch("/einvoice/stats").then((r) => r.json()).then(setStats).catch(() => {});
  }

  async function retry(row: any) {
    setRetryingId(row.id);
    try {
      const res = await authFetch(`/einvoice/${row.id}/retry`, { method: "POST" });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "No se pudo reintentar");
      if (d.dryRun) toast("DRY-RUN: reintento simulado (no se envió a la DIAN).", "info");
      else toast(`Reintento OK: ${d.dianNumber ?? "factura emitida"}`, "check");
      void loadErrors();
      refreshStats();
    } catch (e: any) {
      toast(e.message ?? "Error al reintentar", "alert-circle");
    } finally {
      setRetryingId(null);
    }
  }

  async function emitBranch(b: Branch) {
    const live = !!eMode?.live;
    const warn = live
      ? `Vas a EMITIR ante la DIAN las facturas pendientes de la sede ${b.name} (clientes marcados). Es un acto legal e irreversible. ¿Continuar?`
      : `Modo PRUEBA (DRY-RUN): se construirán los payloads de la sede ${b.name} SIN enviar nada a la DIAN. ¿Continuar?`;
    if (!confirm(warn)) return;
    setEmittingBranch(b.id);
    try {
      const res = await authFetch(`/einvoice/emit-branch/${b.id}`, { method: "POST" });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "No se pudo emitir la facturación de la sede");
      let msg = d.message as string;
      if (d.dryRun && d.configReady === false) msg += " Configura las cuentas Siigo para emitir de verdad.";
      if (d.hasMore) msg += " Quedan más pendientes: vuelve a emitir para continuar.";
      if (d.failed) msg += ` (${d.failed} con error)`;
      toast(msg, d.failed ? "alert-triangle" : "check");
      loadBranches();
    } catch (e: any) {
      toast(e.message ?? "Error al emitir la sede", "alert-circle");
    } finally {
      setEmittingBranch(null);
    }
  }

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <PageHeading
        icon="file-signature"
        title="Facturación electrónica"
        subtitle={stats ? `${n(stats.total)} emitidas · ${n(stats.conDian)} con N° DIAN · ${n(stats.pendientes)} pendientes por timbrar` : "Facturas electrónicas DIAN (Siigo)"}
      />

      {/* Tabs */}
      <div className="mb-4 mt-1 flex flex-wrap gap-2">
        {([["sedes", "Por sede", "map-pin"], ["historico", "Histórico", "list"], ["errores", "Errores", "alert-triangle"]] as [Tab, string, string][]).map(([k, label, icon]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12px] font-semibold transition-colors ${tab === k ? "border-brand bg-brand-soft text-brand" : "border-border-default text-text-secondary hover:bg-surface-2"}`}>
            <Icon name={icon} size={14} /> {label}
            {k === "errores" && errCount > 0 && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-error-soft px-1 text-[10px] font-bold text-error-text">{n(errCount)}</span>}
          </button>
        ))}
      </div>

      {/* ── POR SEDE ── */}
      {tab === "sedes" && (
        !canEmit ? (
          <div className="rounded-xl border border-border-subtle bg-surface p-6 text-[13px] text-text-secondary">Solo contabilidad puede gestionar la facturación electrónica por sede.</div>
        ) : !branches ? <PageSkeleton /> : (
          <DataTable
            rows={branches}
            empty="Sin sedes."
            columns={[
              { key: "name", header: "Sede", render: (r: Branch) => <span className="font-semibold text-text-primary">{r.name}</span> },
              { key: "subs", header: "Clientes", align: "right", render: (r: Branch) => <span className="text-text-secondary">{n(r.subscribers)}</span> },
              { key: "tv", header: "Marcados TV", align: "right", render: (r: Branch) => <span className="inline-flex items-center gap-1 text-text-secondary"><Icon name="tv" size={13} className="text-text-tertiary" />{n(r.tv)}</span> },
              { key: "internet", header: "Marcados Internet", align: "right", render: (r: Branch) => <span className="inline-flex items-center gap-1 text-text-secondary"><Icon name="wifi" size={13} className="text-text-tertiary" />{n(r.internet)}</span> },
              { key: "actions", header: "", align: "right", render: (r: Branch) => (
                <div className="flex items-center justify-end gap-2">
                  <Link href={`/facturacion/electronica/emitir/${r.id}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border-default bg-surface px-3 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
                    <Icon name="users" size={14} /> Ver clientes
                  </Link>
                  <button type="button" onClick={() => emitBranch(r)} disabled={emittingBranch === r.id}
                    title={eMode?.live ? "Emitir e-factura de la sede (DIAN)" : "Emitir e-factura de la sede (DRY-RUN)"}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-[12px] font-semibold text-on-brand transition-colors hover:bg-brand-hover disabled:opacity-50">
                    <Icon name={emittingBranch === r.id ? "loader" : "file-signature"} size={14} className={emittingBranch === r.id ? "animate-spin" : ""} /> {emittingBranch === r.id ? "Emitiendo…" : "Emitir e-factura"}
                  </button>
                </div>
              ) },
            ]}
          />
        )
      )}

      {/* ── HISTÓRICO ── */}
      {tab === "historico" && (
        <>
          {stats?.porServicio?.length ? (
            <div className="mb-4 flex flex-wrap gap-2">
              {stats.porServicio.map((s: any) => (
                <span key={s.servicio} className="rounded-full border border-border-subtle bg-surface px-3 py-1 text-[11px] text-text-secondary">{s.servicio} <span className="text-text-tertiary">· {n(s.count)}</span></span>
              ))}
            </div>
          ) : null}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[240px]"><Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" /><Input className="pl-9" placeholder="Buscar por cliente o N° DIAN…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
            <Select value={type} onChange={(e) => setType(e.target.value)} className="w-auto"><option value="">Todos los tipos</option>{Object.keys(stats?.tipos ?? {}).map((t) => <option key={t} value={t}>{t}</option>)}</Select>
            <Select value={all} onChange={(e) => setAll(e.target.value)} className="w-auto"><option value="1">Histórico</option><option value="">Año actual</option></Select>
          </div>

          {loading && !data ? <PageSkeleton /> : (
            <>
              <DataTable rows={data?.items ?? []} empty="Sin facturas electrónicas." columns={[
                { key: "date", header: "Fecha", render: (r: any) => fmtDate(r.date) },
                { key: "client", header: "Cliente", render: (r: any) => r.subscriberId ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline">{r.client}</Link> : <span>{r.client}</span> },
                { key: "serv", header: "Servicio", render: (r: any) => <span className="text-text-secondary">{r.services ?? "—"}</span> },
                { key: "type", header: "Tipo", render: (r: any) => <Badge label={r.type} tone="info" /> },
                { key: "fact", header: "Factura", render: (r: any) => r.invoiceTid ? <span className="font-mono text-text-tertiary">#{r.invoiceTid}</span> : "—" },
                { key: "dian", header: "N° DIAN", render: (r: any) => r.dianNumber ? <span className="font-mono text-success-text">{r.dianNumber}</span> : <span className="text-text-tertiary">—</span> },
                { key: "go", header: "", align: "right", render: (r: any) => <button onClick={() => openDetail(r.id)} className="rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2">Ver</button> },
              ]} />
              {data && data.pages > 1 && <div className="mt-3"><Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} /></div>}
            </>
          )}
        </>
      )}

      {/* ── ERRORES ── */}
      {tab === "errores" && (
        !canEmit ? (
          <div className="rounded-xl border border-border-subtle bg-surface p-6 text-[13px] text-text-secondary">Solo contabilidad puede gestionar la facturación electrónica.</div>
        ) : errLoading && !errData ? <PageSkeleton /> : !errData?.items?.length ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-border-subtle bg-surface p-10 text-center">
            <Icon name="check" size={28} className="text-success-text" />
            <div className="text-[14px] font-semibold text-text-primary">Sin errores de emisión</div>
            <div className="text-[12px] text-text-tertiary">Las e-facturas que rechace la DIAN/Siigo aparecerán aquí para reintentarlas.</div>
          </div>
        ) : (
          <DataTable rows={errData.items} empty="Sin errores." columns={[
            { key: "date", header: "Fecha", render: (r: any) => fmtDate(r.date) },
            { key: "client", header: "Cliente", render: (r: any) => r.subscriberId ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline">{r.client}</Link> : <span>{r.client}</span> },
            { key: "fact", header: "Factura", render: (r: any) => r.invoiceTid ? <span className="font-mono text-text-tertiary">#{r.invoiceTid}</span> : "—" },
            { key: "error", header: "Error", render: (r: any) => <span className="block max-w-[420px] text-[12px] text-error-text">{r.error ?? "Error sin detalle"}</span> },
            { key: "go", header: "", align: "right", render: (r: any) => (
              <button onClick={() => retry(r)} disabled={retryingId === r.id}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2 disabled:opacity-50">
                <Icon name={retryingId === r.id ? "loader" : "refresh-cw"} size={14} className={retryingId === r.id ? "animate-spin" : ""} /> Reintentar
              </button>
            ) },
          ]} />
        )
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} title="Factura electrónica" maxWidth="max-w-lg">
        {detail?.loading ? <p className="py-4 text-center text-[13px] text-text-tertiary">Cargando…</p> : detail && (
          <div className="flex flex-col gap-2 text-[13px]">
            <div className="flex justify-between border-b border-border-subtle py-1.5"><span className="text-text-tertiary">Cliente</span><span className="font-medium">{detail.subscriber?.name ?? "—"}</span></div>
            <div className="flex justify-between border-b border-border-subtle py-1.5"><span className="text-text-tertiary">Fecha</span><span>{fmtDate(detail.date)}</span></div>
            <div className="flex justify-between border-b border-border-subtle py-1.5"><span className="text-text-tertiary">Tipo / Servicio</span><span>{detail.type} · {detail.services ?? "—"}</span></div>
            <div className="flex justify-between border-b border-border-subtle py-1.5"><span className="text-text-tertiary">Factura</span><span className="font-mono">{detail.invoice ? `#${detail.invoice.tid}` : "—"}</span></div>
            <div className="flex justify-between border-b border-border-subtle py-1.5"><span className="text-text-tertiary">Cuenta Siigo</span><span>{detail.siigoAccount ?? "—"}</span></div>
            <div className="flex justify-between border-b border-border-subtle py-1.5"><span className="text-text-tertiary">N° DIAN</span><span className="font-mono">{detail.dian?.number ?? "—"}</span></div>
            {detail.dian?.cufe && <div className="border-b border-border-subtle py-1.5"><div className="text-text-tertiary">CUFE</div><div className="break-all font-mono text-[10px]">{detail.dian.cufe}</div></div>}
            {detail.dian?.pdfUrl && <a href={detail.dian.pdfUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-brand hover:underline"><Icon name="file-text" size={14} /> Ver PDF DIAN</a>}
            {detail.error && <p className="rounded bg-error-soft p-2 text-[12px] text-error-text">{detail.error}</p>}
            {!detail.dian?.number && !detail.error && <p className="text-[12px] text-text-tertiary">El sistema legacy no persistía el número DIAN ni el CUFE de esta factura.</p>}
          </div>
        )}
      </Modal>
    </>
  );
}
