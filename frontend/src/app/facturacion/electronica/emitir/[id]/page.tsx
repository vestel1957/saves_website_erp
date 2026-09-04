"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/ui/PageHeading";
import { Input } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { DataTable, type SortState } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import { SUB_STATUS_LABEL, SUB_STATUS_TONE } from "@/lib/subscribers";
import { cop } from "@/lib/format";
import { mensajeDeError } from "@/lib/errores";

const n = (v: number) => (v ?? 0).toLocaleString("es-CO");

type Servicio = "tv" | "internet";
type Estado = "facturables" | "todos";
type FiltroMarcados = "" | "si" | "no";

const SERVICIOS: Record<Servicio, { label: string; icono: string; campo: "eInvoiceTv" | "eInvoiceInternet" }> = {
  tv: { label: "TV", icono: "tv", campo: "eInvoiceTv" },
  internet: { label: "Internet", icono: "wifi", campo: "eInvoiceInternet" },
};

type Client = {
  id: string; abonado: number; name: string; docType: string | null; docNumber: string | null;
  status: string | null; eInvoiceTv: boolean; eInvoiceInternet: boolean;
  tvPlan: string | null; tvPrice: number | null; tvTaxRate: number;
  internetPlan: string | null; internetPrice: number | null; internetTaxRate: number;
};
/** Lo que se va a facturar de un servicio en TODA la sede con los marcados de hoy. */
type TotalServicio = { marcados: number; sinPrecio: number; base: number; iva: number };
type Totals = { tv: TotalServicio; internet: TotalServicio };
type ClientList = { items: Client[]; total: number; page: number; pageSize: number; pages: number; totals: Totals };

/** Marcado en lote pendiente de confirmar. */
type Lote = { service: Servicio; value: boolean };

/**
 * Aplica marcas de e-factura a las filas y mueve el total de la SEDE con el mismo
 * delta. El total llega calculado del servidor sobre la sede entera (no cabe en la
 * página), así que al marcar se corrige por diferencia en vez de volver a pedirlo:
 * sumar/restar el precio de la fila da exactamente lo mismo y no parpadea.
 */
function aplicarMarcas(d: ClientList, service: Servicio, nuevos: Map<string, boolean>): ClientList {
  const campo = SERVICIOS[service].campo;
  const campoPrecio = service === "tv" ? "tvPrice" : "internetPrice";
  const campoIva = service === "tv" ? "tvTaxRate" : "internetTaxRate";
  let marcados = 0, sinPrecio = 0, base = 0, iva = 0;
  const items = d.items.map((c) => {
    const v = nuevos.get(c.id);
    if (v === undefined || v === c[campo]) return c;
    const signo = v ? 1 : -1;
    marcados += signo;
    const precio = c[campoPrecio];
    if (precio == null) sinPrecio += signo;
    else { base += signo * precio; iva += signo * Math.round((precio * (c[campoIva] ?? 0)) / 100); }
    return { ...c, [campo]: v };
  });
  const t = d.totals?.[service];
  if (!t) return { ...d, items };
  return {
    ...d, items,
    totals: { ...d.totals, [service]: { marcados: t.marcados + marcados, sinPrecio: t.sinPrecio + sinPrecio, base: t.base + base, iva: t.iva + iva } },
  };
}

/** Lo marcado de un servicio en la sede: la plata sin IVA arriba, el detalle en chico. */
function TotalServicioCard({ titulo, icono, t, universo }: { titulo: string; icono: string; t: TotalServicio; universo?: number }) {
  const pct = universo ? Math.min(100, Math.round((t.marcados / universo) * 100)) : null;
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-text-secondary">
          <Icon name={icono} size={14} className="text-text-tertiary" /> {titulo}
        </span>
        <span className="text-[11px] text-text-tertiary">
          {n(t.marcados)}{universo ? ` de ${n(universo)}` : ""} marcados
        </span>
      </div>
      <div className="mt-1 font-mono text-[19px] font-bold leading-tight text-text-primary">{cop(t.base)}</div>
      <div className="text-[11px] text-text-tertiary">antes de IVA{t.iva > 0 ? ` · IVA ${cop(t.iva)}` : ""}</div>
      {pct !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" title={`${pct}% de los clientes filtrados`}>
          <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {t.sinPrecio > 0 && (
        <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-warning-text" title="Marcados sin plan o sin precio: no suman al total y la corrida no los factura.">
          <Icon name="alert-triangle" size={12} /> {n(t.sinPrecio)} sin precio
        </div>
      )}
    </div>
  );
}

/**
 * Celda de servicio: el check y el plan van juntos en una pastilla que se enciende
 * al marcar. Con 2.000 filas, un check suelto no dice de un vistazo qué está dentro
 * de la facturación y qué no.
 */
