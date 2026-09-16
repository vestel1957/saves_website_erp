"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Field, Input, Select } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import { fmtDate } from "@/lib/format";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { mensajeDeError, objetoJson } from "@/lib/errores";

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
  const [confirmar, setConfirmar] = useState<Branch | null>(null);
  // Mes que se timbra. El lote SIEMPRE va acotado a un mes (como el legacy): sin ese
  // corte se timbraría el atraso histórico de facturas marcadas desde 2019.
  const [mes, setMes] = useState(() => new Date().toISOString().slice(0, 7));

  // Histórico
  const [stats, setStats] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [all, setAll] = useState("1");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<any>(null);

  // Errores
  const [errData, setErrData] = useState<any>(null);
  const [errLoading, setErrLoading] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const errCount = stats?.tipos?.ERROR ?? 0;

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/einvoice/stats").then(objetoJson).then(setStats).catch(() => {});
    void authFetch("/einvoice/mode").then((r) => (r.ok ? r.json() : null)).then(setEMode).catch(() => {});
    void authFetch("/einvoice/branches").then((r) => (r.ok ? r.json() : [])).then(setBranches).catch(() => setBranches([]));
  }, [authLoading, authFetch]);

  const loadBranches = useCallback(() => {
    void authFetch("/einvoice/branches").then((r) => (r.ok ? r.json() : [])).then(setBranches).catch(() => {});
  }, [authFetch]);

  // Carga con cancelación: al teclear se aborta la petición en vuelo, para que
  // una respuesta lenta no pise a otra más nueva. Ver lib/useRequest.
  // El histórico pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const { data, cargando: loading, error, refrescar: load } = useRequest<any>(
    () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: "25", ...orden.params });
      if (search.trim()) qs.set("search", search.trim());
      if (type) qs.set("type", type);
      if (all) qs.set("all", all);
      return `/einvoice?${qs}`;
    },
    [page, search, type, all, orden.clave],
    { debounceMs: search ? 350 : 0, saltar: authLoading || tab !== "historico" },
  );
  useEffect(() => { setPage(1); }, [search, type, all, orden.clave]);

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
    void authFetch("/einvoice/stats").then(objetoJson).then(setStats).catch(() => {});
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
    } catch (e) {
      toast(mensajeDeError(e) ?? "Error al reintentar", "alert-circle");
    } finally {
      setRetryingId(null);
    }
  }

  async function emitBranch(b: Branch) {
    setEmittingBranch(b.id);
    try {
      const res = await authFetch(`/einvoice/emit-branch/${b.id}?mes=${mes}`, { method: "POST" });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "No se pudo emitir la facturación de la sede");
      let msg = d.message as string;
      if (d.dryRun && d.configReady === false) msg += " Configura las cuentas Siigo para emitir de verdad.";
      if (d.hasMore) msg += " Quedan más pendientes: vuelve a emitir para continuar.";
      if (d.failed) msg += ` (${d.failed} con error)`;
      toast(msg, d.failed ? "alert-triangle" : "check");
      loadBranches();
    } catch (e) {
      toast(mensajeDeError(e) ?? "Error al emitir la sede", "alert-circle");
    } finally {
      setEmittingBranch(null);
      setConfirmar(null);
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
          <>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <Field label="Mes a timbrar"><Input type="month" value={mes} onChange={(e) => setMes(e.target.value)} className="w-44" /></Field>
            <p className="pb-2 text-[12px] text-text-tertiary">Se emiten solo las facturas de ese mes que estén pendientes por timbrar.</p>
          </div>
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
                  <button type="button" onClick={() => setConfirmar(r)} disabled={emittingBranch === r.id}
                    title={eMode?.live ? "Emitir e-factura de la sede (DIAN)" : "Emitir e-factura de la sede (DRY-RUN)"}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-[12px] font-semibold text-on-brand transition-colors hover:bg-brand-hover disabled:opacity-50">
                    <Icon name={emittingBranch === r.id ? "loader" : "file-signature"} size={14} className={emittingBranch === r.id ? "animate-spin" : ""} /> {emittingBranch === r.id ? "Emitiendo…" : "Emitir e-factura"}
                  </button>
                </div>
              ) },
            ]}
          />
          </>
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
              <DataTable rows={data?.items ?? []} empty="Sin facturas electrónicas." sort={orden.sort} onSort={orden.onSort} columns={[
                { key: "date", header: "Fecha", sortable: true, render: (r: any) => fmtDate(r.date) },
                { key: "client", header: "Cliente", sortable: true, render: (r: any) => r.subscriberId ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline">{r.client}</Link> : <span>{r.client}</span> },
                { key: "serv", header: "Servicio", sortable: true, render: (r: any) => <span className="text-text-secondary">{r.services ?? "—"}</span> },
                { key: "type", header: "Tipo", sortable: true, render: (r: any) => <Badge label={r.type} tone="info" /> },
                { key: "fact", header: "Factura", sortable: true, render: (r: any) => r.invoiceTid ? <span className="font-mono text-text-tertiary">#{r.invoiceTid}</span> : "—" },
                { key: "dian", header: "N° DIAN", sortable: true, render: (r: any) => r.dianNumber ? <span className="font-mono text-success-text">{r.dianNumber}</span> : <span className="text-text-tertiary">—</span> },
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

      {confirmar && (
        <ConfirmDialog
          open
          busy={emittingBranch === confirmar.id}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void emitBranch(confirmar)}
          tone={eMode?.live ? "danger" : "primary"}
          icon="file-signature"
          title={eMode?.live ? "Emitir en lote ante la DIAN" : "Probar emisión en lote (dry-run)"}
          confirmLabel={eMode?.live ? "Emitir la sede ante la DIAN" : "Construir payloads"}
          // Emisión masiva: en LIVE se exige teclear el nombre de la sede, porque
          // el error no afecta a una factura sino a todas las de la sede.
          requireText={eMode?.live ? confirmar.name : undefined}
          requireHint={<>Para confirmar, escribe el nombre de la sede <span className="font-mono font-semibold text-text-primary">{confirmar.name}</span></>}
          message={
            eMode?.live ? (
              <>
                Se timbrarán ante la DIAN, de una sola vez, las facturas de <b>{mes}</b> pendientes
                de todos los clientes marcados de <b>{confirmar.name}</b> ({n(confirmar.tv)} con TV y{" "}
                {n(confirmar.internet)} con Internet, sobre {n(confirmar.subscribers)} clientes).{" "}
                <b className="text-error-text">Cada una queda emitida legalmente y no se puede
                deshacer</b>: corregirlas exige una nota crédito por factura.
              </>
            ) : (
              <>
                Estás en <b>modo prueba (dry-run)</b>: se construyen los payloads de las facturas
                de <b>{mes}</b> pendientes de <b>{confirmar.name}</b> ({n(confirmar.tv)} marcados TV y{" "}
                {n(confirmar.internet)} marcados Internet) solo para validarlos. No se envía nada
                a la DIAN.
              </>
            )
          }
          detail={<SedeResumen b={confirmar} />}
        />
      )}
    </>
  );
}

/** Ficha compacta de la sede: qué volumen se va a timbrar de golpe. */
function SedeResumen({ b }: { b: Branch }) {
  const filas: [string, React.ReactNode][] = [
    ["Sede", <span key="a" className="font-semibold">{b.name}</span>],
    ["Clientes", <span key="b" className="font-mono">{n(b.subscribers)}</span>],
    ["Marcados TV", <span key="c" className="font-mono">{n(b.tv)}</span>],
    ["Marcados Internet", <span key="d" className="font-mono">{n(b.internet)}</span>],
  ];
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-2 p-2.5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
        {filas.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-text-tertiary">{k}</dt>
            <dd className="text-right text-text-primary">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
