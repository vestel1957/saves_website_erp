"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/Modal";
import { Input, Field, Select } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { SUB_STATUS_LABEL } from "@/lib/subscribers";
import {
  type Promotion, type PromotionAssignee, type PromotionAssignmentLog, type DiscountFormat,
  DISCOUNT_FORMAT_OPTIONS, discountLabel, isFlatDiscount, isBeforeTaxDiscount,
} from "@/lib/promotions";

const STATUS_KEYS = Object.keys(SUB_STATUS_LABEL);
const statusText = (s: string | null) => (s ? SUB_STATUS_LABEL[s] ?? s : "");

type StaffOption = { id: string; name: string; username: string | null; area: string | null };

// Tipo de promoción (nombres fieles al legacy settings/promociones):
//  ingresar = campaña disponible para TODOS los funcionarios (legacy colaborador=null)
//  colaboradores = asignada a funcionarios específicos (legacy "Actualizar")
//  estado = ligada a un estado de cliente (legacy "Estados Promos Para Clientes")
type Tipo = "ingresar" | "colaboradores" | "estado";
const TIPO_OPTIONS: { value: Tipo; label: string }[] = [
  { value: "ingresar", label: "Ingresar (todos los funcionarios)" },
  { value: "colaboradores", label: "Asignar a colaboradores" },
  { value: "estado", label: "Estados Promos Para Clientes" },
];

type Draft = {
  name: string;
  description: string;
  discountFormat: DiscountFormat;
  percentage: string;
  flatAmount: string;
  startDate: string;
  endDate: string;
  active: boolean;
  tipo: Tipo;
  assigneeIds: string[];
  subscriberStatus: string;
};

const todayStr = () => new Date().toISOString().slice(0, 10);
const EMPTY: Draft = {
  name: "", description: "", discountFormat: "%", percentage: "", flatAmount: "",
  startDate: todayStr(), endDate: todayStr(),
  active: true, tipo: "colaboradores", assigneeIds: [], subscriberStatus: "",
};
const dstr = (iso: string) => iso.slice(0, 10);
const dtstr = (iso: string) =>
  new Date(iso).toLocaleString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** ¿Programada = activa, aún no vigente y con fecha de inicio futura? */
const isProgramada = (p: Promotion) => p.active && !p.vigente && new Date(p.startDate).getTime() > Date.now();

