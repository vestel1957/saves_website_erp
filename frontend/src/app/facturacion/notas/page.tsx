"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import dynamic from "next/dynamic";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { listaJson } from "@/lib/errores";

const NuevaNotaModal = dynamic(() => import("@/components/billing/NuevaNotaModal").then((m) => m.NuevaNotaModal), { ssr: false });

type Autor = { id: number; name: string; count: number };

export default function NotasPage() {
  const { loading: authLoading, authFetch, sedeScoped, puedeEmitirNotas } = useAuth();
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [branchId, setBranchId] = useState("");
  const [authorId, setAuthorId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [montoMin, setMontoMin] = useState("");
  const [montoMax, setMontoMax] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [openNew, setOpenNew] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Los filtros se hidratan de la URL antes de la primera carga (deep-link /
  // recargar la página): sin esperar a eso se pediría una página sin filtrar.
  const [hydrated, setHydrated] = useState(false);

  const orden = useOrden();

  // Querystring de filtros, en un solo sitio.
  const filterQs = useCallback((extra?: Record<string, string>) => {
    const qs = new URLSearchParams(extra);
    if (search.trim()) qs.set("search", search.trim());
    if (type) qs.set("type", type);
    if (branchId) qs.set("branchId", branchId);
    if (authorId) qs.set("authorId", authorId);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    if (montoMin) qs.set("montoMin", montoMin);
    if (montoMax) qs.set("montoMax", montoMax);
    return qs;
  }, [search, type, branchId, authorId, from, to, montoMin, montoMax]);

  // Hidrata desde la URL al montar.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const g = (k: string) => sp.get(k) ?? "";
    if (g("search")) setSearch(g("search"));
    if (g("type")) setType(g("type"));
    if (g("branchId")) setBranchId(g("branchId"));
    if (g("authorId")) setAuthorId(g("authorId"));
    if (g("from")) setFrom(g("from"));
    if (g("to")) setTo(g("to"));
    if (g("montoMin")) setMontoMin(g("montoMin"));
    if (g("montoMax")) setMontoMax(g("montoMax"));
    setHydrated(true);
  }, []);

  // …y los devuelve a la URL, para poder compartir el listado filtrado.
  useEffect(() => {
    if (!hydrated) return;
    const qs = filterQs().toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [hydrated, filterQs]);

  // Sedes para el desplegable. La cajera no lo ve (está acotada a la suya).
  useEffect(() => {
    if (authLoading || sedeScoped) return;
    void authFetch("/subscribers/branches").then(listaJson).then(setBranches).catch(() => {});
  }, [authLoading, authFetch, sedeScoped]);

  // Carga con cancelación: al teclear se aborta la petición en vuelo para que
  // una respuesta lenta no pise a otra más reciente. Ver lib/useRequest.
  // Pagina en el servidor: el orden viaja en la query.
  const { data, cargando: loading, error, refrescar: load } = useRequest<any>(
    () => `/billing/notes?${filterQs({ page: String(page), pageSize: String(pageSize), ...orden.params })}`,
    [filterQs, page, pageSize, orden.clave],
    { debounceMs: search ? 350 : 0, saltar: authLoading || !hydrated },
  );

  useEffect(() => { setPage(1); }, [search, type, branchId, authorId, from, to, montoMin, montoMax, pageSize, orden.clave]);

  const autores: Autor[] = data?.autores ?? [];
  const hayFiltro = !!(search || type || branchId || authorId || from || to || montoMin || montoMax);

  function limpiar() {
    setSearch(""); setType(""); setBranchId(""); setAuthorId("");
    setFrom(""); setTo(""); setMontoMin(""); setMontoMax("");
  }

  // Chips de lo que está filtrado mientras el panel está cerrado: no se pierde
  // de vista qué se está mirando sin dejar el panel abierto ocupando pantalla.
  const chips = [
    type && { key: "type", label: `Tipo: ${type === "CREDITO" ? "Crédito" : "Débito"}`, clear: () => setType("") },
    branchId && { key: "branch", label: `Sede: ${branches.find((b) => b.id === branchId)?.name ?? "—"}`, clear: () => setBranchId("") },
    authorId && { key: "author", label: `Registró: ${autores.find((a) => String(a.id) === authorId)?.name ?? authorId}`, clear: () => setAuthorId("") },
    from && { key: "from", label: `Desde ${from}`, clear: () => setFrom("") },
    to && { key: "to", label: `Hasta ${to}`, clear: () => setTo("") },
    montoMin && { key: "min", label: `Desde ${cop(Number(montoMin))}`, clear: () => setMontoMin("") },
    montoMax && { key: "max", label: `Hasta ${cop(Number(montoMax))}`, clear: () => setMontoMax("") },
  ].filter(Boolean) as { key: string; label: string; clear: () => void }[];

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <PageHeading icon="file-text" title="Notas crédito / débito" subtitle="Ajustes sobre facturas (rebaja o recargo)" />

      {/* Barra: búsqueda (se estira) + tipo + panel de filtros + acción. */}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Buscar por N° de factura, cliente o descripción…"
        actions={
          // Emitir es NOMINAL (`puedeEmitirNotas`): la pantalla la sigue viendo
          // contabilidad entera —consultar qué se le rebajó a quién es media
          // auditoría—, pero el botón sólo lo tiene quien está autorizado.
          puedeEmitirNotas ? (
            <Button onClick={() => setOpenNew(true)} className="shrink-0 whitespace-nowrap">
              <Icon name="plus" size={15} className="mr-1.5" />
              Nueva nota
            </Button>
          ) : (
            <span
              title="Emitir notas crédito/débito está reservado a las personas autorizadas."
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border-default bg-surface-2 px-3 py-2 text-[12px] font-semibold text-text-tertiary"
            >
              <Icon name="lock" size={14} /> Solo consulta
            </span>
          )
        }
      >
        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-auto shrink-0">
          <option value="">Todos los tipos</option>
          <option value="CREDITO">Nota crédito</option>
          <option value="DEBITO">Nota débito</option>
        </Select>

        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] font-semibold transition-colors ${filtersOpen || chips.length ? "border-brand bg-brand-soft text-brand" : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"}`}
        >
          <Icon name="sliders-horizontal" size={14} /> Filtros
          {chips.length > 0 && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-on-brand">{chips.length}</span>}
          <Icon name={filtersOpen ? "chevron-up" : "chevron-down"} size={14} />
        </button>

        {data && (
          <span className="whitespace-nowrap text-[12px] text-text-tertiary">
            <span className="font-semibold text-text-secondary">{(data.total ?? 0).toLocaleString("es-CO")}</span> notas ·{" "}
            <span className="font-semibold text-success-text">-{cop(data.sum?.credito ?? 0)}</span>{" "}
            <span className="font-semibold text-warning-text">+{cop(data.sum?.debito ?? 0)}</span>
          </span>
        )}
      </ListToolbar>

      {/* Panel de filtros (colapsable). */}
      {filtersOpen && (
        <div className="mb-3 rounded-xl border border-border-subtle bg-surface-subtle p-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {/* Sin selector de sede para quien está acotado a la suya. */}
            {!sedeScoped && (
              <Field label="Sede">
                <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                  <option value="">Todas</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Registrada por">
              <Select value={authorId} onChange={(e) => setAuthorId(e.target.value)}>
                <option value="">Cualquiera</option>
                {autores.map((a) => <option key={a.id} value={String(a.id)}>{a.name} ({a.count})</option>)}
              </Select>
            </Field>
            <Field label="Desde"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="Hasta"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            <Field label="Monto mínimo"><Input type="number" min={0} step={1000} placeholder="0" value={montoMin} onChange={(e) => setMontoMin(e.target.value)} /></Field>
            <Field label="Monto máximo"><Input type="number" min={0} step={1000} placeholder="Sin tope" value={montoMax} onChange={(e) => setMontoMax(e.target.value)} /></Field>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-[12px] text-text-tertiary">
              {data && <>
                Crédito <span className="font-semibold text-success-text">{cop(data.sum?.credito ?? 0)}</span> ({data.count?.credito ?? 0})
                {" · "}débito <span className="font-semibold text-warning-text">{cop(data.sum?.debito ?? 0)}</span> ({data.count?.debito ?? 0})
                {" · "}neto <span className="font-semibold text-text-secondary">{cop(data.sum?.neto ?? 0)}</span>
              </>}
            </span>
            {hayFiltro && (
              <button type="button" onClick={limpiar} className="rounded-lg border border-border-default bg-surface px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2">
                Limpiar filtros
              </button>
            )}
          </div>
        </div>
      )}

      {/* Chips de lo filtrado cuando el panel está cerrado. */}
      {!filtersOpen && chips.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <button key={c.key} type="button" onClick={c.clear}
              className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-2">
              {c.label} <Icon name="x" size={12} className="text-text-tertiary" />
            </button>
          ))}
          <button type="button" onClick={limpiar} className="px-1 text-[11px] font-semibold text-brand hover:underline">Limpiar todo</button>
        </div>
      )}

      {loading && !data ? <PageSkeleton /> : (
        <>
          <DataTable
            sort={orden.sort}
            onSort={orden.onSort}
            rows={data?.items ?? []}
            empty="No se encontraron notas."
            columns={[
              { key: "date", header: "Fecha", sortable: true, render: (r: any) => (r.date ? new Date(r.date).toLocaleDateString("es-CO") : "—") },
              { key: "type", header: "Tipo", sortable: true, render: (r: any) => <Badge label={r.type === "CREDITO" ? "Crédito" : "Débito"} tone={r.type === "CREDITO" ? "success" : "warning"} /> },
              { key: "tid", header: "Factura", sortable: true, render: (r: any) => r.invoiceId ? <Link href={`/facturacion/${r.invoiceId}`} className="font-mono text-brand hover:underline">#{r.tid}</Link> : "—" },
              { key: "sub", header: "Cliente", render: (r: any) => <span className="text-text-secondary">{r.subscriber}</span> },
              { key: "desc", header: "Descripción", sortable: true, render: (r: any) => <span className="text-text-tertiary">{r.description || "—"}</span> },
              { key: "author", header: "Registró", render: (r: any) => <span className="text-text-tertiary">{r.author ?? "—"}</span> },
              { key: "amount", header: "Monto", sortable: true, align: "right", render: (r: any) => <span className={`font-semibold ${r.type === "CREDITO" ? "text-success-text" : "text-warning-text"}`}>{r.type === "CREDITO" ? "-" : "+"}{cop(r.amount)}</span> },
              { key: "detalle", header: "Detalles", align: "right", render: (r: any) => (
                <button
                  type="button"
                  onClick={() => setDetail(r)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border-default px-2.5 py-1 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
                >
                  <Icon name="eye" size={14} />
                  Ver
                </button>
              ) },
            ]}
          />
          {data && data.pages > 1 && (
            <div className="mt-3"><Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} /></div>
          )}
        </>
      )}

      {openNew && puedeEmitirNotas && <NuevaNotaModal open={openNew} onClose={() => setOpenNew(false)} onDone={load} />}

      <Modal open={!!detail} onClose={() => setDetail(null)} title="Detalle de la nota">
        {detail && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <Badge label={detail.type === "CREDITO" ? "Nota crédito" : "Nota débito"} tone={detail.type === "CREDITO" ? "success" : "warning"} />
              <span className={`text-lg font-bold ${detail.type === "CREDITO" ? "text-success-text" : "text-warning-text"}`}>
                {detail.type === "CREDITO" ? "-" : "+"}{cop(detail.amount)}
              </span>
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-[13px]">
              <dt className="text-text-tertiary">Factura</dt>
              <dd className="text-right">
                {detail.invoiceId
                  ? <Link href={`/facturacion/${detail.invoiceId}`} className="font-mono text-brand hover:underline">#{detail.tid}</Link>
                  : <span className="text-text-secondary">—</span>}
              </dd>

              <dt className="text-text-tertiary">Cliente</dt>
              <dd className="text-right text-text-primary">{detail.subscriber || "—"}</dd>

              <dt className="text-text-tertiary">Fecha</dt>
              <dd className="text-right text-text-secondary">
                {detail.date ? new Date(detail.date).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" }) : "—"}
              </dd>

              <dt className="text-text-tertiary">Registrada por</dt>
              <dd className="text-right font-medium text-text-primary">
                {detail.author ?? <span className="font-normal text-text-tertiary">No registrado</span>}
              </dd>
            </dl>

            <div>
              <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">Descripción</p>
              <p className="whitespace-pre-wrap rounded-lg border border-border-subtle bg-surface-2 p-3 text-[13px] text-text-primary">
                {detail.description?.trim() || "Sin descripción."}
              </p>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
