"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { BulkWhatsappModal } from "@/components/subscribers/BulkWhatsappModal";
import { SubscriberFilters } from "@/components/subscribers/SubscriberFilters";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import { type SubscriberList, SUB_STATUS_LABEL, SUB_STATUS_TONE, cop, cuentaParams } from "@/lib/subscribers";
import { useRequest } from "@/lib/useRequest";

export default function SedeClientesPage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch, can } = useAuth();
  const canWhatsapp = can(PERM.WHATSAPP_MANAGE);

  const [sedeName, setSedeName] = useState<string>("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [servicio, setServicio] = useState("");
  const [tecnologia, setTecnologia] = useState("");
  const [cuenta, setCuenta] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Selección de abonados para envío masivo (persiste entre páginas de la sede).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [waOpen, setWaOpen] = useState(false);
  const toggle = (sid: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(sid) ? next.delete(sid) : next.add(sid);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => {
      const items = data?.items ?? [];
      const allChecked = items.length > 0 && items.every((r) => prev.has(r.id));
      const next = new Set(prev);
      if (allChecked) items.forEach((r) => next.delete(r.id));
      else items.forEach((r) => next.add(r.id));
      return next;
    });

  // Nombre de la sede (desde branches-stats, que ya trae el total).
  useEffect(() => {
    if (authLoading) return;
    void authFetch("/subscribers/branches-stats")
      .then((r) => r.json())
      .then((rows: any[]) => setSedeName(rows.find((b) => b.id === id)?.name ?? ""))
      .catch(() => {});
  }, [authLoading, authFetch, id]);

  // Carga con cancelación: al teclear se aborta la petición en vuelo para que
  // una respuesta lenta no pise a otra más reciente. Ver lib/useRequest.
  const { data, cargando: loading, error, refrescar: load } = useRequest<SubscriberList>(
    () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), branchId: String(id) });
      if (search.trim()) qs.set("search", search.trim());
      if (status) qs.set("status", status);
      if (servicio) qs.set("servicio", servicio);
      if (tecnologia) qs.set("tecnologia", tecnologia);
      const cp = cuentaParams(cuenta);
      if (cp.cuenta) qs.set("cuenta", cp.cuenta);
      if (cp.deuda) qs.set("deuda", cp.deuda);
      return `/subscribers?${qs.toString()}`;
    },
    [id, page, pageSize, search, status, servicio, tecnologia, cuenta],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );
  useEffect(() => { setPage(1); }, [search, status, servicio, tecnologia, cuenta, pageSize]);

  if (authLoading) return <PageSkeleton />;

  return (
    <div className="space-y-4">
      <Link href="/clientes/grupos" className="inline-flex items-center gap-1.5 self-start text-[12px] font-semibold text-brand hover:underline">
        <Icon name="arrow-left" size={14} /> Volver a sedes
      </Link>
      <PageHeading
        icon="warehouse"
        title={sedeName || "Sede"}
        subtitle={data ? `${data.total.toLocaleString("es-CO")} clientes en esta sede` : "Clientes de la sede"}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder="Buscar por nombre, documento, celular o abonado…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">Todos los estados</option>
          {Object.entries(SUB_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <SubscriberFilters
          servicio={servicio} tecnologia={tecnologia} cuenta={cuenta}
          onServicio={setServicio} onTecnologia={setTecnologia} onCuenta={setCuenta}
        />
      </div>

      {canWhatsapp && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-brand/40 bg-brand-soft px-4 py-2.5">
          <span className="text-[13px] font-semibold text-text-primary">
            {selected.size.toLocaleString("es-CO")} abonado{selected.size === 1 ? "" : "s"} seleccionado{selected.size === 1 ? "" : "s"}
          </span>
          <button type="button" onClick={() => setSelected(new Set())} className="text-[12px] font-medium text-text-secondary hover:underline">
            Limpiar selección
          </button>
          <Button className="ml-auto" size="sm" onClick={() => setWaOpen(true)}>
            <Icon name="send" size={14} /> Enviar WhatsApp
          </Button>
        </div>
      )}

      <BulkWhatsappModal
        open={waOpen}
        onClose={() => setWaOpen(false)}
        subscriberIds={[...selected]}
        onSent={() => setSelected(new Set())}
      />

      {loading && !data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable
            rows={data?.items ?? []}
            empty="No se encontraron clientes en esta sede con esos criterios."
            columns={[
              ...(canWhatsapp ? [{
                key: "sel",
                header: (
                  <input
                    type="checkbox"
                    aria-label="Seleccionar toda la página"
                    checked={!!data?.items.length && (data?.items ?? []).every((r) => selected.has(r.id))}
                    onChange={toggleAll}
                  />
                ),
                render: (r: SubscriberList["items"][number]) => (
                  <input
                    type="checkbox"
                    aria-label={`Seleccionar ${r.name}`}
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                ),
              }] : []),
              { key: "abonado", header: "Abonado", render: (r) => <span className="font-mono text-text-secondary">{r.abonado}</span> },
              { key: "name", header: "Nombre", render: (r) => <span className="font-medium text-text-primary">{r.name}</span> },
              { key: "doc", header: "Documento", render: (r) => <span className="text-text-secondary">{r.docNumber ?? "—"}</span> },
              { key: "phone", header: "Celular", render: (r) => r.phone ?? "—" },
              { key: "status", header: "Estado", render: (r) => <Badge label={SUB_STATUS_LABEL[r.status ?? ""] ?? r.status ?? "—"} tone={SUB_STATUS_TONE[r.status ?? ""] ?? "default"} /> },
              { key: "balance", header: "Saldo", align: "right", render: (r) => <span className={r.balance > 0 ? "font-semibold text-success-text" : "text-text-tertiary"}>{cop(r.balance)}</span> },
              { key: "go", header: "", align: "right", render: (r) => <Link href={`/clientes/${r.id}`} className="inline-flex items-center gap-1 rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">Ver ficha →</Link> },
            ]}
          />
          {data && data.pages > 1 && (
            <div className="mt-3">
              <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
