"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/Modal";
import { Input } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { SUB_STATUS_LABEL } from "@/lib/subscribers";
import { BotonOrden, useTablaOrdenable } from "@/components/ui/tabla-ordenable";
import { PromocionModal } from "@/components/promotions/PromocionModal";
import {
  type Promotion, type PromotionCatalogs, type PromotionTargetLog,
  type PromotionApplication,
  INVOICE_SCOPE_OPTIONS, discountLabel, isBeforeTaxDiscount,
} from "@/lib/promotions";

const statusText = (s: string) => SUB_STATUS_LABEL[s] ?? s;
const cop = (n: number) => `$${Math.round(Number(n || 0)).toLocaleString("es-CO")}`;

const dstr = (iso: string) => iso.slice(0, 10);
const dtstr = (iso: string) =>
  new Date(iso).toLocaleString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** ¿Programada = activa, aún no vigente y con fecha de inicio futura? */
const isProgramada = (p: Promotion) => p.active && !p.vigente && new Date(p.startDate).getTime() > Date.now();

/** Público de la promo, en fichas legibles (lo que se ve en la tarjeta). */
function publicoChips(p: Promotion): { label: string; icon: string }[] {
  if (p.allSubscribers) return [{ label: "Todos los clientes", icon: "users" }];
  const chips: { label: string; icon: string }[] = [];
  for (const s of p.subscriberStatuses) chips.push({ label: statusText(s), icon: "activity" });
  if (p.subscribers.length === 1) {
    const s = p.subscribers[0];
    chips.push({ label: `${s.fullName?.trim() || "Cliente"} #${s.abonado}`, icon: "user" });
  } else if (p.subscribers.length > 1) {
    chips.push({ label: `${p.subscribers.length} clientes puntuales`, icon: "user" });
  }
  for (const pl of p.plans) chips.push({ label: pl.name, icon: "wifi" });
  for (const b of p.branches) chips.push({ label: b.name, icon: "landmark" });
  for (const n of p.neighborhoods) chips.push({ label: n.name, icon: "map-pin" });
  return chips;
}

function HistoryTable({ rows, showPromo }: { rows: PromotionTargetLog[] | null; showPromo: boolean }) {
  if (!rows) return <p className="text-[13px] text-text-tertiary">Cargando…</p>;
  if (rows.length === 0) return <p className="text-[13px] text-text-tertiary">Sin cambios de público todavía.</p>;
  return <HistoryRows rows={rows} showPromo={showPromo} />;
}

