"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/inventory/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Input, Select } from "@/components/ui/Field";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { type TxList, type TreasuryStats, TX_TYPE_LABEL, TX_TYPE_TONE } from "@/lib/treasury";
import dynamic from "next/dynamic";

const EgresoModal = dynamic(() => import("@/components/cobranzas/TesoreriaModals").then((m) => m.EgresoModal), { ssr: false });
const CierreCajaModal = dynamic(() => import("@/components/cobranzas/TesoreriaModals").then((m) => m.CierreCajaModal), { ssr: false });
const AnularModal = dynamic(() => import("@/components/cobranzas/TesoreriaModals").then((m) => m.AnularModal), { ssr: false });

function MiniStat({ label, value, tone = "text-text-primary", icon }: { label: string; value: string; tone?: string; icon: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Icon name={icon} size={15} className={tone} />
      <span className="text-[11px] font-medium text-text-tertiary">{label}</span>
      <span className={`text-[14px] font-bold ${tone}`}>{value}</span>
    </span>
  );
}

export default function TesoreriaPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [stats, setStats] = useState<TreasuryStats | null>(null);
  const [cats, setCats] = useState<{ name: string }[]>([]);
  const [data, setData] = useState<TxList | null>(null);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [egresoOpen, setEgresoOpen] = useState(false);
  const [cierreOpen, setCierreOpen] = useState(false);
  const [anularTx, setAnularTx] = useState<{ id: string; payer: string; amount: number } | null>(null);

  const loadStats = useCallback(() => {
    void authFetch("/treasury/stats").then((r) => r.json()).then(setStats).catch(() => {});
  }, [authFetch]);

  useEffect(() => {
    if (authLoading) return;
    loadStats();
    void authFetch("/treasury/categories").then((r) => r.json()).then(setCats).catch(() => {});
  }, [authLoading, authFetch, loadStats]);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search.trim()) qs.set("search", search.trim());
    if (type) qs.set("type", type);
    if (category) qs.set("category", category);
    if (status) qs.set("status", status);
    try { setData(await (await authFetch(`/treasury/transactions?${qs}`)).json()); }
    finally { setLoading(false); }
  }, [authFetch, page, pageSize, search, type, category, status]);

  useEffect(() => { if (!authLoading) { const t = setTimeout(load, search ? 350 : 0); return () => clearTimeout(t); } }, [authLoading, load]);
  useEffect(() => { setPage(1); }, [search, type, category, status, pageSize]);

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <PageHeading icon="banknote" title="Tesorería" subtitle="Movimientos, cajas y cierres" />
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/tesoreria/cierres" className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
            <Icon name="lock" size={14} /> Cierres de caja
          </Link>
          <Button variant="secondary" size="sm" onClick={() => setEgresoOpen(true)}><Icon name="trending-down" size={14} /> Egreso</Button>
          <Button size="sm" onClick={() => setCierreOpen(true)}><Icon name="lock" size={14} /> Cerrar caja</Button>
        </div>
      </div>

      {egresoOpen && <EgresoModal open={egresoOpen} onClose={() => setEgresoOpen(false)} onDone={() => { load(); loadStats(); }} />}
      {cierreOpen && <CierreCajaModal open={cierreOpen} onClose={() => setCierreOpen(false)} onDone={loadStats} />}
      {anularTx && <AnularModal tx={anularTx} onClose={() => setAnularTx(null)} onDone={() => { load(); loadStats(); }} />}

      {/* Resumen compacto en una sola fila (no las cajas grandes de antes). */}
      <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-border-subtle bg-surface px-4 py-2.5 shadow-sm">
        <MiniStat icon="trending-up" label="Ingresos" value={cop(stats?.ingresos ?? 0)} tone="text-success-text" />
        <MiniStat icon="trending-down" label="Egresos" value={cop(stats?.egresos ?? 0)} tone="text-error-text" />
        <span className="hidden h-6 w-px bg-border-subtle sm:block" />
        <MiniStat icon="scale" label="Balance" value={cop(stats?.balance ?? 0)} tone={(stats?.balance ?? 0) >= 0 ? "text-success-text" : "text-error-text"} />
        <MiniStat icon="x" label="Anuladas" value={(stats?.anuladas ?? 0).toLocaleString("es-CO")} tone="text-text-secondary" />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder="Buscar por pagador, nota o cuenta…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-auto">
          <option value="">Tipo</option>
          {Object.entries(TX_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-auto">
          <option value="">Categoría</option>
          <option value="Sales">Ventas (Sales)</option>
          {cats.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">Estado</option>
          <option value="VIGENTE">Vigente</option>
          <option value="ANULADA">Anulada</option>
        </Select>
      </div>

      {loading && !data ? <PageSkeleton /> : (
        <div className="flex flex-col gap-3">
          <DataTable
            autoHeight
            rows={data?.items ?? []}
            empty="No se encontraron movimientos."
            columns={[
              { key: "date", header: "Fecha", render: (r) => (r.date ? new Date(r.date).toLocaleDateString("es-CO") : "—") },
              { key: "type", header: "Tipo", render: (r) => <Badge label={TX_TYPE_LABEL[r.type] ?? r.type} tone={TX_TYPE_TONE[r.type] ?? "info"} /> },
              { key: "payer", header: "Pagador / Beneficiario", render: (r) => r.subscriberId
                ? <Link href={`/clientes/${r.subscriberId}`} className="font-medium text-brand hover:underline">{r.payer}</Link>
                : <span className="text-text-primary">{r.payer}</span> },
              { key: "cat", header: "Categoría", render: (r) => <span className="text-text-secondary">{r.category}</span> },
              { key: "fact", header: "Factura", render: (r) => r.invoiceTid ? <span className="font-mono text-text-tertiary">#{r.invoiceTid}</span> : "—" },
              { key: "method", header: "Método", render: (r) => r.method ?? "—" },
              { key: "amount", header: "Monto", align: "right", render: (r) => <span className={`font-semibold ${r.type === "EXPENSE" ? "text-error-text" : "text-success-text"}`}>{r.type === "EXPENSE" ? "-" : "+"}{cop(r.amount)}</span> },
              { key: "status", header: "Estado", render: (r) => <Badge label={r.status === "ANULADA" ? "Anulada" : "Vigente"} tone={r.status === "ANULADA" ? "error" : "default"} /> },
              { key: "acciones", header: "", align: "right", render: (r) => r.status === "ANULADA" ? null : (
                <button
                  type="button"
                  onClick={() => setAnularTx({ id: r.id, payer: r.payer, amount: r.amount })}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-error-text hover:bg-error-soft"
                >
                  <Icon name="x" size={12} /> Anular
                </button>
              ) },
            ]}
          />
          {data && data.pages > 1 && (
            <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} />
          )}
        </div>
      )}
    </>
  );
}
