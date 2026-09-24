"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";

/**
 * Los pagos por WOMPI de un día, uno a uno: quién pagó, con qué medio, qué facturas
 * saldó y con qué referencia.
 *
 * El informe del cierre sólo da la fila "WOMPI" con cantidad y monto. Esa fila cuenta
 * MOVIMIENTOS (un pago que salda dos facturas son dos) y los ubica por la sede de la
 * factura —o la del cliente si la factura no la trae, ver `sedeDelMovimiento` en el
 * backend—. Esta lista cuenta PAGOS y va siempre por la sede de la ficha del cliente,
 * así que puede diferir un poco. Es de la sede y no de la caja: esa plata no pasa por
 * ninguna ventanilla.
 */

type Pago = {
  referencia: string | null;
  paymentOrderId: string | null;
  medio: string | null;
  gatewayTxId: string | null;
  hora: string | null;
  aplico: "nexus" | "legacy" | null;
  subscriberId: string | null;
  cliente: string | null;
  abonado: number | null;
  facturas: { id: string; tid: number }[];
  monto: number;
  anulado: boolean;
};

type WompiDia = {
  sede: { id: number; nombre: string } | null;
  fecha: string;
  /** `cantidad` = pagos; `movimientos` = uno por factura saldada (lo que cuenta «Bancos»). */
  total: { cantidad: number; movimientos: number; monto: number };
  anulados: { cantidad: number; monto: number };
  porMedio: { medio: string | null; cantidad: number; monto: number }[];
  pagos: Pago[];
};

/** Nombres de Wompi tal como llegan, en cristiano (los mismos de /tesoreria/pagos-en-linea). */
const MEDIO: Record<string, string> = {
  PSE: "PSE",
  CARD: "Tarjeta",
  NEQUI: "Nequi",
  BANCOLOMBIA_TRANSFER: "Bancolombia",
  BANCOLOMBIA_COLLECT: "Bancolombia (corresponsal)",
};
const medio = (m: string | null) => (m ? MEDIO[m] ?? m : "Sin dato");

const hora = (h: string | null) =>
  h ? new Date(h).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" }) : "—";