/** Filas de la bitácora, separadas para poder usar el hook de orden. */
function HistoryRows({ rows, showPromo }: { rows: PromotionTargetLog[]; showPromo: boolean }) {
  const t = useTablaOrdenable(rows, {
    fecha: (h) => h.createdAt,
    promo: (h) => h.promotionName,
    destinatario: (h) => h.targetLabel,
    accion: (h) => h.action,
    por: (h) => h.changedByName,
  });
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-border-subtle text-left text-text-tertiary">
            <th className="py-1.5 pr-3 font-medium"><BotonOrden t={t} clave="fecha">Fecha</BotonOrden></th>
            {showPromo && <th className="py-1.5 pr-3 font-medium"><BotonOrden t={t} clave="promo">Promoción</BotonOrden></th>}
            <th className="py-1.5 pr-3 font-medium"><BotonOrden t={t} clave="destinatario">Destinatario</BotonOrden></th>
            <th className="py-1.5 pr-3 font-medium"><BotonOrden t={t} clave="accion">Acción</BotonOrden></th>
            <th className="py-1.5 pr-3 font-medium"><BotonOrden t={t} clave="por">Por</BotonOrden></th>
          </tr>
        </thead>
        <tbody>
          {t.filas.map((h) => (
            <tr key={h.id} className="border-b border-border-subtle/60">
              <td className="whitespace-nowrap py-1.5 pr-3 text-text-tertiary">{dtstr(h.createdAt)}</td>
              {showPromo && <td className="py-1.5 pr-3 font-medium text-text-primary">{h.promotionName}</td>}
              <td className="py-1.5 pr-3 text-text-primary">{h.targetLabel}</td>
              <td className="py-1.5 pr-3">
                <Badge tone={h.action === "ADDED" ? "success" : "default"} label={h.action === "ADDED" ? "Agregado" : "Quitado"} />
              </td>
              <td className="py-1.5 pr-3 text-text-tertiary">{h.changedByName ?? "—"}</td>
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
  const [catalogs, setCatalogs] = useState<PromotionCatalogs | null>(null);
  const [editing, setEditing] = useState<Promotion | null>(null);
  const [history, setHistory] = useState<PromotionTargetLog[] | null>(null);
  const [historyFor, setHistoryFor] = useState<Promotion | null>(null);
  const [appsFor, setAppsFor] = useState<Promotion | null>(null);
  const [apps, setApps] = useState<PromotionApplication[] | null>(null);
  const [confirmar, setConfirmar] = useState<Promotion | null>(null);
  const [borrando, setBorrando] = useState(false);

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
    void authFetch(`/promotions/catalogs`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setCatalogs)
      .catch(() => setCatalogs(null));
  }, [authFetch, isSuperadmin, load, loadHistory]);

  // Aplicaciones de una promo (a qué facturas se le descontó de verdad).
  useEffect(() => {
    if (!appsFor) { setApps(null); return; }
    void authFetch(`/promotions/${appsFor.id}/applications`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setApps)
      .catch(() => setApps([]));
  }, [appsFor, authFetch]);

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

  function openNew() { setEditing(null); setModalOpen(true); }
  function openEdit(p: Promotion) { setEditing(p); setModalOpen(true); }
  function closeModal() { setModalOpen(false); setEditing(null); }

  async function remove(p: Promotion) {
    setBorrando(true);
    try {
      const res = await authFetch(`/promotions/${p.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo eliminar");
      toast("Promoción eliminada", "check");
      setConfirmar(null);
      load(); loadHistory();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setBorrando(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeading
          icon="gift"
          title="Promociones"
          subtitle="Campañas de descuento dirigidas a CLIENTES. Cada promoción define a quién alcanza —todos, un estado, clientes puntuales, un plan, una sede o un barrio— y solo aparece en las facturas de esos clientes."
        />
        <Button onClick={openNew} className="shrink-0">
          <Icon name="plus" size={15} /> Nueva promoción
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {([["promos", "Promociones", "gift"], ["historial", "Bitácora del público", "history"]] as [typeof tab, string, string][]).map(([k, label, icon]) => (
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
              {visible.map((p) => {
                const chips = publicoChips(p);
                return (
                  <div key={p.id} className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm transition-colors hover:border-brand/40">
                    <div className="flex items-start justify-between gap-2">
                      <span className="truncate text-[14px] font-semibold text-text-primary">{p.name}</span>
                      <Badge tone="brand" label={discountLabel(p)} />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {p.vigente ? <Badge tone="success" label="Vigente" /> : <Badge tone="default" label={p.active ? "Fuera de fecha" : "Inactiva"} />}
                      {isBeforeTaxDiscount(p.discountFormat) && <Badge tone="default" label="Antes de imp." />}
                      {/* A qué facturas llega en ventanilla: una campaña de cartera dejada
                          en "mensualidad del mes" no descuenta nada, y eso no se veía. */}
                      <Badge
                        tone="default"
                        label={
                          INVOICE_SCOPE_OPTIONS.find((o) => o.value === p.invoiceScope)?.label
                          ?? INVOICE_SCOPE_OPTIONS[0].label
                        }
                      />
                      {p.portalPreapply && <Badge tone="brand" label="Portal cobra rebajado" />}
                      {p.portalPublish && (
                        <Badge
                          tone={p.portalPublishedAt ? "brand" : "default"}
                          label={p.portalPublishedAt ? "En el portal de pagos" : "Portal: pendiente"}
                        />
                      )}
                    </div>
                    {p.description && <p className="truncate text-[12px] text-text-tertiary">{p.description}</p>}

                    {/* Público: a qué clientes alcanza */}
                    <div className="rounded-lg bg-surface-2 px-2 py-1.5">
                      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-tertiary">Aplica a</div>
                      <div className="flex flex-wrap gap-1">
                        {chips.slice(0, 6).map((c, i) => (
                          <span key={i} className="inline-flex items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-[11px] text-text-secondary">
                            <Icon name={c.icon} size={11} className="text-text-tertiary" /> {c.label}
                          </span>
                        ))}
                        {chips.length > 6 && <span className="text-[11px] text-text-tertiary">+{chips.length - 6}</span>}
                        {chips.length === 0 && <span className="text-[11px] text-warning-text">Sin público: no aparece en ninguna factura</span>}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-text-tertiary">
                      <span>{dstr(p.startDate)} → {dstr(p.endDate)}</span>
                      {p.timesApplied > 0 && (
                        <button type="button" onClick={() => setAppsFor(p)} className="font-medium text-brand hover:underline">
                          {p.timesApplied} aplicación(es)
                        </button>
                      )}
                    </div>
                    <div className="mt-auto flex items-center justify-end gap-1 border-t border-border-subtle pt-2">
                      <button type="button" onClick={() => setHistoryFor(p)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" title="Bitácora del público">
                        <Icon name="history" size={15} />
                      </button>
                      <button type="button" onClick={() => openEdit(p)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" title="Editar">
                        <Icon name="pencil" size={15} />
                      </button>
                      <button type="button" onClick={() => setConfirmar(p)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-error-soft hover:text-error-text" title="Eliminar">
                        <Icon name="trash" size={15} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          <p className="text-[12px] text-text-tertiary">
            Registro de qué destinatario entró o salió del público de cada promoción, quién lo hizo y cuándo.
            Es la traza que responde “¿por qué a este cliente se le descontó?”.
          </p>
          <div className="rounded-xl border border-border-subtle bg-surface p-3">
            <HistoryTable rows={history} showPromo />
          </div>
        </>
      )}

      {/* Crear / editar. Se monta al abrir para que arranque limpio en cada promoción. */}
      {modalOpen && (
        <PromocionModal
          editing={editing}
          catalogs={catalogs}
          onClose={closeModal}
          onSaved={() => { closeModal(); load(); loadHistory(); }}
        />
      )}

      {/* Bitácora de una promoción específica */}
      {historyFor && (
        <Modal open onClose={() => setHistoryFor(null)} title={`Público · ${historyFor.name}`}>
          <HistoryTable rows={(history ?? []).filter((h) => h.promotionId === historyFor.id)} showPromo={false} />
        </Modal>
      )}

      {/* Facturas a las que se aplicó */}
      {appsFor && (
        <Modal open onClose={() => setAppsFor(null)} title={`Aplicaciones · ${appsFor.name}`}>
          {!apps ? (
            <p className="text-[13px] text-text-tertiary">Cargando…</p>
          ) : apps.length === 0 ? (
            <p className="text-[13px] text-text-tertiary">Todavía no se ha aplicado a ninguna factura.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-border-subtle text-left text-text-tertiary">
                    <th className="py-1.5 pr-3 font-medium">Fecha</th>
                    <th className="py-1.5 pr-3 font-medium">Cliente</th>
                    <th className="py-1.5 pr-3 font-medium">Factura</th>
                    <th className="py-1.5 pr-3 font-medium">Descuento</th>
                    <th className="py-1.5 pr-3 font-medium">Aplicó</th>
                  </tr>
                </thead>
                <tbody>
                  {apps.map((a) => (
                    <tr key={a.id} className="border-b border-border-subtle/60">
                      <td className="whitespace-nowrap py-1.5 pr-3 text-text-tertiary">{dtstr(a.createdAt)}</td>
                      <td className="py-1.5 pr-3 text-text-primary">
                        {a.subscriberName ?? "—"} {a.abonado != null && <span className="font-mono text-[11px] text-text-tertiary">#{a.abonado}</span>}
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-text-secondary">{a.tid ?? "—"}</td>
                      <td className="py-1.5 pr-3 font-mono font-semibold text-text-primary">{cop(a.amount)}</td>
                      <td className="py-1.5 pr-3 text-text-tertiary">{a.appliedByName ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}

      {/* Confirmar borrado */}
      <ConfirmDialog
        open={!!confirmar}
        busy={borrando}
        title="Eliminar promoción"
        icon="trash"
        message={<>¿Eliminar la promoción <b>{confirmar?.name}</b>?</>}
        detail={confirmar?.timesApplied ? (
          <span>Ya se aplicó a {confirmar.timesApplied} factura(s). Las notas crédito emitidas NO se revierten.</span>
        ) : undefined}
        confirmLabel="Eliminar"
        onConfirm={() => confirmar && void remove(confirmar)}
        onClose={() => setConfirmar(null)}
      />
    </div>
  );
}
