"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/inventory/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import dynamic from "next/dynamic";

const NuevaNotaModal = dynamic(() => import("@/components/billing/NuevaNotaModal").then((m) => m.NuevaNotaModal), { ssr: false });

export default function NotasPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [openNew, setOpenNew] = useState(false);
  const [detail, setDetail] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search.trim()) qs.set("search", search.trim());
    if (type) qs.set("type", type);
    try { setData(await (await authFetch(`/billing/notes?${qs}`)).json()); }
    finally { setLoading(false); }
  }, [authFetch, page, pageSize, search, type]);

  useEffect(() => { if (!authLoading) { const t = setTimeout(load, search ? 350 : 0); return () => clearTimeout(t); } }, [authLoading, load]);
  useEffect(() => { setPage(1); }, [search, type, pageSize]);

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <PageHeading icon="file-text" title="Notas crédito / débito" subtitle="Ajustes sobre facturas (rebaja o recargo)" />

      {/* Barra única: búsqueda (se estira) + filtro de tipo + acción, todo en una línea. */}
      <div className="mb-3 -mt-2 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder="Buscar por N° de factura, cliente o descripción…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-auto shrink-0">
          <option value="">Todos los tipos</option>
          <option value="CREDITO">Nota crédito</option>
          <option value="DEBITO">Nota débito</option>
        </Select>
        <Button onClick={() => setOpenNew(true)} className="shrink-0 whitespace-nowrap">
          <Icon name="plus" size={15} className="mr-1.5" />
          Nueva nota
        </Button>
      </div>

      {loading && !data ? <PageSkeleton /> : (
        <>
          <DataTable
            autoHeight
            rows={data?.items ?? []}
            empty="No se encontraron notas."
            columns={[
              { key: "date", header: "Fecha", render: (r: any) => (r.date ? new Date(r.date).toLocaleDateString("es-CO") : "—") },
              { key: "type", header: "Tipo", render: (r: any) => <Badge label={r.type === "CREDITO" ? "Crédito" : "Débito"} tone={r.type === "CREDITO" ? "success" : "warning"} /> },
              { key: "tid", header: "Factura", render: (r: any) => r.invoiceId ? <Link href={`/facturacion/${r.invoiceId}`} className="font-mono text-brand hover:underline">#{r.tid}</Link> : "—" },
              { key: "sub", header: "Cliente", render: (r: any) => <span className="text-text-secondary">{r.subscriber}</span> },
              { key: "desc", header: "Descripción", render: (r: any) => <span className="text-text-tertiary">{r.description || "—"}</span> },
              { key: "amount", header: "Monto", align: "right", render: (r: any) => <span className={`font-semibold ${r.type === "CREDITO" ? "text-success-text" : "text-warning-text"}`}>{r.type === "CREDITO" ? "-" : "+"}{cop(r.amount)}</span> },
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

      {openNew && <NuevaNotaModal open={openNew} onClose={() => setOpenNew(false)} onDone={load} />}

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
