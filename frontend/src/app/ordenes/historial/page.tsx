"use client";

import { useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input, Select } from "@/components/ui/Field";
import { DataTable } from "@/components/ui/DataTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { mensajeDeError } from "@/lib/errores";

const ESTADOS = ["pendiente", "aprobado", "abonado", "recibido parcial", "recibido", "finalizado", "cancelado", "anulado"];

function statusTone(status: string): "default" | "success" | "error" | "warning" {
  if (status === "recibido" || status === "finalizado") return "success";
  if (status === "cancelado" || status === "anulado") return "error";
  if (status === "recibido parcial" || status === "pendiente") return "warning";
  return "default";
}

/** Historial de órdenes (paridad legacy `historial_ord`): todas las órdenes con saldos + export Excel. */
export default function HistorialOrdenesPage() {
  const { loading: authLoading, authFetch } = useAuth();

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [exporting, setExporting] = useState(false);

  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const buildQs = () => {
    const qs = new URLSearchParams(orden.params);
    if (search.trim()) qs.set("search", search.trim());
    if (status) qs.set("status", status);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    return qs;
  };

  const { data, cargando: loading } = useRequest<any>(
    () => {
      const qs = buildQs();
      qs.set("page", String(page));
      qs.set("pageSize", String(pageSize));
      return `/orders?${qs.toString()}`;
    },
    [page, pageSize, search, status, from, to, orden.clave],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  const exportar = async () => {
    setExporting(true);
    try {
      const res = await authFetch(`/orders/export.xlsx?${buildQs().toString()}`);
      if (!res.ok) throw new Error("No se pudo exportar");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ordenes-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setExporting(false); }
  };

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="clock" title="Historial de órdenes" subtitle="Todas las órdenes de compra y servicio, con pagos y saldos" />
        <div className="flex items-center gap-2">
          <Link href="/ordenes"><Button variant="secondary"><Icon name="arrow-left" size={15} /> Órdenes</Button></Link>
          <Button variant="primary" onClick={exportar} disabled={exporting}>
            <Icon name={exporting ? "loader" : "download"} size={15} className={exporting ? "animate-spin" : ""} /> {exporting ? "Exportando…" : "Exportar Excel"}
          </Button>
        </div>
      </div>

      <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar por N°, proveedor…">
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-44">
          <option value="">Todos los estados</option>
          {ESTADOS.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="w-36" title="Desde" />
        <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="w-36" title="Hasta" />
      </ListToolbar>

      {loading && !data ? <PageSkeleton /> : (
        <>
          <DataTable
            sort={orden.sort}
            onSort={orden.onSort}
            rows={data?.items ?? []}
            empty="No se encontraron órdenes."
            // La fila entera abre la orden, no sólo el N°.
            rowHref={(r: any) => `/ordenes/${r.id}`}
            columns={[
              { key: "tid", header: "N°", sortable: true, render: (r: any) => <Link href={`/ordenes/${r.id}`} className="font-mono font-medium text-brand hover:underline">{r.tid}</Link> },
              { key: "kind", header: "Tipo", sortable: true, render: (r: any) => <Badge label={r.kind} tone={r.kind === "compra" ? "brand" : "info"} /> },
              { key: "supplier", header: "Proveedor", sortable: true, render: (r: any) => <span className="font-medium text-text-primary">{r.supplier}</span> },
              { key: "date", header: "Fecha", sortable: true, render: (r: any) => (r.date ? new Date(r.date).toLocaleDateString("es-CO") : "—") },
              { key: "total", header: "Total", sortable: true, align: "right", render: (r: any) => cop(r.total) },
              { key: "paid", header: "Pagado", sortable: true, align: "right", render: (r: any) => <span className="text-success-text">{cop(r.paid ?? 0)}</span> },
              { key: "saldo", header: "Saldo", align: "right", render: (r: any) => { const s = (r.total ?? 0) - (r.paid ?? 0); return <span className={s > 0 ? "font-semibold text-error-text" : "text-text-tertiary"}>{cop(Math.max(0, s))}</span>; } },
              { key: "status", header: "Estado", sortable: true, render: (r: any) => <Badge label={r.status} tone={statusTone(r.status)} /> },
            ]}
          />
          {data && (
            <div className="mt-3">
              <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} />
            </div>
          )}
        </>
      )}
    </>
  );
}