function CeldaServicio({ row, service, plan, marcado, guardando, onToggle }: {
  row: Client; service: Servicio; plan: string | null; marcado: boolean; guardando: boolean; onToggle: (v: boolean) => void;
}) {
  const { label } = SERVICIOS[service];
  return (
    <label
      title={plan ?? `${row.name} no tiene ${label} contratado`}
      className={`flex w-full max-w-[190px] cursor-pointer items-center gap-2 rounded-lg border px-2 py-1 transition-colors ${
        marcado ? "border-brand/50 bg-brand-soft" : "border-transparent hover:border-border-subtle hover:bg-surface-2"
      } ${guardando ? "opacity-50" : ""}`}
    >
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0 cursor-pointer accent-brand"
        checked={marcado}
        disabled={guardando}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <span className={`truncate text-[11.5px] ${marcado ? "font-medium text-text-primary" : "text-text-tertiary"}`}>
        {plan ?? <span className="italic">sin {label.toLowerCase()}</span>}
      </span>
    </label>
  );
}

/** Mensualidad del servicio. Se atenúa si ese servicio no está marcado para e-factura. */
function Precio({ valor, activo }: { valor: number | null; activo: boolean }) {
  if (valor == null) return <span className="text-text-tertiary">—</span>;
  return <span className={`font-mono text-[12px] ${activo ? "font-semibold text-text-primary" : "text-text-tertiary"}`}>{cop(valor)}</span>;
}

