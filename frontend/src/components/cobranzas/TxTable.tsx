"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { useOrden } from "@/lib/useOrden";
import { cop } from "@/lib/subscribers";
import { type TxRow, type TxList, TX_TYPE_LABEL, TX_TYPE_TONE, esCajera } from "@/lib/treasury";
import { FiltrosMovimientos, filtrosVacios, type FiltrosTx } from "@/components/cobranzas/FiltrosMovimientos";
import { fmtDate } from "@/lib/format";
import { mensajeDeError } from "@/lib/errores";
import { imprimirPdf } from "@/lib/imprimir";
import { columnasEditables, useEdicionEnLinea } from "@/components/cobranzas/EdicionEnLinea";
import { ComprobanteCell } from "@/components/treasury/ComprobanteCell";

/**
 * Celda de recibo: vuelve a sacar el voucher de 80 mm de un recaudo.
 *
 * Hasta ahora el recibo salía UNA vez, en el momento de cobrar, y si no salía —papel
 * atascado, ventana bloqueada por el navegador, el cliente que lo pide después— no
 * había ningún camino de vuelta al papel en toda la interfaz. Este botón es ese
 * camino: mismo PDF, mismo número de recibo.
 */
function ReciboCell({ tx }: { tx: TxRow }) {
  const { authFetch } = useAuth();
  const [busy, setBusy] = useState(false);

  if (!tx.receiptId) return <span className="text-text-tertiary">—</span>;

  async function imprimir() {
    setBusy(true);
    try {
      const res = await authFetch(`/treasury/receipts/${tx.receiptId}/pdf`);
      if (!res.ok) throw new Error("No se pudo generar el recibo");
      const r = await imprimirPdf(await res.blob());
      if (!r.ok) toast("El navegador bloqueó la ventana del recibo. Permite las ventanas emergentes de este sitio.", "alert-triangle");
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally { setBusy(false); }
  }

  return (
    <button type="button" onClick={imprimir} disabled={busy} title="Reimprimir el recibo de caja"
      className="inline-flex min-h-8 items-center gap-1 text-[12px] font-medium text-brand hover:underline disabled:opacity-50">
      <Icon name="printer" size={13} /> {busy ? "Generando…" : "Imprimir"}
    </button>
  );
}

/**
 * Lista de transacciones de tesorería con un filtro fijo (por tipo o estado).
 * La reusan las páginas de Ingresos, Egresos y Anulaciones; cada una aporta su
 * cabecera/acciones y refresca la tabla subiendo `refreshKey`.
 *
 * Con `editable`, las filas se corrigen ahí mismo: fecha, categoría, método, monto y
 * nota se vuelven inputs y la columna de acciones pasa a Guardar/Cancelar (ver
 * EdicionEnLinea). Solo lo enseña a quien puede — el permiso lo decide el hook.
 */
export function TxTable({
  params,
  refreshKey = 0,
  rowAction,
  extraColumns,
  editable = false,
  empty = "No se encontraron movimientos.",
}: {
  /** Lo que FIJA la pantalla (Ingresos = tipo, Anulaciones = estado). No es filtrable. */
  params: { type?: string; status?: string };
  refreshKey?: number;
  rowAction?: (r: TxRow) => ReactNode;
  extraColumns?: { key: string; header: string; align?: "right"; render: (r: TxRow) => ReactNode }[];
  /** Permite corregir la fila sin salir de la lista (solo contabilidad/superusuario). */
  editable?: boolean;
  empty?: string;
}) {
  const { loading: authLoading, authFetch, user } = useAuth();
  const [data, setData] = useState<TxList | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  // La cajera va acotada a su caja y al día de hoy —lo impone el servidor—, así que ni
  // se le enseña el periodo ni el selector de caja (ver FiltrosMovimientos).
  const cajera = esCajera(user);
  const [filtros, setFiltros] = useState<FiltrosTx>(() => filtrosVacios(cajera));
  // El alcance llega con la sesión: hasta que no se sabe si es cajera, el periodo por
  // defecto puede estar mal puesto.
  useEffect(() => { setFiltros(filtrosVacios(cajera)); }, [cajera]);
  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  /** La query de filtros, aparte para que el `useCallback` dependa de UN valor. */
  const claveFiltros = JSON.stringify(filtros);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...orden.params });
    if (search.trim()) qs.set("search", search.trim());
    // Lo que fija la pantalla manda sobre el filtro: en Ingresos no se puede pedir
    // egresos por mucho que el desplegable exista en otra pantalla.
    if (params.type) qs.set("type", params.type);
    else if (filtros.type) qs.set("type", filtros.type);
    if (params.status) qs.set("status", params.status);
    else if (filtros.status) qs.set("status", filtros.status);
    if (filtros.rango) { qs.set("from", filtros.rango.desde); qs.set("to", filtros.rango.hasta); }
    // `sede` puede ser "0" (los bancos): comparar contra cadena vacía, no por verdadero.
    if (filtros.sede !== "") qs.set("sede", filtros.sede);
    if (filtros.cashAccountId) qs.set("cashAccountId", filtros.cashAccountId);
    if (filtros.category) qs.set("category", filtros.category);
    if (filtros.method) qs.set("method", filtros.method);
    if (filtros.min) qs.set("min", filtros.min);
    if (filtros.max) qs.set("max", filtros.max);
    if (filtros.attach) qs.set("attach", filtros.attach);
    try { setData(await (await authFetch(`/treasury/transactions?${qs}`)).json()); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authFetch, page, pageSize, search, params.type, params.status, orden.clave, claveFiltros]);

  // Edición en la propia fila; al guardar, recarga desde el servidor.
  const edicion = useEdicionEnLinea({ onDone: load, habilitada: editable });

  useEffect(() => { if (!authLoading) { const t = setTimeout(load, search ? 350 : 0); return () => clearTimeout(t); } }, [authLoading, load, refreshKey]);
  useEffect(() => { setPage(1); }, [search, pageSize, orden.clave, claveFiltros]);

  if (authLoading || (loading && !data)) return <PageSkeleton />;

  return (
    <div className="flex flex-col gap-3">
      <FiltrosMovimientos
        value={filtros}
        onChange={setFiltros}
        search={search}
        onSearch={setSearch}
        cajera={cajera}
        fijos={params}
        totales={data?.totales}
        resultados={data?.total}
      />

      <DataTable
        sort={orden.sort}
        onSort={orden.onSort}
        rows={data?.items ?? []}
        empty={empty}
        columns={columnasEditables([
          // Código y Cuenta salen de la lista del legacy (`transactions/expense`), donde
          // son las dos columnas por las que contabilidad reconoce el movimiento: el
          // consecutivo para cuadrar contra el sistema viejo y la cuenta —sede o banco—
          // de la que salió la plata. El Código va PRIMERO, como allá: es por donde se
          // entra a comparar las dos listas. Vacío = movimiento nacido aquí que todavía
          // no ha viajado al legacy.
          { key: "codigo", header: "Código", sortable: true, render: (r: TxRow) => r.codigo != null
            ? <span className="font-mono text-[12px] text-text-secondary">{r.codigo}</span>
            : <span className="text-text-tertiary">—</span> },
          { key: "date", header: "Fecha", sortable: true, render: (r: TxRow) => fmtDate(r.date) },
          { key: "cuenta", header: "Cuenta", sortable: true, render: (r: TxRow) => <span className="text-text-secondary">{r.account ?? r.bank ?? "—"}</span> },
          // El Tipo solo dice algo donde la pantalla NO lo fija: en Egresos e Ingresos
          // sería una columna entera del mismo badge.
          ...(params.type ? [] : [{ key: "type", header: "Tipo", sortable: true, render: (r: TxRow) => <Badge label={TX_TYPE_LABEL[r.type] ?? r.type} tone={TX_TYPE_TONE[r.type] ?? "info"} /> }]),
          // En egresos ya no hay cliente: a quien se le paga es un proveedor o un
          // tercero del directorio (2026-08-25). Pero el histórico del legacy también
          // trae empleados y socios (viáticos, reembolsos), así que la columna se llama
          // por lo que de verdad es: quien recibe la plata.
          { key: "payer",
            header: params.type === "EXPENSE" ? "Beneficiario" : params.type === "INCOME" ? "Pagador" : "Pagador / Beneficiario",
            render: (r: TxRow) => r.subscriberId
            ? <Link href={`/clientes/${r.subscriberId}`} className="font-medium text-brand hover:underline">{r.payer}</Link>
            : <span className="text-text-primary">{r.payer}</span> },
          // La NOTA es el concepto del movimiento ("PAGO FACT FE-1198 JUNIO"): sin ella
          // un egreso es una fecha y una cifra. Está en el 100% de las filas migradas.
          { key: "note", header: "Nota", render: (r: TxRow) => r.note
            ? <span className="block max-w-[20rem] truncate text-text-secondary" title={r.note}>{r.note}</span>
            : <span className="text-text-tertiary">—</span> },
          // Quién lo EMITIÓ, que no es lo mismo que a quién se le pagó: sale del `eid`
          // del legacy y estaba en el dato desde siempre, sin llegar nunca a pantalla.
          { key: "emisor", header: "Emitido por", render: (r: TxRow) => r.emisor
            ? <span className="text-text-secondary">{r.emisor}</span>
            : <span className="text-text-tertiary">—</span> },
          { key: "cat", header: "Categoría", sortable: true, render: (r: TxRow) => <span className="text-text-secondary">{r.category}</span> },
          { key: "fact", header: "Factura", sortable: true, render: (r: TxRow) => r.invoiceTid ? <span className="font-mono text-text-tertiary">#{r.invoiceTid}</span> : "—" },
          { key: "method", header: "Método", sortable: true, render: (r: TxRow) => r.method ?? "—" },
          { key: "amount", header: "Monto", align: "right" as const, render: (r: TxRow) => <span className={`font-semibold ${r.type === "EXPENSE" ? "text-error-text" : "text-success-text"}`}>{r.type === "EXPENSE" ? "-" : "+"}{cop(r.amount)}</span> },
          { key: "comprobante", header: "Comprobante", render: (r: TxRow) => <ComprobanteCell id={r.id} attach={r.attach} attachName={r.attachName} onChange={load} /> },
          // La columna solo aparece donde hay recibos que reimprimir (recaudos); en
          // egresos y anulaciones sería una columna de guiones.
          ...(data?.items?.some((i) => i.receiptId)
            ? [{ key: "recibo", header: "Recibo", render: (r: TxRow) => <ReciboCell tx={r} /> }]
            : []),
          ...(extraColumns ?? []),
          { key: "status", header: "Estado", sortable: true, render: (r: TxRow) => <Badge label={r.status === "ANULADA" ? "Anulada" : "Vigente"} tone={r.status === "ANULADA" ? "error" : "default"} /> },
          ...(rowAction ? [{ key: "acciones", header: "", align: "right" as const, render: rowAction }] : []),
        ], edicion)}
      />
      {data && data.pages > 1 && (
        <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} />
      )}
    </div>
  );
}