/** CSV con `;` y BOM: es lo que Excel en español abre directo, con tildes y columnas. */
function descargarCsv(d: WompiDia, pagos: Pago[]) {
  const celda = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const filas = [
    ["Hora", "Cliente", "Abonado", "Medio", "Facturas", "Valor", "Estado", "Referencia", "ID Wompi"],
    ...pagos.map((p) => [
      hora(p.hora), p.cliente ?? "", p.abonado ?? "", medio(p.medio),
      p.facturas.map((f) => f.tid).join(" "), p.monto, p.anulado ? "Anulado" : "Vigente",
      p.referencia ?? "", p.gatewayTxId ?? "",
    ]),
  ];
  const csv = "﻿" + filas.map((f) => f.map(celda).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `wompi-${d.sede?.nombre ?? "sede"}-${String(d.fecha).slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function WompiDelDia({ cashAccountId, fecha, enInforme, incrustado = false }: {
  cashAccountId: string;
  fecha: string;
  /** La fila WOMPI del informe (por la sede de la factura), para explicar la diferencia. */
  enInforme?: { cantidad: number; monto: number };
  /** Va dentro de otra tarjeta (la pestaña «Bancos»): sin borde ni esquinas propias. */
  incrustado?: boolean;
}) {
  const { authFetch } = useAuth();
  const [d, setD] = useState<WompiDia | null>(null);
  const [cargando, setCargando] = useState(false);
  const [err, setErr] = useState("");
  const [abierto, setAbierto] = useState(true);
  const [q, setQ] = useState("");
  /** Medio elegido en las fichas de arriba; `undefined` = todos. */
  const [filtroMedio, setFiltroMedio] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setErr("");
    setFiltroMedio(undefined);
    void (async () => {
      try {
        const r = await authFetch(`/treasury/cash-close/wompi?cashAccountId=${cashAccountId}&date=${fecha}`);
        if (!vivo) return;
        if (!r.ok) { setD(null); setErr("No se pudieron cargar los pagos por Wompi."); return; }
        setD(await r.json());
      } catch {
        if (vivo) setErr("No se pudieron cargar los pagos por Wompi.");
      } finally {
        if (vivo) setCargando(false);
      }
    })();
    return () => { vivo = false; };
  }, [authFetch, cashAccountId, fecha]);

  const visibles = useMemo(() => {
    if (!d) return [];
    const t = q.trim().toLowerCase();
    return d.pagos.filter((p) => {
      if (filtroMedio !== undefined && p.medio !== filtroMedio) return false;
      if (!t) return true;
      return (
        (p.cliente ?? "").toLowerCase().includes(t)
        || String(p.abonado ?? "").includes(t)
        || (p.referencia ?? "").toLowerCase().includes(t)
        || (p.gatewayTxId ?? "").toLowerCase().includes(t)
        || p.facturas.some((f) => String(f.tid).includes(t))
      );
    });
  }, [d, q, filtroMedio]);

  if (err) return <div className="rounded-lg bg-error-soft px-3 py-2 text-sm text-error-text">{err}</div>;
  if (!d && cargando) {
    return <div className="rounded-xl border border-border-subtle bg-surface px-4 py-6 text-center text-[13px] text-text-tertiary">Cargando pagos por Wompi…</div>;
  }
  if (!d || !d.sede) return null;

  const sumaVisible = visibles.filter((p) => !p.anulado).reduce((s, p) => s + p.monto, 0);
  /** Pagos que saldaron más de una factura: la razón de que «Bancos» cuente más. */
  const multiFactura = d.total.movimientos - d.total.cantidad;
  const pagosVarias = d.pagos.filter((p) => !p.anulado && p.facturas.length > 1).length;
  /** Con la misma regla de sede, el monto cuadra al peso; si no, algo cambió entre llamadas. */
  const difiereMonto = enInforme && Math.round(enInforme.monto) !== Math.round(d.total.monto);

  return (
    <section className={incrustado ? "bg-surface" : "shrink-0 overflow-hidden rounded-xl border border-border-subtle bg-surface"}>
      {/* ── Cabecera: el total y el reparto por medio, que también filtra ── */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-3">
        <button
          onClick={() => setAbierto(!abierto)}
          className="flex items-center gap-2 text-left"
          aria-expanded={abierto}
        >
          <Icon name={abierto ? "chevron-down" : "chevron-right"} size={15} className="text-text-tertiary" />
          <Icon name="globe" size={15} className="text-brand" />
          <span className="text-[13px] font-semibold text-text-primary">
            Pagos por WOMPI, uno a uno · {d.sede.nombre}
          </span>
        </button>
        <span className="text-[13px] tabular-nums text-text-secondary">
          <strong className="text-text-primary">{d.total.cantidad}</strong> pago{d.total.cantidad === 1 ? "" : "s"}
          {multiFactura > 0 && <> ({d.total.movimientos} movimientos)</>} ·{" "}
          <strong className="text-text-primary">{cop(d.total.monto)}</strong>
        </span>
        {d.anulados.cantidad > 0 && (
          <Badge label={`${d.anulados.cantidad} anulado${d.anulados.cantidad === 1 ? "" : "s"} · ${cop(d.anulados.monto)}`} tone="error" />
        )}
        <div className="ml-auto flex items-center gap-2">
          {!!d.pagos.length && (
            <button
              onClick={() => descargarCsv(d, visibles)}
              className="inline-flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-[12px] text-text-secondary hover:bg-surface-2"
              title="Descarga lo que se ve en la tabla (con el filtro aplicado)"
            >
              <Icon name="download" size={13} /> Excel
            </button>
          )}
          <Link
            href="/tesoreria/pagos-en-linea"
            className="inline-flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-[12px] text-text-secondary hover:bg-surface-2"
          >
            <Icon name="external-link" size={13} /> Pagos en línea
          </Link>
        </div>
      </div>

      {abierto && (
        d.pagos.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-text-tertiary">
            Ningún cliente de {d.sede.nombre} pagó por Wompi este día.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 px-4 py-3">
              <button
                onClick={() => setFiltroMedio(undefined)}
                className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${
                  filtroMedio === undefined ? "bg-brand-soft text-brand" : "bg-surface-2 text-text-secondary hover:text-text-primary"
                }`}
              >
                Todos
              </button>
              {d.porMedio.map((m) => (
                <button
                  key={m.medio ?? "sin"}
                  onClick={() => setFiltroMedio(filtroMedio === m.medio ? undefined : m.medio)}
                  className={`rounded-full px-2.5 py-1 text-[12px] font-semibold tabular-nums ${
                    filtroMedio === m.medio ? "bg-brand-soft text-brand" : "bg-surface-2 text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {medio(m.medio)} · {m.cantidad} · {cop(m.monto)}
                </button>
              ))}
              <div className="relative ml-auto w-full sm:w-64">
                <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Cliente, abonado, factura o referencia…"
                  className="w-full rounded-lg border border-border-default bg-surface py-1.5 pl-8 pr-2 text-[12.5px] text-text-primary focus:border-brand focus:outline-none"
                />
              </div>
            </div>

            {/* Un día de Yopal pasa de 200 pagos: la tabla se desplaza sola y no se come la página. */}
            <div className="max-h-[34rem] overflow-y-auto">
            <DataTable
              rows={visibles}
              empty="Ningún pago coincide con el filtro."
              columns={[
                {
                  key: "hora", header: "Hora",
                  sortValue: (p: Pago) => p.hora ?? "",
                  render: (p: Pago) => (
                    <span
                      className="whitespace-nowrap tabular-nums text-text-secondary"
                      title={p.hora ? undefined : "Aplicado por el legacy: la hora exacta del pago no llegó"}
                    >
                      {hora(p.hora)}
                    </span>
                  ),
                },
                {
                  key: "cliente", header: "Cliente",
                  render: (p: Pago) => (
                    <div className="flex flex-col leading-tight">
                      {p.subscriberId ? (
                        <Link href={`/clientes/${p.subscriberId}`} className="font-medium text-text-primary hover:text-brand hover:underline">
                          {p.cliente ?? "Sin nombre"}
                        </Link>
                      ) : (
                        <span className="font-medium text-text-primary">{p.cliente ?? "Sin nombre"}</span>
                      )}
                      {p.abonado != null && <span className="text-[11px] text-text-tertiary">Abonado {p.abonado}</span>}
                    </div>
                  ),
                },
                {
                  key: "medio", header: "Medio",
                  sortValue: (p: Pago) => medio(p.medio),
                  render: (p: Pago) => <span className="text-text-secondary">{medio(p.medio)}</span>,
                },
                {
                  key: "facturas", header: "Facturas",
                  sortValue: (p: Pago) => p.facturas[0]?.tid ?? 0,
                  render: (p: Pago) =>
                    !p.facturas.length ? <span className="text-text-tertiary">—</span> : (
                      <span className="whitespace-nowrap">
                        {p.facturas.map((f, i) => (
                          <span key={f.id}>
                            {i > 0 && ", "}
                            <Link href={`/facturacion/${f.id}`} className="text-brand hover:underline">#{f.tid}</Link>
                          </span>
                        ))}
                      </span>
                    ),
                },
                {
                  key: "referencia", header: "Referencia / ID Wompi",
                  sortable: false,
                  render: (p: Pago) => (
                    <div className="flex flex-col leading-tight">
                      <code className="text-[11px] text-text-secondary">{p.referencia ?? "—"}</code>
                      {p.gatewayTxId && <code className="text-[11px] text-text-tertiary">{p.gatewayTxId}</code>}
                    </div>
                  ),
                },
                {
                  key: "monto", header: "Valor", align: "right",
                  render: (p: Pago) => (
                    <span className={`whitespace-nowrap tabular-nums font-semibold ${p.anulado ? "text-text-tertiary line-through" : "text-text-primary"}`}>
                      {cop(p.monto)}
                    </span>
                  ),
                },
                {
                  key: "estado", header: "",
                  sortable: false,
                  render: (p: Pago) => (p.anulado ? <Badge label="Anulado" tone="error" /> : null),
                },
              ]}
            />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle bg-surface-2 px-4 py-2 text-[11.5px] text-text-tertiary">
              <span>
                {visibles.length !== d.pagos.length
                  ? <>Mostrando {visibles.length} de {d.pagos.length} · {cop(sumaVisible)}</>
                  : multiFactura > 0
                    ? <>
                        La fila WOMPI de «Bancos» dice × {d.total.movimientos} porque cuenta un movimiento por factura:{" "}
                        {pagosVarias === 1 ? "1 pago saldó más de una factura" : `${pagosVarias} pagos saldaron más de una factura`}.
                        Aquí cada pago cuenta una vez. El monto es el mismo.
                      </>
                    : <>Es el desglose de la fila WOMPI de «Bancos»: mismos pagos, mismo monto.</>}
              </span>
              {difiereMonto && (
                <span>
                  Ojo: la fila WOMPI de «Bancos» dice {cop(enInforme!.monto)}. Recarga la página; si sigue distinto, avisa a sistemas.
                </span>
              )}
            </div>
          </>
        )
      )}
    </section>
  );
}
