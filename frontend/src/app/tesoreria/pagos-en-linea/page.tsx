"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/Modal";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { TabStrip } from "@/components/ui/TabStrip";
import { StatCard } from "@/components/ui/StatCard";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { RangoFechas, rangoDePreset, type RangoFechasValor } from "@/components/ui/RangoFechas";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { useRequest } from "@/lib/useRequest";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";
import { PERM } from "@/lib/auth";

/**
 * Pagos en línea del portal del abonado (`vestel.com.co/crm`).
 *
 * Lo que entra por Wompi (PSE, tarjeta, Nequi, Bancolombia) desde el portal, que es
 * una aplicación aparte con su propia base. Hasta ahora aquí solo se veía la plata,
 * como un ingreso «Bank/WOMPI» sin cara: ni quién intentó pagar y no terminó, ni —lo
 * importante— si al que pagó le devolvieron el servicio.
 *
 * Es una pantalla de CONSULTA: el pago lo procesa el portal contra el sistema
 * anterior y llega por la sincronización. Lo único que se puede hacer desde aquí es
 * forzar la pasada del puente (administración), que trae lo nuevo y reconecta.
 */

type Fila = {
  id: string;
  reference: string;
  amount: number;
  status: string;
  method: string | null;
  gatewayTxId: string | null;
  fecha: string;
  subscriberId: string;
  abonado: number | null;
  subscriberName: string | null;
  aplicado: boolean;
  reconectado: boolean;
};

type Resumen = {
  aprobados: { cantidad: number; monto: number };
  rechazados: { cantidad: number; monto: number };
  abandonados: { cantidad: number; monto: number };
  sinAplicar: { cantidad: number; monto: number };
};

type Detalle = Fila & {
  subscriberStatus: string | null;
  movimiento: { id: string; credit: number; date: string; note: string | null; method: string | null } | null;
  ordenes: { id: string; code: number; type: string; status: string }[];
};

const TABS = [
  { key: "TODOS", label: "Todos" },
  { key: "APPROVED", label: "Aprobados" },
  { key: "PENDING", label: "Sin terminar" },
  { key: "DECLINED", label: "Rechazados" },
  { key: "SIN_APLICAR", label: "Sin aplicar" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const ESTADO: Record<string, { label: string; tone: "success" | "error" | "warning" | "default" }> = {
  APPROVED: { label: "Aprobado", tone: "success" },
  DECLINED: { label: "Rechazado", tone: "error" },
  PENDING: { label: "Sin terminar", tone: "warning" },
  ERROR: { label: "Error", tone: "error" },
  VOIDED: { label: "Anulado", tone: "default" },
};

/** Nombres de Wompi tal como llegan, en cristiano. */
const METODO: Record<string, string> = {
  PSE: "PSE",
  CARD: "Tarjeta",
  NEQUI: "Nequi",
  BANCOLOMBIA_TRANSFER: "Bancolombia",
  BANCOLOMBIA_COLLECT: "Bancolombia (corresponsal)",
};

function fecha(d: string) {
  return new Date(d).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });
}

