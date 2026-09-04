"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { esTecnico } from "@/lib/support";
import { useOrden } from "@/lib/useOrden";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

function statusTone(s: string): "default" | "success" | "warning" | "info" | "error" {
  if (s === "Recibida") return "success";
  if (s === "En tránsito") return "info";
  if (s === "Emitida") return "warning";
  return "default";
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });
}

export default function TraspasosPage() {
  const router = useRouter();
  const { loading: authLoading, authFetch, user } = useAuth();
  // Al técnico esta pantalla le sirve para UNA cosa: devolver a la bodega de su sede
  // lo que le sobró (el backend le sirve ese único modo), y sólo ve sus actas.
  const devuelve = esTecnico(user);

  const [actas, setActas] = useState<any>(null);
  const [actaPage, setActaPage] = useState(1);
  // Las actas paginan en el servidor: el orden viaja en la query.
  const orden = useOrden();
  const [actaSearch, setActaSearch] = useState("");
  const [actaStatus, setActaStatus] = useState("");
  const [loading, setLoading] = useState(true);

  // Detalle de acta
  const [detail, setDetail] = useState<any>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [receivingItem, setReceivingItem] = useState<string | null>(null);

  const loadActas = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(actaPage), pageSize: "25", ...orden.params });
      if (actaSearch.trim()) qs.set("search", actaSearch.trim());
      if (actaStatus) qs.set("status", actaStatus);
      setActas(await (await authFetch(`/inventory/actas?${qs}`)).json());
    } finally {
      setLoading(false);
    }
  }, [authFetch, actaPage, actaSearch, actaStatus, orden.clave]);

  useEffect(() => {
    if (authLoading) return;
    const t = setTimeout(loadActas, actaSearch ? 300 : 0);
    return () => clearTimeout(t);
  }, [authLoading, loadActas, actaSearch]);
  useEffect(() => { setActaPage(1); }, [actaSearch, actaStatus]);

  const openDetail = useCallback(async (row: any) => {
    setLoadingDetail(true);
    setDetail({ ...row });
    try {
      setDetail(await (await authFetch(`/inventory/actas/${row.id}`)).json());
    } catch {
      /* mantiene datos de la fila */
    } finally {
      setLoadingDetail(false);
    }
  }, [authFetch]);

  const refreshDetail = useCallback(async (id: string) => {
    try { setDetail(await (await authFetch(`/inventory/actas/${id}`)).json()); } catch { /* noop */ }
  }, [authFetch]);

  // Recibe UN ítem del checklist.
  const receiveItem = async (itemId: string) => {
    if (!detail) return;
    setReceivingItem(itemId);
    try {
      const res = await authFetch(`/inventory/actas/${detail.id}/items/${itemId}/receive`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      await refreshDetail(detail.id);
      if (d?.status === "Recibida") { toast("Acta recibida completa · material acreditado en destino"); await loadActas(); }
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo recibir el ítem"));
    } finally {
      setReceivingItem(null);
    }
  };

  // Recibe todos los ítems pendientes de una vez.
  const receive = async () => {
    if (!detail) return;
    setReceiving(true);
    try {
      const res = await authFetch(`/inventory/actas/${detail.id}/receive`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast("Acta recibida · material acreditado en destino");
      setDetail(null);
      await loadActas();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo recibir"));
    } finally {
      setReceiving(false);
    }
  };

  const actaColumns = useMemo(() => [
    { key: "date", header: "Fecha", sortable: true, render: (r: any) => <span className="text-text-secondary">{fmtDate(r.date)}</span> },
    { key: "from", header: "Origen", sortable: true, render: (r: any) => <span>{r.from ?? "—"}</span> },
    {
      key: "to", header: "Destino", sortable: true, render: (r: any) => (
        <span className="inline-flex items-center gap-1"><Icon name="arrow-right" size={12} className="text-text-tertiary" /> {r.to ?? "—"}</span>
      ),
    },
    { key: "items", header: "Ítems", sortable: true, align: "right" as const, render: (r: any) => <span className="font-mono text-text-secondary">{r.items ?? 0}</span> },
    { key: "units", header: "Unidades", align: "right" as const, render: (r: any) => <span className="font-mono text-text-secondary">{r.units ?? 0}</span> },
    {
      key: "recibe", header: "Recibe", render: (r: any) =>
        r.receivedBy ? <span className="text-text-secondary">{r.receivedBy}</span>
          : r.assignedTo ? <span className="inline-flex items-center gap-1 text-text-secondary"><Icon name="user" size={12} className="text-text-tertiary" />{r.assignedTo}</span>
          : <span className="text-text-tertiary">Sin asignar</span>,
    },
    { key: "status", header: "Estado", sortable: true, render: (r: any) => <Badge label={r.status} tone={statusTone(r.status)} /> },
    {
      key: "action", header: "", align: "right" as const, render: (r: any) => (
        <Button variant="secondary" size="sm" onClick={(e: any) => { e.stopPropagation(); void openDetail(r); }}>
          <Icon name="list" size={13} /> Ver
        </Button>
      ),
    },
  ], [openDetail]);

  if (authLoading) return <PageSkeleton />;

  const actaRows = actas?.items ?? [];

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading
          icon="receipt"
          title={devuelve ? "Devoluciones de material" : "Traspasos"}
          subtitle={devuelve ? "Lo que devuelves a la bodega de tu sede" : "Movimiento de materiales entre bodegas"}
        />
        {/* El formulario vive en su propia pantalla desde 2026-07-30: elegir modo
            (a técnico / entre bodegas) más el picker de material no cabía en un modal. */}
        <Button variant="primary" size="sm" onClick={() => router.push("/inventario/traspasos/nuevo")}>
          <Icon name="plus" size={14} />{devuelve ? "Devolver material" : "Nuevo traspaso"}
        </Button>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[13px] font-bold text-text-primary">
            <Icon name="list" size={15} />Actas de traspaso
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px]">
              <Icon name="search" size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
              <Input className="pl-9" placeholder="Buscar por bodega o responsable…" value={actaSearch} onChange={(e) => setActaSearch(e.target.value)} />
            </div>
            <Select value={actaStatus} onChange={(e) => setActaStatus(e.target.value)} className="w-auto">
              <option value="">Todos los estados</option>
              <option value="En tránsito">En tránsito</option>
              <option value="Recibida">Recibida</option>
              <option value="Emitida">Emitida</option>
            </Select>
          </div>
        </div>
        {loading && !actas ? (
          <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-6 text-center text-[13px] text-text-tertiary">Cargando…</div>
        ) : (
          <>
            <DataTable rows={actaRows} empty={actaSearch || actaStatus ? "No hay actas que coincidan con los filtros." : "No hay actas de traspaso."} onRowClick={openDetail} columns={actaColumns} sort={orden.sort} onSort={orden.onSort} />
            {actas && actas.pages > 1 && (
              <Pagination
                meta={{ page: actas.page, pageSize: actas.pageSize, total: actas.total, pageCount: actas.pages }}
                onPage={setActaPage}
              />
            )}
          </>
        )}
      </div>

      {/* Detalle del acta */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `Acta de traspaso · ${fmtDate(detail.date)}` : "Acta"} maxWidth="max-w-2xl">
        {detail && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <Badge label={detail.from ?? "—"} tone="default" />
              <Icon name="arrow-right" size={13} className="text-text-tertiary" />
              <Badge label={detail.to ?? "—"} tone="default" />
              <Badge label={detail.status} tone={statusTone(detail.status)} />
            </div>

            <div className="grid grid-cols-1 gap-2 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2.5 text-[12px] sm:grid-cols-2">
              <div className="flex items-start gap-2">
                <Icon name="user" size={14} className="mt-0.5 text-text-tertiary" />
                <span className="min-w-0">
                  <span className="block text-[11px] text-text-tertiary">Emitida por</span>
                  <span className="font-medium text-text-primary">{detail.createdBy ?? "—"}</span>
                  <span className="block text-[11px] text-text-tertiary">{fmtDate(detail.createdAt ?? detail.date)}</span>
                </span>
              </div>
              <div className="flex items-start gap-2">
                <Icon name={detail.status === "Recibida" ? "check" : "hourglass"} size={14} className="mt-0.5 text-text-tertiary" />
                <span className="min-w-0">
                  <span className="block text-[11px] text-text-tertiary">{detail.status === "Recibida" ? "Recibida por" : "Designada a"}</span>
                  <span className="font-medium text-text-primary">{detail.receivedBy ?? detail.assignedTo ?? (detail.status === "Recibida" ? "—" : "Sin asignar")}</span>
                  {detail.receivedAt
                    ? <span className="block text-[11px] text-text-tertiary">{fmtDate(detail.receivedAt)}</span>
                    : detail.assignedTo && <span className="block text-[11px] text-text-tertiary">Pendiente de recibir</span>}
                </span>
              </div>
            </div>

            {detail.observations && (
              <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-text-secondary">{detail.observations}</p>
            )}

            {/* Checklist de recepción */}
            <div className="overflow-hidden rounded-lg border border-border-subtle">
              <div className="flex items-center justify-between gap-2 border-b border-border-subtle bg-surface-2 px-3 py-1.5 text-[11px] font-semibold text-text-tertiary">
                <span>Materiales {detail.receivable && "· marca cada uno al recibirlo"}</span>
                {typeof detail.itemsTotal === "number" && (
                  <span className="text-text-secondary">{detail.receivedCount ?? 0}/{detail.itemsTotal} recibidos</span>
                )}
              </div>
              {loadingDetail && !Array.isArray(detail.items) ? (
                <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">Cargando ítems…</div>
              ) : Array.isArray(detail.items) && detail.items.length > 0 ? (
                <div>
                  {detail.items.map((it: any) => {
                    const busy = receivingItem === it.id;
                    return (
                      <div key={it.id} className={`flex items-center gap-3 border-t border-border-subtle px-3 py-2 text-[13px] first:border-t-0 ${it.received ? "bg-success-soft/40" : ""}`}>
                        {/* Casilla del checklist */}
                        {it.received ? (
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success text-on-brand" title={`Recibido ${fmtDate(it.receivedAt)}`}>
                            <Icon name="check" size={13} />
                          </span>
                        ) : detail.isReceiver ? (
                          <button
                            type="button"
                            onClick={() => receiveItem(it.id)}
                            disabled={busy}
                            title="Marcar como recibido"
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-border-default text-text-tertiary transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
                          >
                            {busy ? <Icon name="loader" size={12} className="animate-spin" /> : null}
                          </button>
                        ) : (
                          <span className="h-5 w-5 shrink-0 rounded-full border-2 border-border-subtle" />
                        )}
                        <div className="min-w-0 flex-1">
                          <span className="font-medium text-text-primary">{it.material}</span>
                          {it.code && <span className="ml-2 text-[11px] text-text-tertiary">{it.code}</span>}
                        </div>
                        <span className="shrink-0 font-mono text-text-secondary">{it.qty}</span>
                        <span className="w-20 shrink-0 text-right text-text-secondary">{cop(it.value ?? 0)}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">Sin ítems en esta acta.</div>
              )}
            </div>

            {detail.receivable && detail.isReceiver && (
              <div className="rounded-lg bg-info-soft px-3 py-2 text-[12px] text-info-text">
                Marca cada material a medida que lo recibes; al confirmar, el stock <strong>entra a la bodega destino</strong> ({detail.to}).
              </div>
            )}
            {detail.receivable && !detail.isReceiver && (
              <div className="rounded-lg bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
                Solo <strong>{detail.assignedTo}</strong> puede recibir este traspaso.
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>Cerrar</Button>
              {detail.isReceiver && (
                <Button variant="primary" size="sm" disabled={receiving || !!receivingItem} onClick={receive}>
                  <Icon name="check" size={13} /> {receiving ? "Recibiendo…" : "Recibir todo"}
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