function HistoryTable({ rows, showPromo }: { rows: PromotionAssignmentLog[] | null; showPromo: boolean }) {
  if (!rows) return <p className="text-[13px] text-text-tertiary">Cargando…</p>;
  if (rows.length === 0) return <p className="text-[13px] text-text-tertiary">Sin movimientos de asignación todavía.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-border-subtle text-left text-text-tertiary">
            <th className="py-1.5 pr-3 font-medium">Fecha</th>
            {showPromo && <th className="py-1.5 pr-3 font-medium">Promoción</th>}
            <th className="py-1.5 pr-3 font-medium">Funcionario</th>
            <th className="py-1.5 pr-3 font-medium">Acción</th>
            <th className="py-1.5 pr-3 font-medium">Por</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((h) => (
            <tr key={h.id} className="border-b border-border-subtle/60">
              <td className="whitespace-nowrap py-1.5 pr-3 text-text-tertiary">{dtstr(h.createdAt)}</td>
              {showPromo && <td className="py-1.5 pr-3 font-medium text-text-primary">{h.promotionName}</td>}
              <td className="py-1.5 pr-3 text-text-primary">{h.staffName}</td>
              <td className="py-1.5 pr-3">
                <Badge tone={h.action === "ASSIGNED" ? "success" : "default"} label={h.action === "ASSIGNED" ? "Asignada" : "Retirada"} />
              </td>
              <td className="py-1.5 pr-3 text-text-tertiary">{h.assignedByName ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone: "success" | "warning" | "brand" }) {
  const color = tone === "success" ? "text-success-text" : tone === "warning" ? "text-warning-text" : "text-brand";
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
      <div className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">{label}</div>
      <div className={`mt-1 text-[24px] font-bold ${color}`}>{value.toLocaleString("es-CO")}</div>
    </div>
  );
}

export default function PromocionesPage() {
  const { authFetch, isSuperadmin } = useAuth();
  const [promos, setPromos] = useState<Promotion[] | null>(null);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [editing, setEditing] = useState<Promotion | null>(null);
  const [draft, setDraft] = useState<Draft>({ ...EMPTY });
  const [busy, setBusy] = useState(false);
  const [staffQuery, setStaffQuery] = useState("");
  const [history, setHistory] = useState<PromotionAssignmentLog[] | null>(null);
  const [historyFor, setHistoryFor] = useState<Promotion | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [tab, setTab] = useState<"promos" | "historial">("promos");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"todas" | "vigentes" | "programadas">("todas");

  const load = useCallback(() => {
    void authFetch(`/promotions`).then((r) => (r.ok ? r.json() : [])).then(setPromos).catch(() => setPromos([]));
  }, [authFetch]);

  const loadHistory = useCallback(() => {
    void authFetch(`/promotions/history`).then((r) => (r.ok ? r.json() : [])).then(setHistory).catch(() => setHistory([]));
  }, [authFetch]);

  useEffect(() => {
    if (!isSuperadmin) return;
    load();
    loadHistory();
    void authFetch(`/staff?pageSize=100`)
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setStaff((d.items ?? []).map((s: any) => ({ id: s.id, name: s.name, username: s.username, area: s.area }))))
      .catch(() => setStaff([]));
  }, [authFetch, isSuperadmin, load, loadHistory]);

  const filteredStaff = useMemo(() => {
    const q = staffQuery.trim().toLowerCase();
    if (!q) return staff;
    return staff.filter((s) => `${s.name} ${s.username ?? ""} ${s.area ?? ""}`.toLowerCase().includes(q));
  }, [staff, staffQuery]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (promos ?? []).filter((p) => {
      if (statusFilter === "vigentes" && !p.vigente) return false;
      if (statusFilter === "programadas" && !isProgramada(p)) return false;
      if (q && !`${p.name} ${p.description ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [promos, query, statusFilter]);

  if (!isSuperadmin) {
    return (
      <div className="rounded-xl border border-border-subtle bg-surface p-6 text-center text-[13px] text-text-tertiary">
        Solo el superusuario puede administrar las promociones.
      </div>
    );
  }

  const vigentesN = (promos ?? []).filter((p) => p.vigente).length;
  const programadasN = (promos ?? []).filter(isProgramada).length;
  const aplicN = (promos ?? []).reduce((s, p) => s + (p.timesApplied || 0), 0);

  function resetForm() { setEditing(null); setStaffQuery(""); setDraft({ ...EMPTY }); }
  function openNew() { resetForm(); setModalOpen(true); }
  function closeModal() { setModalOpen(false); resetForm(); }
  function openEdit(p: Promotion) {
    setEditing(p);
    setStaffQuery("");
    setDraft({
      name: p.name, description: p.description ?? "",
      discountFormat: p.discountFormat ?? "%",
      percentage: p.percentage ? String(p.percentage) : "",
      flatAmount: p.flatAmount != null ? String(p.flatAmount) : "",
      startDate: dstr(p.startDate), endDate: dstr(p.endDate),
      active: p.active,
      tipo: p.subscriberStatus ? "estado" : p.global ? "ingresar" : "colaboradores",
      assigneeIds: p.assignees.map((a) => a.id),
      subscriberStatus: p.subscriberStatus ?? "",
    });
    setModalOpen(true);
  }

  function toggleAssignee(id: string) {
    const has = draft.assigneeIds.includes(id);
    setDraft({ ...draft, assigneeIds: has ? draft.assigneeIds.filter((x) => x !== id) : [...draft.assigneeIds, id] });
  }

  async function save() {
    if (!draft.name.trim()) { toast("La promoción necesita un nombre", "alert-circle"); return; }
    const flat = isFlatDiscount(draft.discountFormat);
    let pct: number | undefined;
    let flatAmt: number | undefined;
    if (flat) {
      flatAmt = Number(draft.flatAmount);
      if (!(flatAmt > 0)) { toast("El monto fijo del descuento debe ser mayor a $0", "alert-circle"); return; }
    } else {
      pct = Number(draft.percentage);
      if (!Number.isInteger(pct) || pct < 1 || pct > 100) { toast("El porcentaje debe estar entre 1 y 100", "alert-circle"); return; }
    }
    if (draft.endDate < draft.startDate) { toast("La fecha final no puede ser anterior a la inicial", "alert-circle"); return; }
    if (draft.tipo === "estado") {
      if (!draft.subscriberStatus) { toast("Elige el estado de cliente al que aplica la promo", "alert-circle"); return; }
    } else if (draft.tipo === "colaboradores" && draft.assigneeIds.length === 0) {
      toast("Asigna al menos un colaborador (o usa 'Ingresar' para todos)", "alert-circle"); return;
    }
    setBusy(true);
    try {
      const body = JSON.stringify({
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        discountFormat: draft.discountFormat,
        percentage: pct,
        flatAmount: flatAmt,
        startDate: draft.startDate,
        endDate: draft.endDate,
        active: draft.active,
        subscriberStatus: draft.tipo === "estado" ? draft.subscriberStatus : null,
        global: draft.tipo === "ingresar",
        assigneeIds: draft.tipo === "colaboradores" ? draft.assigneeIds : [],
      });
      const res = editing
        ? await authFetch(`/promotions/${editing.id}`, { method: "PUT", body })
        : await authFetch(`/promotions`, { method: "POST", body });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar");
      toast(editing ? "Promoción actualizada" : "Promoción creada", "check");
      closeModal(); load(); loadHistory();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: Promotion) {
    if (!confirm(`¿Eliminar la promoción "${p.name}"?`)) return;
    try {
      const res = await authFetch(`/promotions/${p.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo eliminar");
      toast("Promoción eliminada", "check");
      load(); loadHistory();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    }
  }

  const targetText = (p: Promotion) =>
    p.subscriberStatus ? `Clientes en "${statusText(p.subscriberStatus)}"` : p.global ? "Todos los funcionarios" : `${p.assignees.length} funcionario(s)`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeading
          icon="gift"
          title="Promociones"
          subtitle="Campañas de descuento asignadas a funcionarios. El funcionario aplica el % a las facturas (como nota crédito) mientras la promo esté vigente."
        />
        <button onClick={openNew}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hover">
          <Icon name="plus" size={15} /> Nueva promoción
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {([["promos", "Promociones", "gift"], ["historial", "Historial", "history"]] as [typeof tab, string, string][]).map(([k, label, icon]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12px] font-semibold transition-colors ${tab === k ? "border-brand bg-brand-soft text-brand" : "border-border-default text-text-secondary hover:bg-surface-2"}`}>
            <Icon name={icon} size={14} /> {label}
          </button>
        ))}
      </div>

      {tab === "promos" ? (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-3 gap-3">
            <Kpi label="Vigentes" value={vigentesN} tone="success" />
            <Kpi label="Programadas" value={programadasN} tone="warning" />
            <Kpi label="Aplicaciones" value={aplicN} tone="brand" />
          </div>

          {/* Buscador + filtro por estado */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
              <Input className="pl-9" placeholder="Buscar promoción…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="flex gap-1.5">
              {([["todas", "Todas"], ["vigentes", "Vigentes"], ["programadas", "Programadas"]] as [typeof statusFilter, string][]).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setStatusFilter(k)}
                  className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${statusFilter === k ? "border-brand bg-brand-soft text-brand" : "border-border-default text-text-secondary hover:bg-surface-2"}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Grilla de tarjetas */}
          {!promos ? (
            <p className="text-[13px] text-text-tertiary">Cargando…</p>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-subtle bg-surface p-10 text-center">
              <Icon name="gift" size={26} className="text-text-tertiary" />
              <div className="text-[14px] font-semibold text-text-primary">{promos.length === 0 ? "Aún no hay promociones" : "Sin resultados"}</div>
              <div className="text-[12px] text-text-tertiary">{promos.length === 0 ? "Crea la primera con “Nueva promoción”." : "Ajusta el buscador o el filtro."}</div>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map((p) => (
                <div key={p.id} className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm transition-colors hover:border-brand/40">
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate text-[14px] font-semibold text-text-primary">{p.name}</span>
                    <Badge tone="brand" label={discountLabel(p)} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {p.vigente ? <Badge tone="success" label="Vigente" /> : <Badge tone="default" label={p.active ? "Fuera de fecha" : "Inactiva"} />}
                    {isBeforeTaxDiscount(p.discountFormat) && <Badge tone="default" label="Antes de imp." />}
                    {p.subscriberStatus ? <Badge tone="warning" label={`Estado: ${statusText(p.subscriberStatus)}`} /> : p.global ? <Badge tone="info" label="Todos los funcionarios" /> : <Badge tone="default" label={`${p.assignees.length} colaborador(es)`} />}
                  </div>
                  {p.description && <p className="truncate text-[12px] text-text-tertiary">{p.description}</p>}
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-text-tertiary">
                    <span>{dstr(p.startDate)} → {dstr(p.endDate)}</span>
                    <span>{targetText(p)}</span>
                    {p.timesApplied > 0 && <span className="font-medium text-text-secondary">{p.timesApplied} aplicación(es)</span>}
                  </div>
                  {!p.subscriberStatus && !p.global && p.assignees.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {p.assignees.slice(0, 5).map((a: PromotionAssignee) => (
                        <span key={a.id} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-secondary">{a.name}</span>
                      ))}
                      {p.assignees.length > 5 && <span className="text-[11px] text-text-tertiary">+{p.assignees.length - 5}</span>}
                    </div>
                  )}
                  <div className="mt-auto flex items-center justify-end gap-1 border-t border-border-subtle pt-2">
                    <button type="button" onClick={() => setHistoryFor(p)} className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" title="Historial de asignaciones">
                      <Icon name="history" size={15} />
                    </button>
                    <button type="button" onClick={() => openEdit(p)} className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" title="Editar">
                      <Icon name="pencil" size={15} />
                    </button>
                    <button type="button" onClick={() => remove(p)} className="rounded-md p-1.5 text-text-tertiary hover:bg-error-soft hover:text-error-text" title="Eliminar">
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <p className="text-[12px] text-text-tertiary">
            Registro de qué promoción se asignó (o retiró) a cada funcionario, quién lo hizo y cuándo.
          </p>
          <div className="rounded-xl border border-border-subtle bg-surface p-3">
            <HistoryTable rows={history} showPromo />
          </div>
        </>
      )}

      {/* Modal crear / editar */}
      <Modal open={modalOpen} onClose={closeModal} title={editing ? `Editar · ${editing.name}` : "Nueva promoción"} maxWidth="max-w-3xl">
        <div className="grid gap-x-6 gap-y-3 lg:grid-cols-2">
          {/* Datos de la campaña */}
          <div className="flex flex-col gap-3">
            <Field label="Nombre de la campaña">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="10% Cortados" />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
              <Field label="Tipo de descuento">
                <Select value={draft.discountFormat} onChange={(e) => setDraft({ ...draft, discountFormat: e.target.value as DiscountFormat })}>
                  {DISCOUNT_FORMAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
              {isFlatDiscount(draft.discountFormat) ? (
                <Field label="Monto ($)">
                  <Input className="sm:w-36" type="number" min={1} value={draft.flatAmount} onChange={(e) => setDraft({ ...draft, flatAmount: e.target.value })} placeholder="5000" />
                </Field>
              ) : (
                <Field label="Descuento (%)">
                  <Input className="sm:w-28" type="number" min={1} max={100} value={draft.percentage} onChange={(e) => setDraft({ ...draft, percentage: e.target.value })} placeholder="10" />
                </Field>
              )}
            </div>
            <Field label="Descripción" hint="Opcional">
              <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Descuento por pronto pago" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Inicia">
                <Input type="date" value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} />
              </Field>
              <Field label="Finaliza">
                <Input type="date" value={draft.endDate} onChange={(e) => setDraft({ ...draft, endDate: e.target.value })} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-[13px] text-text-secondary">
              <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
              Activa
            </label>
          </div>

          {/* Tipo de promoción (fiel al legacy settings/promociones) */}
          <div className="flex flex-col gap-3">
            <Field label="Tipo de promoción" hint="Ingresar: para todos. Colaboradores: la aplican los funcionarios elegidos. Estados: aplica a los clientes en ese estado.">
              <Select value={draft.tipo} onChange={(e) => setDraft({ ...draft, tipo: e.target.value as Tipo })}>
                {TIPO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </Field>

            {draft.tipo === "ingresar" && (
              <div className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-[12px] text-text-secondary">
                <Icon name="users" size={15} className="mt-0.5 shrink-0 text-text-tertiary" />
                Disponible para <b>todos los funcionarios</b> (equivale a "Ingresar" del legacy).
              </div>
            )}

            {draft.tipo === "estado" && (
              <Field label="Estado de cliente">
                <Select value={draft.subscriberStatus} onChange={(e) => setDraft({ ...draft, subscriberStatus: e.target.value })}>
                  <option value="">— Elegir estado —</option>
                  {STATUS_KEYS.map((k) => (
                    <option key={k} value={k}>{SUB_STATUS_LABEL[k]}</option>
                  ))}
                </Select>
              </Field>
            )}

            {draft.tipo === "colaboradores" && (
              <Field label="Colaboradores autorizados" hint={`${draft.assigneeIds.length} seleccionado(s)`}>
                <div className="rounded-lg border border-border-subtle">
                  <div className="border-b border-border-subtle p-2">
                    <Input value={staffQuery} onChange={(e) => setStaffQuery(e.target.value)} placeholder="Buscar funcionario…" />
                  </div>
                  <div className="grid max-h-40 grid-cols-1 gap-x-2 overflow-y-auto p-1 sm:grid-cols-2">
                    {filteredStaff.length === 0 ? (
                      <p className="p-2 text-[12px] text-text-tertiary">Sin funcionarios.</p>
                    ) : filteredStaff.map((s) => (
                      <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-2">
                        <input type="checkbox" checked={draft.assigneeIds.includes(s.id)} onChange={() => toggleAssignee(s.id)} />
                        <span className="truncate text-text-primary">{s.name}</span>
                        {s.area && <span className="shrink-0 text-[11px] text-text-tertiary">· {s.area}</span>}
                      </label>
                    ))}
                  </div>
                </div>
              </Field>
            )}
          </div>
        </div>

        <div className="mt-2 flex justify-end gap-2 border-t border-border-subtle pt-3">
          <Button variant="secondary" onClick={closeModal}>Cancelar</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Guardando…" : editing ? "Guardar cambios" : "Crear promoción"}</Button>
        </div>
      </Modal>

      {/* Historial de una promoción específica */}
      {historyFor && (
        <Modal open onClose={() => setHistoryFor(null)} title={`Historial · ${historyFor.name}`}>
          <HistoryTable rows={(history ?? []).filter((h) => h.promotionId === historyFor.id)} showPromo={false} />
        </Modal>
      )}
    </div>
  );
}