export default function PagosEnLineaPage() {
  const { loading: authLoading, authFetch, user } = useAuth();
  const puedeForzar =
    !!user?.permissions?.includes(PERM.SYSTEM_ADMIN) || !!user?.permissions?.includes(PERM.AREA_ADMINISTRACION);

  const [tab, setTab] = useState<Tab>("TODOS");
  const [search, setSearch] = useState("");
  const [rangoValor, setRangoValor] = useState<RangoFechasValor>(() => rangoDePreset("mes"));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [detalle, setDetalle] = useState<Detalle | null>(null);
  const [corriendo, setCorriendo] = useState(false);

  const { desde: from, hasta: to } = rangoValor;
  const rango = () => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    return qs;
  };

  const lista = useRequest<{ items: Fila[]; total: number; page: number; pageSize: number; pages: number }>(
    () => {
      const qs = rango();
      qs.set("page", String(page));
      qs.set("pageSize", String(pageSize));
      if (tab !== "TODOS") qs.set("estado", tab);
      if (search.trim()) qs.set("search", search.trim());
      return `/online-payments?${qs.toString()}`;
    },
    [tab, search, from, to, page, pageSize],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  const resumen = useRequest<Resumen>(
    () => `/online-payments/summary?${rango().toString()}`,
    [from, to],
    { saltar: authLoading },
  );

  useEffect(() => { setPage(1); }, [tab, search, from, to, pageSize]);

  async function abrirDetalle(id: string) {
    try {
      const res = await authFetch(`/online-payments/${id}`);
      if (!res.ok) throw new Error(await res.text());
      setDetalle(await res.json());
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    }
  }

  async function forzarPasada() {
    setCorriendo(true);
    try {
      const res = await authFetch("/online-payments/run", { method: "POST", body: JSON.stringify({}) });
      if (!res.ok) throw new Error(await res.text());
      const r = await res.json();
      const rec = r.reconexion;
      toast(
        `${r.ingesta.ingestadas} pago(s) nuevos · ${rec.candidatos} para reconectar` +
        (rec.candidatos ? ` (internet ${rec.internet}, TV ${rec.tv})` : ""),
      );
      lista.refrescar();
      resumen.refrescar();
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally {
      setCorriendo(false);
    }
  }

  if (authLoading) return <PageSkeleton />;

  const r = resumen.data;

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading
          icon="globe"
          title="Pagos en línea"
          subtitle="Lo que entra por el portal del abonado (Wompi: PSE, tarjeta, Nequi)"
        />
        {puedeForzar && (
          <Button variant="secondary" onClick={forzarPasada} disabled={corriendo}>
            <Icon name={corriendo ? "loader" : "refresh-cw"} size={15} />
            {corriendo ? "Trayendo…" : "Traer y reconectar ahora"}
          </Button>
        )}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon="check" label="Aprobados" value={r ? `${r.aprobados.cantidad} · ${cop(r.aprobados.monto)}` : "—"} tone="text-success-text" />
        <StatCard icon="clock" label="Empezados sin terminar" value={r ? `${r.abandonados.cantidad} · ${cop(r.abandonados.monto)}` : "—"} />
        <StatCard icon="ban" label="Rechazados" value={r ? `${r.rechazados.cantidad} · ${cop(r.rechazados.monto)}` : "—"} />
        {/* El número que justifica la pantalla: cobrado al cliente y sin bajarle la deuda. */}
        <StatCard
          icon="alert-triangle"
          label="Aprobados sin aplicar"
          value={r ? `${r.sinAplicar.cantidad} · ${cop(r.sinAplicar.monto)}` : "—"}
          tone={r && r.sinAplicar.cantidad > 0 ? "text-error-text" : "text-text-primary"}
        />
      </div>

      <TabStrip tabs={TABS.map((t) => ({ key: t.key, label: t.label }))} active={tab} onChange={setTab} />

      <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Cliente, abonado, referencia o ID de Wompi…">
        <RangoFechas value={rangoValor} onChange={setRangoValor} presets={["hoy", "semana", "mes", "mesPasado", "anio", "personalizado"]} />
      </ListToolbar>

      {lista.error ? (
        <LoadError message={lista.error} onRetry={lista.refrescar} />
      ) : lista.cargando && !lista.data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable
            rows={lista.data?.items ?? []}
            empty="No hay pagos en línea en este rango."
            onRowClick={(f: Fila) => abrirDetalle(f.id)}
            columns={[
              {
                key: "fecha", header: "Fecha",
                render: (f: Fila) => <span className="whitespace-nowrap text-text-secondary">{fecha(f.fecha)}</span>,
              },
              {
                key: "subscriberName", header: "Cliente",
                render: (f: Fila) => (
                  <div className="flex flex-col leading-tight">
                    <span className="font-medium text-text-primary">{f.subscriberName ?? "Sin nombre"}</span>
                    {f.abonado != null && <span className="text-[11px] text-text-tertiary">Abonado {f.abonado}</span>}
                  </div>
                ),
              },
              {
                key: "method", header: "Medio",
                render: (f: Fila) => <span className="text-text-secondary">{METODO[f.method ?? ""] ?? f.method ?? "—"}</span>,
              },
              { key: "amount", header: "Valor", align: "right", render: (f: Fila) => cop(f.amount) },
              {
                key: "status", header: "Pasarela",
                render: (f: Fila) => {
                  const e = ESTADO[f.status] ?? { label: f.status, tone: "default" as const };
                  return <Badge label={e.label} tone={e.tone} />;
                },
              },
              {
                key: "aplicado", header: "En cartera",
                render: (f: Fila) =>
                  f.status !== "APPROVED" ? <span className="text-text-tertiary">—</span>
                    : f.aplicado ? <Badge label="Aplicado" tone="success" />
                    : <Badge label="Sin aplicar" tone="error" />,
              },
              {
                key: "reconectado", header: "Servicio",
                render: (f: Fila) =>
                  f.status !== "APPROVED" ? <span className="text-text-tertiary">—</span>
                    : f.reconectado ? <Badge label="Reconectado" tone="success" />
                    : <span className="text-text-tertiary">—</span>,
              },
            ]}
          />
          {lista.data && (
            <div className="mt-3">
              <Pagination
                meta={{ page: lista.data.page, pageSize: lista.data.pageSize, total: lista.data.total, pageCount: lista.data.pages }}
                onPage={setPage}
                onPageSize={setPageSize}
              />
            </div>
          )}
        </>
      )}

      <Modal open={!!detalle} onClose={() => setDetalle(null)} title="Pago en línea" maxWidth="max-w-2xl">
        {detalle && (
          <div className="flex flex-col gap-4 text-[13px]">
            <div className="grid grid-cols-2 gap-3">
              <Dato label="Cliente" valor={
                <Link href={`/clientes/${detalle.subscriberId}`} className="font-medium text-brand hover:underline">
                  {detalle.subscriberName ?? "Sin nombre"}
                </Link>
              } />
              <Dato label="Abonado" valor={detalle.abonado ?? "—"} />
              <Dato label="Valor" valor={cop(detalle.amount)} />
              <Dato label="Medio" valor={METODO[detalle.method ?? ""] ?? detalle.method ?? "—"} />
              <Dato label="Fecha" valor={fecha(detalle.fecha)} />
              <Dato label="Estado del cliente" valor={detalle.subscriberStatus ?? "—"} />
              <Dato label="Referencia" valor={<code className="break-all text-[11px]">{detalle.reference}</code>} />
              <Dato label="ID de Wompi" valor={<code className="break-all text-[11px]">{detalle.gatewayTxId ?? "—"}</code>} />
            </div>

            <div className="rounded-lg border border-border-subtle p-3">
              <div className="mb-1 font-semibold text-text-primary">La plata</div>
              {detalle.movimiento ? (
                <p className="text-text-secondary">
                  {cop(detalle.movimiento.credit)} el {new Date(detalle.movimiento.date).toLocaleDateString("es-CO")}
                  {detalle.movimiento.note ? ` — ${detalle.movimiento.note}` : ""}
                </p>
              ) : (
                <p className="text-error-text">
                  Aprobado por la pasarela y sin movimiento en cartera: al cliente le cobraron y su deuda
                  no bajó. Hay que aplicarlo a mano.
                </p>
              )}
            </div>

            <div className="rounded-lg border border-border-subtle p-3">
              <div className="mb-1 font-semibold text-text-primary">El servicio</div>
              {!detalle.reconectado ? (
                <p className="text-text-secondary">
                  {detalle.status === "APPROVED"
                    ? "Todavía sin pasar por la reconexión (la pasada corre cada 5 minutos)."
                    : "No aplica: el pago no se aprobó."}
                </p>
              ) : detalle.ordenes.length ? (
                <ul className="flex flex-col gap-1">
                  {detalle.ordenes.map((o) => (
                    <li key={o.id}>
                      <Link href={`/soporte/${o.id}`} className="text-brand hover:underline">#{o.code}</Link>
                      <span className="text-text-secondary"> · {o.type} · {o.status}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-text-secondary">Se revisó y no había nada cortado que devolver.</p>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function Dato({ label, valor }: { label: string; valor: React.ReactNode }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[11px] font-medium text-text-tertiary">{label}</span>
      <span className="text-text-primary">{valor}</span>
    </div>
  );
}
