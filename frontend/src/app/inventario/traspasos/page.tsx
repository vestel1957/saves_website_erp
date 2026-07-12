"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/inventory/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";

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
  const { loading: authLoading, authFetch } = useAuth();

  const [newOpen, setNewOpen] = useState(false);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [fromWarehouseId, setFromWarehouseId] = useState("");
  const [toWarehouseId, setToWarehouseId] = useState("");
  const [receiverId, setReceiverId] = useState("");
  const [observations, setObservations] = useState("");

  const [materials, setMaterials] = useState<any[]>([]);
  const [loadingMaterials, setLoadingMaterials] = useState(false);
  const [matFilter, setMatFilter] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>({});

  const [actas, setActas] = useState<any>(null);
  const [actaPage, setActaPage] = useState(1);
  const [actaSearch, setActaSearch] = useState("");
  const [actaStatus, setActaStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Detalle de acta
  const [detail, setDetail] = useState<any>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [receivingItem, setReceivingItem] = useState<string | null>(null);

  const loadWarehouses = useCallback(async () => {
    const [whs, us] = await Promise.all([
      (await authFetch("/inventory/warehouses")).json(),
      (await authFetch("/auth/users/options")).json().catch(() => []),
    ]);
    setWarehouses(Array.isArray(whs) ? whs : []);
    setUsers(Array.isArray(us) ? us : []);
  }, [authFetch]);

  const resetForm = useCallback(() => {
    setFromWarehouseId("");
    setToWarehouseId("");
    setReceiverId("");
    setObservations("");
    setMaterials([]);
    setSelected({});
    setMatFilter("");
  }, []);

  const openNew = useCallback(() => {
    resetForm();
    setNewOpen(true);
  }, [resetForm]);

  const loadActas = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(actaPage), pageSize: "25" });
      if (actaSearch.trim()) qs.set("search", actaSearch.trim());
      if (actaStatus) qs.set("status", actaStatus);
      setActas(await (await authFetch(`/inventory/actas?${qs}`)).json());
    } finally {
      setLoading(false);
    }
  }, [authFetch, actaPage, actaSearch, actaStatus]);

  const loadMaterials = useCallback(async (whId: string) => {
    if (!whId) { setMaterials([]); setSelected({}); return; }
    setLoadingMaterials(true);
    try {
      const d = await (await authFetch(`/inventory/materials?warehouseId=${whId}&pageSize=100`)).json();
      setMaterials(d?.items ?? []);
      setSelected({});
    } finally {
      setLoadingMaterials(false);
    }
  }, [authFetch]);

  useEffect(() => { if (!authLoading) void loadWarehouses(); }, [authLoading, loadWarehouses]);
  useEffect(() => {
    if (authLoading) return;
    const t = setTimeout(loadActas, actaSearch ? 300 : 0);
    return () => clearTimeout(t);
  }, [authLoading, loadActas, actaSearch]);
  useEffect(() => { setActaPage(1); }, [actaSearch, actaStatus]);

  const onFromChange = (v: string) => {
    setFromWarehouseId(v);
    setMatFilter("");
    void loadMaterials(v);
  };

  const toggle = (m: any, checked: boolean) => {
    setSelected((s) => {
      const next = { ...s };
      if (checked) next[m.id] = String(m.qty ?? 0); // por defecto, mueve todo lo disponible
      else delete next[m.id];
      return next;
    });
  };

  const setQty = (m: any, val: string) => {
    const max = Number(m.qty ?? 0);
    let n = Number(val);
    if (Number.isNaN(n) || n < 0) n = 0;
    if (n > max) n = max;
    setSelected((s) => ({ ...s, [m.id]: val === "" ? "" : String(n) }));
  };

  // Materiales filtrados por el buscador del picker.
  const shownMaterials = useMemo(() => {
    const q = matFilter.trim().toLowerCase();
    if (!q) return materials;
    return materials.filter((m: any) => `${m.name} ${m.code ?? ""}`.toLowerCase().includes(q));
  }, [materials, matFilter]);

  // Resumen del traspaso en curso (ítems, unidades, valor).
  const summary = useMemo(() => {
    let items = 0, units = 0, value = 0;
    for (const m of materials) {
      const q = Number(selected[m.id]);
      if (selected[m.id] !== undefined && q > 0) {
        items += 1;
        units += q;
        value += q * Number(m.price ?? 0);
      }
    }
    return { items, units, value };
  }, [materials, selected]);

  const submit = async () => {
    if (!fromWarehouseId || !toWarehouseId) { toast("Selecciona bodega origen y destino"); return; }
    if (fromWarehouseId === toWarehouseId) { toast("La bodega origen y destino deben ser diferentes"); return; }
    const items = Object.entries(selected)
      .filter(([, q]) => Number(q) > 0)
      .map(([materialId, q]) => ({ materialId, qty: Number(q) }));
    if (items.length === 0) { toast("Agrega al menos un ítem con cantidad"); return; }
    setSubmitting(true);
    try {
      const res = await authFetch("/inventory/transfer", {
        method: "POST",
        body: JSON.stringify({ fromWarehouseId, toWarehouseId, receiverId: receiverId || undefined, observations: observations || undefined, items }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(`Traspaso emitido · ${d?.items ?? items.length} ítem(s) en tránsito`);
      setNewOpen(false);
      resetForm();
      await loadActas();
    } catch (e: any) {
      toast(e?.message || "No se pudo realizar el traspaso");
    } finally {
      setSubmitting(false);
    }
  };

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
    } catch (e: any) {
      toast(e?.message || "No se pudo recibir el ítem");
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
    } catch (e: any) {
      toast(e?.message || "No se pudo recibir");
    } finally {
      setReceiving(false);
    }
  };

  const actaColumns = useMemo(() => [
    { key: "date", header: "Fecha", render: (r: any) => <span className="text-text-secondary">{fmtDate(r.date)}</span> },
    { key: "from", header: "Origen", render: (r: any) => <span>{r.from ?? "—"}</span> },
    {
      key: "to", header: "Destino", render: (r: any) => (
        <span className="inline-flex items-center gap-1"><Icon name="arrow-right" size={12} className="text-text-tertiary" /> {r.to ?? "—"}</span>
      ),
    },
    { key: "items", header: "Ítems", align: "right" as const, render: (r: any) => <span className="font-mono text-text-secondary">{r.items ?? 0}</span> },
    { key: "units", header: "Unidades", align: "right" as const, render: (r: any) => <span className="font-mono text-text-secondary">{r.units ?? 0}</span> },
    {
      key: "recibe", header: "Recibe", render: (r: any) =>
        r.receivedBy ? <span className="text-text-secondary">{r.receivedBy}</span>
          : r.assignedTo ? <span className="inline-flex items-center gap-1 text-text-secondary"><Icon name="user" size={12} className="text-text-tertiary" />{r.assignedTo}</span>
          : <span className="text-text-tertiary">Sin asignar</span>,
    },
    { key: "status", header: "Estado", render: (r: any) => <Badge label={r.status} tone={statusTone(r.status)} /> },
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeading icon="receipt" title="Traspasos" subtitle="Movimiento de materiales entre bodegas" />
        <Button variant="primary" size="sm" onClick={openNew}><Icon name="plus" size={14} />Nuevo traspaso</Button>
      </div>

      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="Nuevo traspaso" maxWidth="max-w-2xl">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Bodega origen" required>
            <Select value={fromWarehouseId} onChange={(e) => onFromChange(e.target.value)}>
              <option value="">Seleccionar…</option>
              {warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.title}</option>)}
            </Select>
          </Field>
          <Field label="Bodega / sede destino" required>
            <Select value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)}>
              <option value="">Seleccionar…</option>
              {warehouses.map((w: any) => <option key={w.id} value={w.id} disabled={w.id === fromWarehouseId}>{w.title}</option>)}
            </Select>
          </Field>
          <Field label="¿Quién recibe?" hint="Persona designada para confirmar la recepción en el destino">
            <Select value={receiverId} onChange={(e) => setReceiverId(e.target.value)}>
              <option value="">Sin asignar…</option>
              {users.map((u: any) => <option key={u.id} value={u.id}>{u.name}{u.email ? ` · ${u.email}` : ""}</option>)}
            </Select>
          </Field>
        </div>

        <div className="mt-3">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-text-tertiary">Materiales</span>
            {fromWarehouseId && materials.length > 0 && (
              <div className="relative w-full max-w-[240px] sm:w-56">
                <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
                <Input className="h-8 pl-8 text-[12px]" placeholder="Filtrar material…" value={matFilter} onChange={(e) => setMatFilter(e.target.value)} />
              </div>
            )}
          </div>
          {!fromWarehouseId ? (
            <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-6 text-center text-[13px] text-text-tertiary">
              Selecciona una bodega origen para ver sus materiales.
            </div>
          ) : loadingMaterials ? (
            <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-6 text-center text-[13px] text-text-tertiary">
              Cargando materiales…
            </div>
          ) : materials.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-6 text-center text-[13px] text-text-tertiary">
              La bodega no tiene materiales disponibles.
            </div>
          ) : (
            <div className="max-h-72 overflow-auto rounded-xl border border-border-subtle">
              {shownMaterials.length === 0 ? (
                <div className="p-6 text-center text-[13px] text-text-tertiary">Ningún material coincide con “{matFilter}”.</div>
              ) : shownMaterials.map((m: any) => {
                const checked = selected[m.id] !== undefined;
                return (
                  <div key={m.id} className={`flex items-center gap-3 border-b border-border-subtle px-3 py-2 last:border-0 ${checked ? "bg-brand-soft/40" : ""}`}>
                    <input type="checkbox" checked={checked} onChange={(e) => toggle(m, e.target.checked)} className="h-4 w-4 shrink-0 accent-brand" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-text-primary">{m.name}</div>
                      <div className="text-[11px] text-text-tertiary">{m.code || "—"} · Disp: {m.qty ?? 0} · {cop(m.price ?? 0)}</div>
                    </div>
                    <div className="w-24 shrink-0">
                      <Input
                        type="number"
                        min={0}
                        max={Number(m.qty ?? 0)}
                        disabled={!checked}
                        value={checked ? (selected[m.id] ?? "") : ""}
                        onChange={(e) => setQty(m, e.target.value)}
                        placeholder="Cant."
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Resumen del traspaso */}
        {summary.items > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg bg-surface-2 px-3 py-2 text-[12px]">
            <span className="text-text-tertiary">A transferir:</span>
            <span className="font-semibold text-text-primary">{summary.items} ítem(s)</span>
            <span className="font-semibold text-text-primary">{summary.units} unidad(es)</span>
            <span className="ml-auto font-bold text-text-primary">{cop(summary.value)}</span>
          </div>
        )}

        <div className="mt-3">
          <Field label="Observaciones">
            <Textarea rows={2} value={observations} onChange={(e) => setObservations(e.target.value)} placeholder="Notas del traspaso…" />
          </Field>
        </div>

        <p className="mt-3 text-[11px] text-text-tertiary">El material sale del origen y queda <strong>en tránsito</strong> hasta que el destino confirme la recepción.</p>

        <div className="mt-2 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setNewOpen(false)}>Cancelar</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={submitting || summary.items === 0}>
            <Icon name="check" size={14} />{submitting ? "Procesando…" : "Emitir traspaso"}
          </Button>
        </div>
      </Modal>

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
            <DataTable rows={actaRows} empty={actaSearch || actaStatus ? "No hay actas que coincidan con los filtros." : "No hay actas de traspaso."} onRowClick={openDetail} columns={actaColumns} />
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
