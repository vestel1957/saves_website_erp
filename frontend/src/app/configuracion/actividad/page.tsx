"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Modal } from "@/components/Modal";
import { PageHeading } from "@/components/ui/PageHeading";
import { Pagination } from "@/components/ui/Pagination";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Select } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";
import { useOrden } from "@/lib/useOrden";

type Campo = { etiqueta: string; valor: string };
type Row = {
  id: string; action: string; entity: string; entityId: string | null;
  /** La acción contada en castellano ("Recibió un pago de $73.150 en efectivo"). */
  descripcion: string;
  /** Registro afectado, ya con nombre y ruta para ir allí. */
  objeto: { etiqueta: string; ruta: string | null } | null;
  /** Cuerpo de la petición desglosado en campos legibles. */
  detalle: Campo[];
  userName: string | null; userEmail: string | null; ipAddress: string | null; createdAt: string;
};
type List = { items: Row[]; total: number; page: number; pageSize: number; pages: number };

/** Módulos por los que se puede filtrar (valor = prefijo de `entity`). */
const MODULOS: { value: string; label: string }[] = [
  { value: "", label: "Todos los módulos" },
  { value: "treasury", label: "Tesorería y caja" },
  { value: "billing", label: "Facturación" },
  { value: "subscribers", label: "Abonados" },
  { value: "support", label: "Soporte y órdenes" },
  { value: "inventory", label: "Inventario" },
  { value: "network", label: "Red (OLT, Mikrotik, equipos)" },
  { value: "orders", label: "Compras" },
  { value: "collections", label: "Cobranza" },
  { value: "staff", label: "Personal" },
  { value: "auth", label: "Usuarios y accesos" },
  { value: "plans", label: "Planes y combos" },
  { value: "promotions", label: "Promociones" },
  { value: "einvoice", label: "Facturación electrónica" },
  { value: "accounting", label: "Contabilidad" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "geo", label: "Mapa" },
  { value: "tasks", label: "Tareas" },
];

export default function BitacoraPage() {
  const { authFetch } = useAuth();
  const [data, setData] = useState<List | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [entity, setEntity] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [ruido, setRuido] = useState(false);
  const [abierta, setAbierta] = useState<Row | null>(null);

  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: String(page), pageSize: "30" , ...orden.params });
    if (search) qs.set("search", search);
    if (entity) qs.set("entity", entity);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    if (ruido) qs.set("ruido", "1");
    void authFetch(`/activity?${qs.toString()}`).then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {});
  }, [authFetch, page, search, entity, from, to, ruido, orden.clave]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [search, entity, from, to, ruido, orden.clave]);

  const fmt = (s: string) => new Date(s).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });
  const fmtLargo = (s: string) => new Date(s).toLocaleString("es-CO", { dateStyle: "long", timeStyle: "medium" });

  const columns: Column<Row>[] = [
    {
      key: "createdAt", header: "Fecha / hora", sortable: true, card: "row",
      render: (r) => <span className="whitespace-nowrap font-mono text-[12px] text-text-secondary">{fmt(r.createdAt)}</span>,
    },
    {
      key: "userName", header: "Funcionario", sortable: true,
      render: (r) => (r.userName ? <span className="font-medium">{r.userName}</span> : <span className="text-text-tertiary">Sistema</span>),
    },
    {
      key: "action", header: "Qué hizo", sortable: true, card: "title",
      render: (r) => (
        <div className="min-w-[240px]">
          <div className="text-text-primary">{r.descripcion}</div>
          {/* La ruta cruda sigue a la vista, pero en pequeño: sirve para auditar, no para leer. */}
          <div className="font-mono text-[11px] text-text-tertiary">{r.action}</div>
        </div>
      ),
    },
    {
      key: "objeto", header: "Sobre", sortable: false,
      render: (r) =>
        r.objeto ? (
          r.objeto.ruta ? (
            <Link href={r.objeto.ruta} className="text-brand hover:underline" onClick={(e) => e.stopPropagation()}>
              {r.objeto.etiqueta}
            </Link>
          ) : (
            <span>{r.objeto.etiqueta}</span>
          )
        ) : (
          <span className="text-text-tertiary">—</span>
        ),
    },
    { key: "ipAddress", header: "IP", sortable: true, card: "hidden", render: (r) => <span className="font-mono text-[11px] text-text-tertiary">{r.ipAddress ?? "—"}</span> },
  ];

  return (
    <div className="space-y-4">
      <PageHeading
        icon="history"
        title="Bitácora / Auditoría"
        subtitle="Qué hizo cada funcionario, contado en castellano. Toca una fila para ver el detalle de lo que se envió."
      />

      <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar por funcionario o ruta…">
        <Select value={entity} onChange={(e) => setEntity(e.target.value)} className="w-auto">
          {MODULOS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </Select>
        <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
          Desde
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-border-default bg-surface px-2 py-1.5 text-[13px]" />
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
          Hasta
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-border-default bg-surface px-2 py-1.5 text-[13px]" />
        </label>
        {/*
          El ping de GPS del técnico y los cron de alertas son el 60% de las filas:
          se guardan igual, pero por defecto no se listan para que se vea el trabajo
          de las personas.
        */}
        <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
          <input type="checkbox" checked={ruido} onChange={(e) => setRuido(e.target.checked)} />
          Incluir movimientos automáticos
        </label>
      </ListToolbar>

      <DataTable
        sort={orden.sort}
        onSort={orden.onSort}
        columns={columns}
        rows={data?.items ?? []}
        loading={!data}
        loadingText="Cargando…"
        empty="Sin registros para el filtro."
        onRowClick={setAbierta}
      />
      {data && data.pages > 1 && (
        <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} />
      )}

      <Modal open={!!abierta} onClose={() => setAbierta(null)} title="Detalle de la actividad" maxWidth="max-w-2xl">
        {abierta && (
          <div className="space-y-4 text-[13px]">
            <div>
              <p className="text-[15px] font-medium text-text-primary">{abierta.descripcion}</p>
              <p className="mt-0.5 text-text-secondary">
                {abierta.userName ?? "Sistema"}
                {abierta.userEmail ? ` · ${abierta.userEmail}` : ""} · {fmtLargo(abierta.createdAt)}
              </p>
            </div>

            {abierta.objeto && (
              <div>
                <span className="text-text-tertiary">Sobre: </span>
                {abierta.objeto.ruta ? (
                  <Link href={abierta.objeto.ruta} className="text-brand hover:underline">{abierta.objeto.etiqueta}</Link>
                ) : (
                  abierta.objeto.etiqueta
                )}
              </div>
            )}

            {abierta.detalle.length > 0 && (
              <div className="rounded-lg border border-border-default">
                <p className="border-b border-border-default px-3 py-2 text-[12px] font-medium text-text-secondary">Lo que se envió</p>
                <dl className="divide-y divide-border-default">
                  {abierta.detalle.map((c) => (
                    <div key={c.etiqueta} className="flex gap-3 px-3 py-1.5">
                      <dt className="w-40 shrink-0 text-text-tertiary">{c.etiqueta}</dt>
                      <dd className="min-w-0 break-words text-text-primary">{c.valor}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            <div className="grid gap-1 text-[12px] text-text-tertiary sm:grid-cols-2">
              <div><span className="font-mono">{abierta.action}</span></div>
              <div>Módulo: {abierta.entity}{abierta.ipAddress ? ` · IP ${abierta.ipAddress}` : ""}</div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
