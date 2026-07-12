"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/inventory/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Field";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { type TxRow, type TxList, TX_TYPE_LABEL, TX_TYPE_TONE } from "@/lib/treasury";

const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString("es-CO") : "—");

/** Celda de comprobante: "Ver" si ya hay adjunto; si no, botón para subir (imagen/PDF). */
function ComprobanteCell({ tx, onChange }: { tx: TxRow; onChange: () => void }) {
  const { authFetch } = useAuth();
  const [busy, setBusy] = useState(false);

  async function ver() {
    try {
      const res = await authFetch(`/treasury/transactions/${tx.id}/attachment`);
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { toast("No se pudo abrir el comprobante", "alert-triangle"); }
  }
  async function subir(file: File) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await authFetch(`/treasury/transactions/${tx.id}/attach`, { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo subir");
      toast("Comprobante adjuntado", "check");
      onChange();
    } catch (e: any) { toast(e.message, "alert-triangle"); } finally { setBusy(false); }
  }

  if (tx.attach) {
    return (
      <button type="button" onClick={ver} title={tx.attachName ?? "Ver comprobante"}
        className="inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:underline">
        <Icon name="file-text" size={13} /> Ver
      </button>
    );
  }
  return (
    <label className="inline-flex cursor-pointer items-center gap-1 text-[12px] font-medium text-text-tertiary hover:text-text-secondary">
      <Icon name="upload" size={13} /> {busy ? "Subiendo…" : "Adjuntar"}
      <input type="file" accept="image/*,application/pdf" className="hidden" disabled={busy}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void subir(f); e.target.value = ""; }} />
    </label>
  );
}

/**
 * Lista de transacciones de tesorería con un filtro fijo (por tipo o estado).
 * La reusan las páginas de Ingresos, Egresos y Anulaciones; cada una aporta su
 * cabecera/acciones y refresca la tabla subiendo `refreshKey`.
 */
export function TxTable({
  params,
  refreshKey = 0,
  rowAction,
  extraColumns,
  empty = "No se encontraron movimientos.",
}: {
  params: { type?: string; status?: string };
  refreshKey?: number;
  rowAction?: (r: TxRow) => ReactNode;
  extraColumns?: { key: string; header: string; align?: "right"; render: (r: TxRow) => ReactNode }[];
  empty?: string;
}) {
  const { loading: authLoading, authFetch } = useAuth();
  const [data, setData] = useState<TxList | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search.trim()) qs.set("search", search.trim());
    if (params.type) qs.set("type", params.type);
    if (params.status) qs.set("status", params.status);
    try { setData(await (await authFetch(`/treasury/transactions?${qs}`)).json()); }
    finally { setLoading(false); }
  }, [authFetch, page, pageSize, search, params.type, params.status]);

  useEffect(() => { if (!authLoading) { const t = setTimeout(load, search ? 350 : 0); return () => clearTimeout(t); } }, [authLoading, load, refreshKey]);
  useEffect(() => { setPage(1); }, [search, pageSize]);

  if (authLoading || (loading && !data)) return <PageSkeleton />;

  return (
    <div className="flex flex-col gap-3">
      <div className="relative max-w-md">
        <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
        <Input className="pl-9" placeholder="Buscar por pagador, nota o cuenta…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <DataTable
        autoHeight
        rows={data?.items ?? []}
        empty={empty}
        columns={[
          { key: "date", header: "Fecha", render: (r: TxRow) => fmt(r.date) },
          { key: "type", header: "Tipo", render: (r: TxRow) => <Badge label={TX_TYPE_LABEL[r.type] ?? r.type} tone={TX_TYPE_TONE[r.type] ?? "info"} /> },
          { key: "payer", header: "Pagador / Beneficiario", render: (r: TxRow) => r.subscriberId
            ? <Link href={`/clientes/${r.subscriberId}`} className="font-medium text-brand hover:underline">{r.payer}</Link>
            : <span className="text-text-primary">{r.payer}</span> },
          { key: "cat", header: "Categoría", render: (r: TxRow) => <span className="text-text-secondary">{r.category}</span> },
          { key: "fact", header: "Factura", render: (r: TxRow) => r.invoiceTid ? <span className="font-mono text-text-tertiary">#{r.invoiceTid}</span> : "—" },
          { key: "method", header: "Método", render: (r: TxRow) => r.method ?? "—" },
          { key: "amount", header: "Monto", align: "right" as const, render: (r: TxRow) => <span className={`font-semibold ${r.type === "EXPENSE" ? "text-error-text" : "text-success-text"}`}>{r.type === "EXPENSE" ? "-" : "+"}{cop(r.amount)}</span> },
          { key: "comprobante", header: "Comprobante", render: (r: TxRow) => <ComprobanteCell tx={r} onChange={load} /> },
          ...(extraColumns ?? []),
          { key: "status", header: "Estado", render: (r: TxRow) => <Badge label={r.status === "ANULADA" ? "Anulada" : "Vigente"} tone={r.status === "ANULADA" ? "error" : "default"} /> },
          ...(rowAction ? [{ key: "acciones", header: "", align: "right" as const, render: rowAction }] : []),
        ]}
      />
      {data && data.pages > 1 && (
        <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} />
      )}
    </div>
  );
}
