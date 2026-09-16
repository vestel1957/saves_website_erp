"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Input, Select, Field } from "@/components/ui/Field";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import dynamic from "next/dynamic";
import { toast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import { INVOICE_STATUS_LABEL, INVOICE_STATUS_TONE, cop } from "@/lib/subscribers";
import {
  type InvoiceList, type InvoiceRow, type BillingStats, RON_LABEL,
} from "@/lib/billing";
import { fmtDate } from "@/lib/format";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { listaJson, mensajeDeError, objetoJson } from "@/lib/errores";

const NuevaFacturaModal = dynamic(() => import("@/components/billing/NuevaFacturaModal").then((m) => m.NuevaFacturaModal), { ssr: false });
const GenerarFacturasModal = dynamic(() => import("@/components/billing/GenerarFacturasModal").then((m) => m.GenerarFacturasModal), { ssr: false });

const isOverdue = (r: InvoiceRow) => r.balance > 0 && !!r.dueDate && new Date(r.dueDate).getTime() < Date.now();

export default function FacturacionPage() {
  const { loading: authLoading, authFetch, can, isSuperadmin, sedeScoped, puedeEmitirNotas } = useAuth();
  const canEmit = isSuperadmin || can(PERM.AREA_CONTABILIDAD);
  const [eMode, setEMode] = useState<{ live: boolean } | null>(null);
  const [emittingId, setEmittingId] = useState<string | null>(null);
  const [confirmar, setConfirmar] = useState<InvoiceRow | null>(null);
  const [stats, setStats] = useState<BillingStats | null>(null);
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [ron, setRon] = useState("");
  const [branchId, setBranchId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [overdue, setOverdue] = useState(false);
  // Histórico completo: sin esto el listado solo alcanzaba el año en curso y no había
  // forma de llegar a una factura vieja salvo adivinando un rango de fechas.
  const [todo, setTodo] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [nuevaOpen, setNuevaOpen] = useState(false);
  const [generarOpen, setGenerarOpen] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const anyFilter = !!(search || status || ron || branchId || from || to || overdue || todo);
  // Filtros "avanzados" que viven en el panel colapsable (se muestran como chips
  // cuando el panel está cerrado, para no perder contexto sin ocupar espacio).
  const chips = [
    status && { key: "status", label: `Pago: ${INVOICE_STATUS_LABEL[status] ?? status}`, clear: () => setStatus("") },
    ron && { key: "ron", label: `Servicio: ${RON_LABEL[ron] ?? ron}`, clear: () => setRon("") },
    branchId && { key: "branch", label: `Sede: ${branches.find((b) => b.id === branchId)?.name ?? "—"}`, clear: () => setBranchId("") },
    from && { key: "from", label: `Desde ${from}`, clear: () => setFrom("") },
    to && { key: "to", label: `Hasta ${to}`, clear: () => setTo("") },
    todo && { key: "todo", label: "Todo el histórico", clear: () => setTodo(false) },
  ].filter(Boolean) as { key: string; label: string; clear: () => void }[];

  // El listado pagina en el servidor, así que el orden va con él.
  const orden = useOrden();

  // Construye el querystring de filtros (compartido por load y export).
  const filterQs = useCallback((extra?: Record<string, string>) => {
    const qs = new URLSearchParams(extra);
    if (search.trim()) qs.set("search", search.trim());
    if (status) qs.set("status", status);
    if (ron) qs.set("ron", ron);
    if (branchId) qs.set("branchId", branchId);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    if (overdue) qs.set("overdue", "1");
    if (todo) qs.set("all", "1");
    return qs;
  }, [search, status, ron, branchId, from, to, overdue, todo]);

  const loadStats = useCallback(() => {
    void authFetch("/billing/stats").then(objetoJson).then(setStats).catch(() => {});
  }, [authFetch]);

  // Hidrata los filtros desde la URL al montar (deep-links / recargar).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const g = (k: string) => sp.get(k) ?? "";
    if (g("search")) setSearch(g("search"));
    if (g("status")) setStatus(g("status"));
    if (g("ron")) setRon(g("ron"));
    if (g("branchId")) setBranchId(g("branchId"));
    if (g("from")) setFrom(g("from"));
    if (g("to")) setTo(g("to"));
    if (g("overdue")) setOverdue(g("overdue") === "1");
    if (g("all")) setTodo(g("all") === "1");
    setHydrated(true);
  }, []);

  // Sincroniza los filtros activos hacia la URL (sin recargar la página).
  useEffect(() => {
    if (!hydrated) return;
    const qs = filterQs().toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [hydrated, filterQs]);

  useEffect(() => {
    if (authLoading) return;
    loadStats();
    void authFetch("/subscribers/branches").then(listaJson).then(setBranches).catch(() => {});
    if (canEmit) void authFetch("/einvoice/mode").then((r) => (r.ok ? r.json() : null)).then(setEMode).catch(() => {});
  }, [authLoading, authFetch, loadStats, canEmit]);

  // Carga con cancelación: al teclear se aborta la petición en vuelo para que
  // una respuesta lenta no pise a otra más reciente. Ver lib/useRequest.
  const { data, cargando: loading, error, refrescar: load } = useRequest<InvoiceList>(
    () => {
      const qs = filterQs({ page: String(page), pageSize: String(pageSize), ...orden.params });
      return `/billing/invoices?${qs.toString()}`;
    },
    [filterQs, page, pageSize, orden.clave],
    { debounceMs: search ? 350 : 0, saltar: authLoading || !hydrated },
  );

  useEffect(() => { setPage(1); }, [search, status, ron, branchId, from, to, overdue, todo, pageSize, orden.clave]);

  function clearFilters() {
    setSearch(""); setStatus(""); setRon(""); setBranchId(""); setFrom(""); setTo(""); setOverdue(false); setTodo(false);
  }

  async function openPdf(id: string) {
    const res = await authFetch(`/billing/invoices/${id}/pdf`);
    if (!res.ok) { toast("No se pudo abrir el PDF", "x"); return; }
    const url = URL.createObjectURL(await res.blob());
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function sendWhatsapp(id: string, tid: number) {
    setSendingId(id);
    try {
      const res = await authFetch(`/billing/invoices/${id}/whatsapp`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast(d?.message ?? "No se pudo enviar", "x"); return; }
      if (d.sent) toast(`Factura #${tid} enviada por WhatsApp`, "check");
      else toast("WhatsApp no está configurado — se registró en el log", "send");
    } catch (e) { toast(mensajeDeError(e) ?? "Error enviando WhatsApp", "x"); }
    finally { setSendingId(null); }
  }

  async function sendEmail(id: string, tid: number) {
    setSendingId(id);
    try {
      const res = await authFetch(`/billing/invoices/${id}/email`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast(d?.message ?? "No se pudo enviar", "x"); return; }
      if (d.sent) toast(`Factura #${tid} enviada por correo`, "check");
      else toast(d?.error === "SMTP no configurado" ? "Correo no configurado — revisa Ajustes" : (d?.error ?? "No se pudo enviar el correo"), "send");
    } catch (e) { toast(mensajeDeError(e) ?? "Error enviando correo", "x"); }
    finally { setSendingId(null); }
  }

  async function creditNote(r: InvoiceRow) {
    const live = !!eMode?.live;
    const reason = window.prompt(
      (live
        ? `Vas a emitir una NOTA CRÉDITO ante la DIAN para la factura #${r.tid} (acto legal). `
        : `Modo PRUEBA (DRY-RUN) — nota crédito de la factura #${r.tid}. `) + "Escribe el motivo:",
      "Anulación de factura",
    );
    if (reason == null || reason.trim().length < 3) return;
    setEmittingId(r.id);
    try {
      const res = await authFetch(`/einvoice/credit-note/${r.id}`, { method: "POST", body: JSON.stringify({ reason: reason.trim(), cause: 2 }) });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "No se pudo emitir la nota crédito");
      if (d.dryRun) toast(`DRY-RUN: nota crédito de #${r.tid} construida, no se envió a la DIAN.`, "info");
      else toast(`Nota crédito de #${r.tid} emitida: ${d.dianNumber}`, "check");
      load();
    } catch (e) { toast(mensajeDeError(e) ?? "Error al emitir la nota crédito", "alert-circle"); }
    finally { setEmittingId(null); }
  }

  async function emitEinvoice(r: InvoiceRow) {
    setEmittingId(r.id);
    try {
      const res = await authFetch(`/einvoice/emit/${r.id}`, { method: "POST" });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "No se pudo emitir la factura electrónica");
      if (d.dryRun) toast(`DRY-RUN: payload de #${r.tid} construido, no se envió a la DIAN.`, "info");
      else toast(`Factura #${r.tid} emitida ante la DIAN: ${d.dianNumber}`, "check");
      load();
    } catch (e) {
      toast(mensajeDeError(e) ?? "Error al emitir", "alert-circle");
    } finally {
      setEmittingId(null);
      setConfirmar(null);
    }
  }

  async function exportCsv() {
    setExporting(true);
    try {
      let rows: InvoiceRow[] = [];
      let p = 1, pages = 1;
      do {
        const qs = filterQs({ page: String(p), pageSize: "100" });
        const d: InvoiceList = await (await authFetch(`/billing/invoices?${qs.toString()}`)).json();
        rows = rows.concat(d.items ?? []);
        pages = d.pages ?? 1;
        p++;
      } while (p <= pages && p <= 60); // tope de seguridad (~6000 filas)
      if (!rows.length) { toast("No hay facturas para exportar", "send"); return; }
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const header = ["N°", "Cliente", "Abonado", "Servicio", "Fecha", "Vence", "Total", "Pagado", "Saldo", "Estado"];
      const lines = rows.map((r) => [
        r.tid, r.subscriber, r.abonado ?? "", r.service ?? "", fmtDate(r.date), fmtDate(r.dueDate),
        r.total, r.paid, r.balance, INVOICE_STATUS_LABEL[r.status] ?? r.status,
      ].map(esc).join(","));
      const csv = "﻿" + [header.map(esc).join(","), ...lines].join("\r\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `facturas-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast(`${rows.length} factura(s) exportada(s)`, "check");
    } catch (e) { toast(mensajeDeError(e) ?? "Error al exportar", "x"); }
    finally { setExporting(false); }
  }

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading
          icon="receipt"
          title="Facturación"
          subtitle={stats ? `${stats.total.toLocaleString("es-CO")} facturas · cartera ${cop(stats.carteraTotal)}` : "Facturas y cartera"}
        />
        <div className="flex items-center gap-2">
          {/* Lleva a Configuración ▸ Automatizaciones, que la cajera no puede abrir:
              sin este gate el enlace la sacaba a una pantalla en 403. */}
          {canEmit && (
            <Link
              href="/configuracion/automatizaciones"
              title="La facturación recurrente se genera automáticamente el día 1 de cada mes"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border-default bg-surface px-3.5 py-2 text-[13px] font-semibold text-text-secondary transition-colors hover:bg-surface-2"
            >
              <Icon name="calendar-clock" size={15} /> Generación automática
            </Link>
          )}
          {canEmit && (
            <button
              type="button"
              onClick={() => setGenerarOpen(true)}
              title="Emite la mensualidad del mes a los abonados activos"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border-default bg-surface px-3.5 py-2 text-[13px] font-semibold text-text-secondary transition-colors hover:bg-surface-2"
            >
              <Icon name="layers" size={15} /> Generar facturas del mes
            </button>
          )}
          <button
            type="button"
            onClick={() => setNuevaOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hover"
          >
            <Icon name="file-plus" size={15} /> Nueva factura
          </button>
        </div>
      </div>

      {nuevaOpen && (
        <NuevaFacturaModal
          open={nuevaOpen}
          onClose={() => setNuevaOpen(false)}
          onDone={() => { load(); loadStats(); }}
        />
      )}

      {generarOpen && (
        <GenerarFacturasModal
          open={generarOpen}
          onClose={() => setGenerarOpen(false)}
          onDone={() => { load(); loadStats(); }}
        />
      )}

      {/* Barra compacta: buscar + accesos rápidos. Los filtros avanzados viven en un panel colapsable. */}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Buscar por N° factura, cliente, documento o abonado…"
        actions={
          data && (
            <span className="whitespace-nowrap text-[12px] text-text-tertiary">
              <span className="font-semibold text-text-secondary">{data.total.toLocaleString("es-CO")}</span> facturas · saldo{" "}
              <span className="font-semibold text-error-text">{cop(data.sum?.balance ?? 0)}</span>
            </span>
          )
        }
      >
        <button
          type="button"
          onClick={() => setOverdue((v) => !v)}
          title="Solo facturas vencidas con saldo"
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] font-semibold transition-colors ${overdue ? "border-error bg-error-soft text-error-text" : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"}`}
        >
          <Icon name="alert-triangle" size={14} /> Vencidas
        </button>

        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] font-semibold transition-colors ${filtersOpen || chips.length ? "border-brand bg-brand-soft text-brand" : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"}`}
        >
          <Icon name="sliders-horizontal" size={14} /> Filtros
          {chips.length > 0 && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-on-brand">{chips.length}</span>}
          <Icon name={filtersOpen ? "chevron-up" : "chevron-down"} size={14} />
        </button>

        <button
          type="button"
          onClick={exportCsv}
          disabled={exporting}
          title="Exportar el set filtrado a CSV"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border-default bg-surface px-3 py-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          <Icon name={exporting ? "loader" : "download"} size={14} className={exporting ? "animate-spin" : ""} /> <span className="hidden sm:inline">{exporting ? "Exportando…" : "Exportar"}</span>
        </button>
      </ListToolbar>

      {/* Panel de filtros avanzados (colapsable). */}
      {filtersOpen && (
        <div className="rounded-xl border border-border-subtle bg-surface-subtle p-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Field label="Estado de pago">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Todos</option>
                {Object.entries(INVOICE_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="Estado de servicio">
              <Select value={ron} onChange={(e) => setRon(e.target.value)}>
                <option value="">Todos</option>
                {Object.entries(RON_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            {/* Sin selector de sede para quien está acotado a la suya (ver isSedeScoped). */}
            {!sedeScoped && (
              <Field label="Sede">
                <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                  <option value="">Todas</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Desde"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="Hasta"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            <Field label="Periodo">
              <Select value={todo ? "1" : ""} onChange={(e) => setTodo(e.target.value === "1")} disabled={!!(from || to)}>
                <option value="">Año en curso</option>
                <option value="1">Todo el histórico</option>
              </Select>
            </Field>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-[12px] text-text-tertiary">
              {data && <>Facturado <span className="font-semibold text-text-secondary">{cop(data.sum?.total ?? 0)}</span> · saldo <span className="font-semibold text-error-text">{cop(data.sum?.balance ?? 0)}</span></>}
            </span>
            {anyFilter && (
              <button type="button" onClick={clearFilters} className="rounded-lg border border-border-default bg-surface px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2">
                Limpiar filtros
              </button>
            )}
          </div>
        </div>
      )}

      {/* Chips de filtros activos cuando el panel está cerrado. */}
      {!filtersOpen && chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <button key={c.key} type="button" onClick={c.clear}
              className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-2">
              {c.label} <Icon name="x" size={12} className="text-text-tertiary" />
            </button>
          ))}
          <button type="button" onClick={clearFilters} className="px-1 text-[11px] font-semibold text-brand hover:underline">Limpiar todo</button>
        </div>
      )}

      {loading && !data ? <PageSkeleton /> : (
        <div className="flex flex-col gap-3">
          <DataTable
            rows={data?.items ?? []}
            empty={data?.scope === "anio"
              // "No hay" y "no hay en 2026" no son lo mismo: el listado arranca en el
              // año en curso, y callarlo es lo que hacía pensar que una factura
              // importada de 2024 no se había migrado.
              ? `No se encontraron facturas de ${data.scopeYear}. El listado parte del año en curso: en Filtros → Periodo elige «Todo el histórico».`
              : "No se encontraron facturas."}
            sort={orden.sort}
            onSort={orden.onSort}
            columns={[
              { key: "tid", header: "N°", sortable: true, render: (r) => <span className="font-mono text-text-secondary">{r.tid}</span> },
              { key: "sub", header: "Cliente", sortable: true, render: (r) => r.subscriberId
                ? <Link href={`/clientes/${r.subscriberId}`} className="font-medium text-brand hover:underline">{r.subscriber}</Link>
                : <span className="font-medium text-text-primary">{r.subscriber}</span> },
              // Servicio (lo que factura una recurrente) o MOTIVO (por qué existe una
              // fija): sin el motivo, un traslado y una venta de equipo se ven igual
              // en la lista y hay que abrir las dos para saber cuál es cuál.
              { key: "service", header: "Servicio o motivo", sortable: true, render: (r) => (
                <span className="flex flex-wrap items-center gap-1.5 text-text-secondary">
                  {r.service ?? (r.purposeLabel ? null : "—")}
                  {r.purposeLabel && <Badge label={r.purposeLabel} tone="info" />}
                </span>
              ) },
              { key: "date", header: "Fecha", sortable: true, render: (r) => fmtDate(r.date) },
              { key: "due", header: "Vence", sortable: true, render: (r) => (
                <span className={isOverdue(r) ? "inline-flex items-center gap-1 font-semibold text-error-text" : "text-text-secondary"}>
                  {isOverdue(r) && <Icon name="alert-triangle" size={12} />}{fmtDate(r.dueDate)}
                </span>
              ) },
              { key: "total", header: "Total", sortable: true, align: "right", render: (r) => cop(r.total) },
              { key: "balance", header: "Saldo", align: "right", render: (r) => <span className={r.balance > 0 ? "font-semibold text-error-text" : "text-text-tertiary"}>{cop(r.balance)}</span> },
              { key: "status", header: "Pago", sortable: true, render: (r) => <Badge label={INVOICE_STATUS_LABEL[r.status] ?? r.status} tone={INVOICE_STATUS_TONE[r.status] ?? "default"} /> },
              { key: "actions", header: "", align: "right", render: (r) => (
                <div className="flex items-center justify-end gap-1">
                  <button type="button" onClick={() => openPdf(r.id)} title="Ver / imprimir PDF"
                    className="tap rounded-lg border border-border-default p-1.5 text-text-secondary transition-colors hover:bg-surface-2"><Icon name="file-text" size={14} /></button>
                  <button type="button" onClick={() => sendWhatsapp(r.id, r.tid)} disabled={sendingId === r.id} title="Enviar por WhatsApp"
                    className="tap rounded-lg border border-border-default p-1.5 text-text-secondary transition-colors hover:bg-surface-2 disabled:opacity-40">
                    <Icon name={sendingId === r.id ? "loader" : "message-circle"} size={14} className={sendingId === r.id ? "animate-spin" : ""} /></button>
                  <button type="button" onClick={() => sendEmail(r.id, r.tid)} disabled={sendingId === r.id} title="Enviar por correo"
                    className="tap rounded-lg border border-border-default p-1.5 text-text-secondary transition-colors hover:bg-surface-2 disabled:opacity-40">
                    <Icon name={sendingId === r.id ? "loader" : "mail"} size={14} className={sendingId === r.id ? "animate-spin" : ""} /></button>
                  {canEmit && (r.eInvoiceFlag === "Factura Electronica Creada"
                    ? <>
                        <span title="Factura electrónica ya emitida" className="inline-flex rounded-lg border border-success/40 bg-success-soft p-1.5 text-success-text"><Icon name="file-signature" size={14} /></span>
                        {/* La nota crédito DIAN es el mismo acto que la nota del
                            módulo de notas, así que lleva el mismo candado nominal.
                            OJO: sin ella no se puede anular una factura ya timbrada. */}
                        {puedeEmitirNotas && (
                          <button type="button" onClick={() => creditNote(r)} disabled={emittingId === r.id} title={eMode?.live ? "Nota crédito (DIAN)" : "Nota crédito (DRY-RUN)"}
                            className="tap rounded-lg border border-border-default p-1.5 text-text-secondary transition-colors hover:bg-surface-2 disabled:opacity-40">
                            <Icon name={emittingId === r.id ? "loader" : "receipt"} size={14} className={emittingId === r.id ? "animate-spin" : ""} /></button>
                        )}
                      </>
                    : <button type="button" onClick={() => setConfirmar(r)} disabled={emittingId === r.id} title={eMode?.live ? "Emitir e-factura (DIAN)" : "Emitir e-factura (DRY-RUN)"}
                        className="tap rounded-lg border border-border-default p-1.5 text-text-secondary transition-colors hover:bg-surface-2 disabled:opacity-40">
                        <Icon name={emittingId === r.id ? "loader" : "file-signature"} size={14} className={emittingId === r.id ? "animate-spin" : ""} /></button>)}
                  {/* Editar abre el detalle con el editor ya desplegado: la edición
                      necesita los conceptos de la factura, que la lista no trae. */}
                  {canEmit && r.status !== "CANCELED" && (
                    <Link href={`/facturacion/${r.id}?editar=1`} title="Editar factura"
                      className="tap inline-flex rounded-lg border border-border-default p-1.5 text-text-secondary transition-colors hover:bg-surface-2">
                      <Icon name="pencil" size={14} /></Link>
                  )}
                  <Link href={`/facturacion/${r.id}`} title="Ver detalle"
                    className="inline-flex items-center rounded-lg border border-border-default px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">Ver</Link>
                </div>
              ) },
            ]}
          />
          {data && (
            <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} />
          )}
        </div>
      )}

      {confirmar && (
        <ConfirmDialog
          open
          busy={emittingId === confirmar.id}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void emitEinvoice(confirmar)}
          tone={eMode?.live ? "danger" : "primary"}
          icon="file-signature"
          title={eMode?.live ? "Emitir factura ante la DIAN" : "Probar emisión (dry-run)"}
          confirmLabel={eMode?.live ? "Emitir ante la DIAN" : "Construir payload"}
          // Solo en LIVE se exige teclear el número: en dry-run no sale nada hacia la DIAN.
          requireText={eMode?.live ? String(confirmar.tid) : undefined}
          requireHint={<>Para confirmar, escribe el número de factura <span className="font-mono font-semibold text-text-primary">{confirmar.tid}</span></>}
          message={
            eMode?.live ? (
              <>
                La factura #{confirmar.tid} se timbrará ante la DIAN y quedará con número y CUFE
                oficiales. <b className="text-error-text">Es un acto legal irreversible</b>: para
                deshacerlo hay que emitir una nota crédito.
              </>
            ) : (
              <>
                Estás en <b>modo prueba (dry-run)</b>: solo se construye el payload de la factura
                #{confirmar.tid} para validarlo. No se envía nada a la DIAN ni se timbra.
              </>
            )
          }
          detail={<FacturaResumen r={confirmar} />}
        />
      )}
    </>
  );
}

/** Ficha compacta de la factura que se va a timbrar: la fila es fácil de confundir. */
function FacturaResumen({ r }: { r: InvoiceRow }) {
  const filas: [string, React.ReactNode][] = [
    ["Factura", <span key="a" className="font-mono">#{r.tid}</span>],
    ["Cliente", <span key="b">{r.subscriber}</span>],
    ["Fecha", <span key="c">{fmtDate(r.date)}</span>],
    ["Total", <span key="d" className="font-mono font-semibold">{cop(r.total)}</span>],
    ["Pago", <Badge key="e" label={INVOICE_STATUS_LABEL[r.status] ?? r.status} tone={INVOICE_STATUS_TONE[r.status] ?? "default"} />],
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