/** Botón de marcado en lote sobre TODO lo filtrado (no solo la página). */
function BotonLote({ service, value, disabled, onClick }: { service: Servicio; value: boolean; disabled: boolean; onClick: () => void }) {
  const { label, icono } = SERVICIOS[service];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-40 ${
        value
          ? "border-brand/50 bg-brand-soft text-brand hover:bg-brand-soft/70"
          : "border-border-default text-text-secondary hover:bg-surface-2"
      }`}
    >
      <Icon name={icono} size={14} />
      {value ? "Marcar" : "Quitar"} {label}
    </button>
  );
}

export default function ClientesDeSedePage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch, can, isSuperadmin } = useAuth();
  const canEmit = isSuperadmin || can(PERM.AREA_CONTABILIDAD);

  const [branchName, setBranchName] = useState<string>("");
  const [data, setData] = useState<ClientList | null>(null);
  const [search, setSearch] = useState("");
  const [estado, setEstado] = useState<Estado>("facturables");
  const [marcados, setMarcados] = useState<FiltroMarcados>("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ by: "name", dir: "asc" });
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [lote, setLote] = useState<Lote | null>(null);
  const [aplicando, setAplicando] = useState(false);

  useEffect(() => {
    if (authLoading || !canEmit) return;
    void authFetch("/einvoice/branches").then((r) => (r.ok ? r.json() : []))
      .then((bs: { id: string; name: string }[]) => setBranchName(bs.find((b) => b.id === id)?.name ?? "Sede"))
      .catch(() => {});
  }, [authLoading, canEmit, authFetch, id]);

  const loadClients = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: "50", sort: sort.by, dir: sort.dir, estado });
    if (search.trim()) qs.set("search", search.trim());
    if (marcados) qs.set("marcados", marcados);
    try {
      setData(await (await authFetch(`/einvoice/branches/${id}/subscribers?${qs}`)).json());
    } finally {
      setLoading(false);
    }
  }, [id, page, search, sort, estado, marcados, authFetch]);

  useEffect(() => {
    if (authLoading || !canEmit) return;
    const t = setTimeout(loadClients, search ? 350 : 0);
    return () => clearTimeout(t);
  }, [authLoading, canEmit, loadClients, search]);

  useEffect(() => { setPage(1); }, [search, estado, marcados]);

  function handleSort(key: string) {
    setSort((s) => (s.by === key ? { by: key, dir: s.dir === "asc" ? "desc" : "asc" } : { by: key, dir: "asc" }));
    setPage(1);
  }

  /** Marca filas y mueve el total de la sede con el mismo cambio (sin recargar). */
  function marcar(service: Servicio, nuevos: Map<string, boolean>) {
    setData((d) => (d ? aplicarMarcas(d, service, nuevos) : d));
  }

  async function toggle(row: Client, service: Servicio, value: boolean) {
    marcar(service, new Map([[row.id, value]]));
    setSavingId(row.id);
    try {
      const res = await authFetch(`/einvoice/subscribers/${row.id}/eflags`, { method: "PATCH", body: JSON.stringify({ [service]: value }) });
      if (!res.ok) throw new Error();
    } catch {
      marcar(service, new Map([[row.id, !value]]));
      toast("No se pudo guardar la selección", "x");
    } finally {
      setSavingId(null);
    }
  }

  /**
   * Aplica el lote a TODOS los clientes que cumplen el filtro, no a la página: es
   * la diferencia entre un clic y recorrer 2.000 fichas de a una. El servidor
   * repite el mismo filtro que se está viendo.
   */
  async function aplicarLote(l: Lote) {
    setAplicando(true);
    try {
      const res = await authFetch(`/einvoice/branches/${id}/eflags-bulk`, {
        method: "POST",
        body: JSON.stringify({ service: l.service, value: l.value, estado, marcados, search: search.trim() }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "No se pudo aplicar la selección");
      toast(`${n(d.updated)} cliente(s) ${l.value ? "marcados" : "desmarcados"} en ${SERVICIOS[l.service].label}`, "check");
      setLote(null);
      await loadClients();
    } catch (e) {
      toast(mensajeDeError(e) ?? "No se pudo aplicar la selección en lote", "alert-circle");
    } finally {
      setAplicando(false);
    }
  }

  if (authLoading) return <PageSkeleton />;
  if (!canEmit) {
    return <div className="rounded-xl border border-border-subtle bg-surface p-6 text-[13px] text-text-secondary">Solo contabilidad puede gestionar la facturación electrónica.</div>;
  }

  const items = data?.items ?? [];
  const filtrados = data?.total ?? 0;
  // La barra de avance solo tiene sentido contra el total de la sede: con el
  // buscador o el filtro de marcados puesto, el universo ya no es comparable.
  const universo = !search.trim() && !marcados ? filtrados : undefined;
  // El subtítulo dice de cuánta gente estamos hablando y con qué recorte, que es
  // justo lo que hay que saber antes de pulsar un marcado en lote.
  const subtitulo = !data
    ? "Marca a quién y qué se le factura electrónicamente en esta sede."
    : `${n(filtrados)} ${estado === "facturables" ? "clientes facturables (activos y en compromiso)" : "clientes en la sede (todos los estados)"}`
      + " · marca qué se le factura a cada uno; se guarda al instante.";

  return (
    <>
      {/* Cabecera estándar del sistema. El "Volver" tiene destino fijo (la lista de
          sedes) porque a esta pantalla se llega siempre desde ahí. */}
      <PageHeading
        icon="file-signature"
        title={branchName ? `E-factura · ${branchName}` : "Facturación electrónica"}
        subtitle={subtitulo}
        backHref="/facturacion/electronica"
        backLabel="Sedes"
      />

      {/* Cuánto se va a facturar con lo marcado HOY, en toda la sede (no solo esta página). */}
      {data?.totals && (
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          <TotalServicioCard titulo="TV" icono="tv" t={data.totals.tv} universo={universo} />
          <TotalServicioCard titulo="Internet" icono="wifi" t={data.totals.internet} universo={universo} />
          <div className="rounded-xl border border-brand/40 bg-brand-soft p-3">
            <div className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-brand">
              <Icon name="file-signature" size={14} /> Total a facturar
            </div>
            <div className="mt-1 font-mono text-[19px] font-bold leading-tight text-text-primary">
              {cop(data.totals.tv.base + data.totals.internet.base)}
            </div>
            <div className="text-[11px] text-text-secondary">
              antes de IVA · con IVA {cop(data.totals.tv.base + data.totals.internet.base + data.totals.tv.iva + data.totals.internet.iva)}
            </div>
            <div className="mt-2 text-[11px] text-text-tertiary">
              {n(data.totals.tv.marcados + data.totals.internet.marcados)} servicios marcados en la sede
            </div>
          </div>
        </div>
      )}

      {/* Filtros: recortan la lista Y el alcance del marcado en lote de abajo. */}
      <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-border-subtle bg-surface p-2.5">
        <div className="relative min-w-[220px] flex-1">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder="Buscar por nombre, documento o abonado…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Segmented<Estado>
          ariaLabel="Estado del cliente"
          value={estado}
          onChange={setEstado}
          options={[{ value: "facturables", label: "Facturables" }, { value: "todos", label: "Todos" }]}
        />
        <Segmented<FiltroMarcados>
          ariaLabel="Selección de e-factura"
          value={marcados}
          onChange={setMarcados}
          options={[{ value: "", label: "Todos" }, { value: "si", label: "Marcados" }, { value: "no", label: "Sin marcar" }]}
        />
      </div>

      {/* Marcado en lote: una sola pulsación para todos los que cumplen el filtro. */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-border-default bg-surface-2 px-3 py-2">
        <span className="text-[12px] text-text-secondary">
          Aplicar a los <b className="font-mono text-text-primary">{n(filtrados)}</b> clientes filtrados:
        </span>
        <div className="flex flex-wrap gap-1.5">
          <BotonLote service="tv" value onClick={() => setLote({ service: "tv", value: true })} disabled={!filtrados || aplicando} />
          <BotonLote service="tv" value={false} onClick={() => setLote({ service: "tv", value: false })} disabled={!filtrados || aplicando} />
          <BotonLote service="internet" value onClick={() => setLote({ service: "internet", value: true })} disabled={!filtrados || aplicando} />
          <BotonLote service="internet" value={false} onClick={() => setLote({ service: "internet", value: false })} disabled={!filtrados || aplicando} />
        </div>
      </div>

      {loading && !data ? <PageSkeleton /> : (
        <>
          <DataTable
            rows={items}
            loading={loading}
            loadingText="Cargando clientes…"
            empty={search || marcados ? "Ningún cliente coincide con el filtro." : "No hay clientes facturables en esta sede."}
            sort={sort}
            onSort={handleSort}
            columns={[
              { key: "abonado", header: "Abonado", sortable: true, sortKey: "abonado", card: "hidden",
                render: (r: Client) => <span className="font-mono text-text-secondary">{r.abonado}</span> },
              { key: "name", header: "Cliente", sortable: true, sortKey: "name", render: (r: Client) => (
                <div className="leading-tight">
                  <div className="font-medium text-text-primary">{r.name}</div>
                  <div className="text-[11px] text-text-tertiary">
                    {[`#${r.abonado}`, [r.docType, r.docNumber].filter(Boolean).join(" ")].filter(Boolean).join(" · ")}
                  </div>
                </div>
              ) },
              { key: "status", header: "Estado", sortable: true, sortKey: "status", render: (r: Client) => r.status
                ? <Badge label={SUB_STATUS_LABEL[r.status] ?? r.status} tone={SUB_STATUS_TONE[r.status] ?? "default"} />
                : <span className="text-text-tertiary">—</span> },
              { key: "tv", align: "left", sortable: true, sortKey: "tv",
                header: <span className="inline-flex items-center gap-1"><Icon name="tv" size={13} /> TV</span>,
                render: (r: Client) => (
                  <CeldaServicio row={r} service="tv" plan={r.tvPlan} marcado={r.eInvoiceTv} guardando={savingId === r.id}
                    onToggle={(v) => toggle(r, "tv", v)} />
                ) },
              { key: "tvPrice", header: "Precio TV", align: "right",
                render: (r: Client) => <Precio valor={r.tvPrice} activo={r.eInvoiceTv} /> },
              { key: "internet", align: "left", sortable: true, sortKey: "internet",
                header: <span className="inline-flex items-center gap-1"><Icon name="wifi" size={13} /> Internet</span>,
                render: (r: Client) => (
                  <CeldaServicio row={r} service="internet" plan={r.internetPlan} marcado={r.eInvoiceInternet} guardando={savingId === r.id}
                    onToggle={(v) => toggle(r, "internet", v)} />
                ) },
              { key: "internetPrice", header: "Precio Internet", align: "right",
                render: (r: Client) => <Precio valor={r.internetPrice} activo={r.eInvoiceInternet} /> },
            ]}
          />
          {data && data.pages > 1 && (
            <div className="mt-3"><Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} /></div>
          )}
        </>
      )}

      {lote && (
        <ConfirmDialog
          open
          busy={aplicando}
          onClose={() => setLote(null)}
          onConfirm={() => void aplicarLote(lote)}
          tone={lote.value ? "primary" : "danger"}
          icon={SERVICIOS[lote.service].icono}
          title={`${lote.value ? "Marcar" : "Quitar"} ${SERVICIOS[lote.service].label} a ${n(filtrados)} clientes`}
          confirmLabel={`${lote.value ? "Marcar" : "Quitar"} los ${n(filtrados)}`}
          message={
            <>
              Se {lote.value ? "marcará" : "quitará"} <b>{SERVICIOS[lote.service].label}</b> a los{" "}
              <b>{n(filtrados)}</b> clientes que cumplen el filtro de ahora mismo
              {estado === "facturables" ? " (solo activos y en compromiso)" : " (todos los estados)"}
              {search.trim() ? <> y la búsqueda «{search.trim()}»</> : null}
              {marcados === "si" ? " que ya estaban marcados" : marcados === "no" ? " que aún no estaban marcados" : ""}.
              {" "}Es solo la selección: no se emite nada ante la DIAN todavía.
            </>
          }
        />
      )}
    </>
  );
}
