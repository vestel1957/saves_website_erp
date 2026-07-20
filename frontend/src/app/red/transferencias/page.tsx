"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { useRequest } from "@/lib/useRequest";

function statusTone(s: string): "default" | "success" | "warning" | "info" | "error" {
  if (s === "Recibida" || s === "Aprobada" || s === "Completada" || s === "Confirmada") return "success";
  if (s === "Rechazada") return "error";
  if (s === "Pendiente") return "warning";
  if (s === "En tránsito") return "info";
  return "info";
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });
}

export default function TransferenciasPage() {
  const { loading: authLoading, authFetch, can } = useAuth();
  const canApprove = can("inventory.admin"); // Jefe de bodega (inventario) aprueba/despacha
  const canReceive = can("area.caja"); // caja recibe en la sede destino
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Filtros de la lista
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [warehouseFilter, setWarehouseFilter] = useState("");

  // Nueva transferencia
  const [open, setOpen] = useState(false);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [observations, setObservations] = useState("");
  const [equipment, setEquipment] = useState<any[]>([]);
  const [loadingEquip, setLoadingEquip] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  // Detalle
  const [detail, setDetail] = useState<any>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [acting, setActing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  // Carga con cancelación: al teclear se aborta la petición en vuelo para que
  // una respuesta lenta no pise a otra más reciente. Ver lib/useRequest.
  const { data, cargando: loading, error, refrescar: load } = useRequest<any>(
    () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search.trim()) qs.set("search", search.trim());
      if (status) qs.set("status", status);
      if (warehouseFilter) qs.set("warehouseId", warehouseFilter);
      return `/network/transfers?${qs}`;
    },
    [page, pageSize, search, status, warehouseFilter],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  // Al cambiar cualquier filtro volvemos a la primera página
  useEffect(() => {
    setPage(1);
  }, [search, status, warehouseFilter, pageSize]);

  useEffect(() => {
    if (!authLoading)
      void authFetch("/network/warehouses")
        .then((r) => r.json())
        .then(setWarehouses)
        .catch(() => {});
  }, [authLoading, authFetch]);

  // Cargar equipos de la bodega origen
  useEffect(() => {
    if (!fromId) {
      setEquipment([]);
      setSelected({});
      return;
    }
    setLoadingEquip(true);
    setSelected({});
    const qs = new URLSearchParams({ warehouseId: fromId, pageSize: "100" });
    void authFetch(`/network/equipment?${qs}`)
      .then((r) => r.json())
      .then((d: any) => setEquipment(d?.items ?? []))
      .catch(() => setEquipment([]))
      .finally(() => setLoadingEquip(false));
  }, [fromId, authFetch]);

  const selectedIds = useMemo(
    () => Object.keys(selected).filter((k) => selected[k]),
    [selected],
  );

  const resetForm = useCallback(() => {
    setFromId("");
    setToId("");
    setObservations("");
    setEquipment([]);
    setSelected({});
  }, []);

  const submit = useCallback(async () => {
    if (!fromId || !toId) {
      toast("Selecciona bodega origen y destino", "alert-triangle");
      return;
    }
    if (fromId === toId) {
      toast("La bodega origen y destino deben ser distintas", "alert-triangle");
      return;
    }
    if (selectedIds.length === 0) {
      toast("Selecciona al menos un equipo", "alert-triangle");
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch("/network/transfers", {
        method: "POST",
        body: JSON.stringify({
          fromWarehouseId: fromId,
          toWarehouseId: toId,
          observations: observations.trim() || undefined,
          equipmentIds: selectedIds,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(`Solicitud enviada (${d?.count ?? selectedIds.length} equipos) · pendiente de aprobación`);
      setOpen(false);
      resetForm();
      void load();
    } catch (e: any) {
      toast(e?.message || "No se pudo crear la transferencia", "alert-triangle");
    } finally {
      setSaving(false);
    }
  }, [fromId, toId, observations, selectedIds, authFetch, load, resetForm]);

  const openDetail = useCallback(
    async (row: any) => {
      setLoadingDetail(true);
      setRejecting(false);
      setRejectReason("");
      setDetail({ id: row.id, ...row });
      try {
        setDetail(await (await authFetch(`/network/transfers/${row.id}`)).json());
      } catch {
        /* mantiene datos de la fila */
      } finally {
        setLoadingDetail(false);
      }
    },
    [authFetch],
  );

  const approve = useCallback(async () => {
    if (!detail) return;
    setActing(true);
    try {
      const res = await authFetch(`/network/transfers/${detail.id}/approve`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(`Despachada · ${d?.dispatched ?? 0} equipos en tránsito${d?.skipped ? ` (${d.skipped} omitidos)` : ""}`);
      setDetail(null);
      void load();
    } catch (e: any) {
      toast(e?.message || "No se pudo aprobar", "alert-triangle");
    } finally {
      setActing(false);
    }
  }, [detail, authFetch, load]);

  const receive = useCallback(async () => {
    if (!detail) return;
    setActing(true);
    try {
      const res = await authFetch(`/network/transfers/${detail.id}/receive`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(`Recepción confirmada · ${d?.received ?? 0} equipos en bodega destino`);
      setDetail(null);
      void load();
    } catch (e: any) {
      toast(e?.message || "No se pudo confirmar la recepción", "alert-triangle");
    } finally {
      setActing(false);
    }
  }, [detail, authFetch, load]);

  const reject = useCallback(async () => {
    if (!detail) return;
    setActing(true);
    try {
      const res = await authFetch(`/network/transfers/${detail.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: rejectReason.trim() || undefined }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast("Transferencia rechazada");
      setDetail(null);
      void load();
    } catch (e: any) {
      toast(e?.message || "No se pudo rechazar", "alert-triangle");
    } finally {
      setActing(false);
    }
  }, [detail, rejectReason, authFetch, load]);

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-3">
        <PageHeading
          icon="boxes"
          title="Transferencias de equipos"
          subtitle={data ? `${(data.total ?? 0).toLocaleString("es-CO")} transferencias` : "Movimientos entre bodegas"}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            resetForm();
            setOpen(true);
          }}
        >
          <Icon name="plus" size={14} /> Solicitar transferencia
        </Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input
            className="pl-9"
            placeholder="Buscar por bodega, solicitante u observación…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">Todos los estados</option>
          <option value="Pendiente">Pendiente</option>
          <option value="En tránsito">En tránsito</option>
          <option value="Recibida">Recibida</option>
          <option value="Rechazada">Rechazada</option>
        </Select>
        <Select value={warehouseFilter} onChange={(e) => setWarehouseFilter(e.target.value)} className="w-auto">
          <option value="">Todas las bodegas</option>
          {warehouses.map((w: any) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        {(search || status || warehouseFilter) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setStatus("");
              setWarehouseFilter("");
            }}
          >
            <Icon name="x" size={13} /> Limpiar
          </Button>
        )}
      </div>

      {loading && !data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable
            rows={data?.items ?? []}
            empty={search || status || warehouseFilter ? "No hay transferencias que coincidan con los filtros." : "No hay transferencias registradas."}
            columns={[
              {
                key: "date",
                header: "Fecha",
                render: (r: any) => <span className="text-text-secondary">{r.date ?? "—"}</span>,
              },
              { key: "from", header: "Origen", render: (r: any) => r.from ?? "—" },
              {
                key: "to",
                header: "Destino",
                render: (r: any) => (
                  <span className="inline-flex items-center gap-1">
                    <Icon name="arrow-left" size={12} className="rotate-180 text-text-tertiary" /> {r.to ?? "—"}
                  </span>
                ),
              },
              {
                key: "items",
                header: "# Equipos",
                align: "right",
                render: (r: any) => <span className="font-mono text-text-secondary">{r.items ?? 0}</span>,
              },
              {
                key: "requestedBy",
                header: "Solicita",
                render: (r: any) => r.requestedBy ? <span className="text-text-secondary">{r.requestedBy}</span> : <span className="text-text-tertiary">—</span>,
              },
              {
                key: "status",
                header: "Estado",
                render: (r: any) => <Badge label={r.status ?? "—"} tone={statusTone(r.status)} />,
              },
              {
                key: "acc",
                header: "Acción",
                align: "right",
                render: (r: any) => (
                  <Button variant="secondary" size="sm" onClick={() => openDetail(r)}>
                    <Icon name="list" size={13} /> Ver
                  </Button>
                ),
              },
            ]}
          />
          {data && data.pages > 1 && (
            <div className="mt-3">
              <Pagination
                meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }}
                onPage={setPage}
                onPageSize={setPageSize}
              />
            </div>
          )}
        </>
      )}

      {/* Nueva transferencia */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Nueva transferencia de equipos"
        maxWidth="max-w-2xl"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Bodega origen" required>
            <Select value={fromId} onChange={(e) => setFromId(e.target.value)}>
              <option value="">Selecciona…</option>
              {warehouses.map((w: any) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Bodega destino" required>
            <Select value={toId} onChange={(e) => setToId(e.target.value)}>
              <option value="">Selecciona…</option>
              {warehouses.map((w: any) => (
                <option key={w.id} value={w.id} disabled={w.id === fromId}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="Equipos a transferir"
          hint={fromId ? `${selectedIds.length} seleccionados de ${equipment.length}` : "Selecciona primero la bodega origen"}
          required
        >
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border-default bg-surface">
            {!fromId ? (
              <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">
                Elige una bodega origen para ver sus equipos.
              </div>
            ) : loadingEquip ? (
              <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">Cargando equipos…</div>
            ) : equipment.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">
                Esta bodega no tiene equipos disponibles.
              </div>
            ) : (
              equipment.map((eq: any) => (
                <label
                  key={eq.id}
                  className="flex cursor-pointer items-center gap-3 border-b border-border-subtle px-3 py-2 last:border-0 hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 accent-brand"
                    checked={!!selected[eq.id]}
                    onChange={(e) => setSelected((s) => ({ ...s, [eq.id]: e.target.checked }))}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-[13px]">
                      <span className="font-mono font-medium text-text-primary">{eq.code}</span>
                      {eq.brand && <span className="text-text-tertiary">{eq.brand}</span>}
                    </span>
                    <span className="flex flex-wrap gap-x-3 text-[11px] text-text-tertiary">
                      {eq.mac && <span className="font-mono">MAC {eq.mac}</span>}
                      {eq.serial && <span className="font-mono">S/N {eq.serial}</span>}
                    </span>
                  </span>
                </label>
              ))
            )}
          </div>
        </Field>

        <Field label="Observaciones">
          <Textarea
            rows={2}
            placeholder="Notas de la transferencia (opcional)…"
            value={observations}
            onChange={(e) => setObservations(e.target.value)}
          />
        </Field>

        <div className="mt-1 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={saving || !fromId || !toId || fromId === toId || selectedIds.length === 0}
            onClick={submit}
          >
            <Icon name="check" size={13} /> {saving ? "Creando…" : "Crear transferencia"}
          </Button>
        </div>
      </Modal>

      {/* Detalle */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? `Transferencia ${detail.date ?? ""}`.trim() : "Transferencia"}
        maxWidth="max-w-2xl"
      >
        {detail && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <Badge label={detail.from ?? "—"} tone="default" />
              <Icon name="arrow-left" size={13} className="rotate-180 text-text-tertiary" />
              <Badge label={detail.to ?? "—"} tone="default" />
              {detail.status && <Badge label={detail.status} tone={statusTone(detail.status)} />}
            </div>

            {/* Historial del flujo: solicita → inventario despacha → caja recibe */}
            <div className="grid grid-cols-1 gap-2 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2.5 text-[12px] sm:grid-cols-3">
              <div className="flex items-start gap-2">
                <Icon name="user" size={14} className="mt-0.5 text-text-tertiary" />
                <span className="min-w-0">
                  <span className="block text-[11px] text-text-tertiary">Solicitada por</span>
                  <span className="font-medium text-text-primary">{detail.requestedBy ?? "—"}</span>
                  <span className="block text-[11px] text-text-tertiary">{fmtDate(detail.requestedAt ?? detail.date)}</span>
                </span>
              </div>
              <div className="flex items-start gap-2">
                <Icon name={detail.status === "Rechazada" ? "x" : "package-check"} size={14} className="mt-0.5 text-text-tertiary" />
                <span className="min-w-0">
                  <span className="block text-[11px] text-text-tertiary">{detail.status === "Rechazada" ? "Rechazada por" : "Despachada por"} <span className="text-text-tertiary">(inventario)</span></span>
                  <span className="font-medium text-text-primary">{detail.approvedBy ?? (detail.status === "Pendiente" ? "Pendiente" : "—")}</span>
                  {detail.approvedAt && <span className="block text-[11px] text-text-tertiary">{fmtDate(detail.approvedAt)}</span>}
                </span>
              </div>
              <div className="flex items-start gap-2">
                <Icon name="check" size={14} className="mt-0.5 text-text-tertiary" />
                <span className="min-w-0">
                  <span className="block text-[11px] text-text-tertiary">Recibida por <span className="text-text-tertiary">(caja)</span></span>
                  <span className="font-medium text-text-primary">{detail.receivedBy ?? (detail.status === "En tránsito" ? "En tránsito" : "—")}</span>
                  {detail.receivedAt && <span className="block text-[11px] text-text-tertiary">{fmtDate(detail.receivedAt)}</span>}
                </span>
              </div>
            </div>

            {detail.rejectReason && (
              <p className="rounded-lg bg-error-soft px-3 py-2 text-[12px] text-error-text">
                <span className="font-semibold">Motivo del rechazo:</span> {detail.rejectReason}
              </p>
            )}
            {detail.observations && (
              <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-text-secondary">
                {detail.observations}
              </p>
            )}
            <div className="rounded-lg border border-border-default">
              {loadingDetail && !Array.isArray(detail.items) ? (
                <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">Cargando equipos…</div>
              ) : Array.isArray(detail.items) && detail.items.length > 0 ? (
                detail.items.map((eq: any) => (
                  <div
                    key={eq.id}
                    className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2 text-[13px] last:border-0"
                  >
                    <span className="flex items-center gap-2">
                      <Icon name="package" size={14} className="text-text-tertiary" />
                      <span className="font-mono font-medium text-text-primary">{eq.code}</span>
                      {eq.brand && <span className="text-text-tertiary">{eq.brand}</span>}
                    </span>
                    <span className="font-mono text-[11px] text-text-tertiary">{eq.mac ?? eq.serial ?? ""}</span>
                  </div>
                ))
              ) : (
                <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">
                  Sin equipos en esta transferencia.
                </div>
              )}
            </div>
            {/* Avisos contextuales por estado */}
            {detail.status === "Pendiente" && canApprove && !rejecting && (
              <div className="rounded-lg bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
                Al despachar, los equipos <strong>salen de la bodega origen</strong> y quedan en tránsito hasta que caja confirme la recepción.
              </div>
            )}
            {detail.status === "En tránsito" && canReceive && (
              <div className="rounded-lg bg-info-soft px-3 py-2 text-[12px] text-info-text">
                Al confirmar, los equipos <strong>entran a la bodega destino</strong> ({detail.to}).
              </div>
            )}
            {rejecting && (
              <Field label="Motivo del rechazo">
                <Textarea rows={2} placeholder="Explica por qué se rechaza (opcional)…" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
              </Field>
            )}

            <div className="mt-1 flex items-center justify-end gap-2">
              {detail.status === "Pendiente" && canApprove ? (
                rejecting ? (
                  <>
                    <Button variant="ghost" size="sm" disabled={acting} onClick={() => setRejecting(false)}>Cancelar</Button>
                    <Button variant="danger" size="sm" disabled={acting} onClick={reject}>
                      <Icon name="x" size={13} /> {acting ? "Rechazando…" : "Confirmar rechazo"}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>Cerrar</Button>
                    <Button variant="secondary" size="sm" disabled={acting} onClick={() => setRejecting(true)}>
                      <Icon name="x" size={13} /> Rechazar
                    </Button>
                    <Button variant="primary" size="sm" disabled={acting} onClick={approve}>
                      <Icon name="package-check" size={13} /> {acting ? "Despachando…" : "Aprobar y despachar"}
                    </Button>
                  </>
                )
              ) : detail.status === "En tránsito" && canReceive ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>Cerrar</Button>
                  <Button variant="primary" size="sm" disabled={acting} onClick={receive}>
                    <Icon name="check" size={13} /> {acting ? "Confirmando…" : "Confirmar recepción"}
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>Cerrar</Button>
              )}
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
