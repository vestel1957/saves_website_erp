"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { StatCard } from "@/components/accounting/StatCard";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { navSections } from "@/lib/nav";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { RegistrarPagoModal } from "@/components/cobranzas/RegistrarPagoModal";
import { EgresoModal, CierreCajaModal } from "@/components/cobranzas/TesoreriaModals";
import { NuevaOrdenModal } from "@/components/soporte/NuevaOrdenModal";
import { MikrotikModal } from "@/components/network/MikrotikModal";
import { TICKET_STATUS_LABEL, TICKET_STATUS_TONE } from "@/lib/support";

type WS = "caja" | "tecnico" | "general";
const WS_LABEL: Record<WS, string> = { caja: "Mi caja", tecnico: "Mi jornada", general: "General" };
const WS_ICON: Record<WS, string> = { caja: "wallet", tecnico: "wrench", general: "gauge" };

const todayISO = () => new Date().toISOString().slice(0, 10);
const saludo = () => { const h = new Date().getHours(); return h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches"; };
const fechaLarga = () => new Date().toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" });

export default function InicioPage() {
  const { user, loading, isSuperadmin } = useAuth();
  const perms = user?.permissions ?? [];

  const available = useMemo<WS[]>(() => {
    const a: WS[] = [];
    if (perms.includes("area.caja")) a.push("caja");
    if (perms.includes("area.tecnicos")) a.push("tecnico");
    a.push("general");
    return a;
  }, [perms]);

  const [ws, setWs] = useState<WS>("general");
  useEffect(() => { setWs(isSuperadmin ? "general" : available[0]); }, [available, isSuperadmin]);

  if (loading || !user) return <PageSkeleton />;
  const nombre = user.name?.split(" ")[0] || "";

  return (
    <div className="w-full">
      {/* Saludo + selector de workspace */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold text-text-primary">{saludo()}, {nombre} 👋</h1>
          <p className="text-[13px] capitalize text-text-tertiary">{fechaLarga()}</p>
        </div>
        {available.length > 1 && (
          <div className="flex gap-1 rounded-xl border border-border-subtle bg-surface p-1">
            {available.map((w) => (
              <button key={w} type="button" onClick={() => setWs(w)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors ${ws === w ? "bg-brand text-on-brand" : "text-text-secondary hover:bg-surface-2"}`}>
                <Icon name={WS_ICON[w]} size={13} /> {WS_LABEL[w]}
              </button>
            ))}
          </div>
        )}
      </div>

      {ws === "caja" && <MiCaja />}
      {ws === "tecnico" && <MiJornada />}
      {ws === "general" && <General />}
    </div>
  );
}

/* ─────────────────────────────  MI CAJA  ───────────────────────────── */
function MiCaja() {
  const { authFetch } = useAuth();
  const today = todayISO();
  const [stats, setStats] = useState<any>(null);
  const [opens, setOpens] = useState<any[]>([]);
  const [txs, setTxs] = useState<any[]>([]);
  const [pickSub, setPickSub] = useState<PickedSub | null>(null);
  const [payFor, setPayFor] = useState<string | null>(null);
  const [egreso, setEgreso] = useState(false);
  const [cierre, setCierre] = useState(false);

  const load = useCallback(() => {
    void authFetch(`/treasury/stats?from=${today}&to=${today}`).then((r) => r.json()).then(setStats).catch(() => {});
    void authFetch(`/treasury/cash-opens?pageSize=50`).then((r) => r.json()).then((d) => setOpens(d.items ?? [])).catch(() => {});
    void authFetch(`/treasury/transactions?from=${today}&to=${today}&pageSize=8`).then((r) => r.json()).then((d) => setTxs(d.items ?? [])).catch(() => {});
  }, [authFetch, today]);
  useEffect(load, [load]);

  const openToday = opens.filter((o) => String(o.date ?? "").slice(0, 10) === today);
  const cajaAbierta = openToday.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Estado de caja */}
      <div className={`flex flex-wrap items-center gap-3 rounded-xl border p-4 ${cajaAbierta ? "border-success-border bg-success-soft" : "border-warning-border bg-warning-soft"}`}>
        <Icon name={cajaAbierta ? "lock" : "power"} size={20} className={cajaAbierta ? "text-success-text" : "text-warning-text"} />
        <div className="min-w-0 grow">
          {cajaAbierta ? (
            <p className="text-[13px] font-semibold text-text-primary">Caja abierta hoy: {openToday.map((o) => o.accountName).filter(Boolean).join(", ") || "—"} <span className="font-normal text-text-tertiary">· por {openToday[0]?.openedBy ?? "—"}</span></p>
          ) : (
            <p className="text-[13px] font-semibold text-text-primary">No has abierto caja hoy.</p>
          )}
        </div>
        {!cajaAbierta && <Link href="/tesoreria/apertura"><Button size="sm"><Icon name="power" size={13} /> Abrir caja</Button></Link>}
      </div>

      {/* KPIs del día */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Recaudado hoy" value={cop(stats?.ingresos ?? 0)} icon="hand-coins" tone="success" hint={`${stats?.nIngresos ?? 0} recibos`} />
        <StatCard label="Egresos hoy" value={cop(stats?.egresos ?? 0)} icon="trending-down" tone="error" hint={`${stats?.nEgresos ?? 0} movimientos`} />
        <StatCard label="Balance del día" value={cop(stats?.balance ?? 0)} icon="wallet" />
      </div>

      {/* Acciones rápidas */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Cobrar a un cliente */}
        <div className="rounded-xl border border-border-subtle bg-surface p-4 lg:col-span-2">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-bold text-text-primary"><Icon name="hand-coins" size={15} className="text-brand" /> Cobrar a un cliente</div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="grow"><SubscriberPicker value={pickSub} onChange={setPickSub} placeholder="Buscar cliente por nombre, documento o abonado…" /></div>
            <Button disabled={!pickSub} onClick={() => pickSub && setPayFor(pickSub.id)}><Icon name="receipt" size={14} /> Registrar pago</Button>
          </div>
        </div>
        {/* Otras acciones */}
        <div className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-surface p-4">
          <div className="mb-1 text-[13px] font-bold text-text-primary">Otras acciones</div>
          <Button variant="secondary" onClick={() => setEgreso(true)}><Icon name="trending-down" size={14} /> Registrar egreso</Button>
          <Button variant="secondary" onClick={() => setCierre(true)}><Icon name="lock" size={14} /> Cerrar caja</Button>
          <Link href="/tesoreria" className="text-center text-[12px] font-medium text-brand hover:underline">Ver todos los movimientos →</Link>
        </div>
      </div>

      {/* Movimientos de hoy */}
      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-bold text-text-primary">Movimientos de hoy</span>
          <Link href="/tesoreria" className="text-[12px] text-brand hover:underline">Ver todos</Link>
        </div>
        {txs.length ? (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {txs.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2 text-[13px]">
                <Icon name={t.type === "INCOME" ? "trending-up" : "trending-down"} size={15} className={t.type === "INCOME" ? "text-success-text" : "text-error-text"} />
                <span className="min-w-0 grow truncate text-text-primary">{t.payer || t.category || "—"} <span className="text-[11px] text-text-tertiary">· {t.method ?? ""}</span></span>
                <span className={`shrink-0 font-semibold ${t.type === "INCOME" ? "text-success-text" : "text-error-text"}`}>{t.type === "INCOME" ? "+" : "−"} {cop(Math.abs(Number(t.amount ?? t.credit ?? t.debit ?? 0)))}</span>
              </li>
            ))}
          </ul>
        ) : <p className="py-3 text-center text-[12px] text-text-tertiary">Aún no hay movimientos hoy.</p>}
      </div>

      {payFor && <RegistrarPagoModal subscriberId={payFor} open={!!payFor} onClose={() => setPayFor(null)} onDone={() => { setPayFor(null); setPickSub(null); load(); }} />}
      <EgresoModal open={egreso} onClose={() => setEgreso(false)} onDone={() => { setEgreso(false); load(); }} />
      <CierreCajaModal open={cierre} onClose={() => setCierre(false)} onDone={() => { setCierre(false); load(); }} />
    </div>
  );
}

/* ────────────────────────────  MI JORNADA  ──────────────────────────── */
function MiJornada() {
  const { authFetch } = useAuth();
  const [data, setData] = useState<any>(null);
  const [nueva, setNueva] = useState(false);
  const [pickSub, setPickSub] = useState<PickedSub | null>(null);
  const [conn, setConn] = useState<PickedSub | null>(null);

  const load = useCallback(() => {
    void authFetch("/support/my-work").then((r) => r.json()).then(setData).catch(() => {});
  }, [authFetch]);
  useEffect(load, [load]);

  const c = data?.counts ?? { pendiente: 0, realizando: 0, resueltoHoy: 0 };
  const tickets: any[] = data?.tickets ?? [];

  return (
    <div className="flex flex-col gap-4">
      {!data?.resolved && data && (
        <div className="flex items-center gap-2 rounded-xl border border-warning-border bg-warning-soft p-3 text-[12px] text-text-secondary">
          <Icon name="info" size={15} className="text-warning-text" />
          No pudimos vincular tu usuario a un técnico, así que ves la <b>cola abierta del equipo</b>. Pídele a Sistemas que vincule tu correo con tu ficha de empleado.
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Pendientes" value={String(c.pendiente)} icon="clipboard-list" tone={c.pendiente > 0 ? "error" : "default"} />
        <StatCard label="En proceso" value={String(c.realizando)} icon="wrench" />
        <StatCard label="Resueltas hoy" value={String(c.resueltoHoy)} icon="check" tone="success" />
      </div>

      {/* Acción rápida: cliente */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-bold text-text-primary"><Icon name="user" size={15} className="text-brand" /> Buscar cliente</div>
          <SubscriberPicker value={pickSub} onChange={setPickSub} placeholder="Nombre, documento o abonado…" />
          {pickSub && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Link href={`/clientes/${pickSub.id}`}><Button size="sm" variant="secondary"><Icon name="external-link" size={13} /> Ver ficha</Button></Link>
              <Button size="sm" variant="secondary" onClick={() => setConn(pickSub)}><Icon name="power" size={13} /> Cortar / reconectar</Button>
            </div>
          )}
        </div>
        <div className="flex flex-col justify-center gap-2 rounded-xl border border-border-subtle bg-surface p-4">
          <div className="text-[13px] font-bold text-text-primary">Acciones</div>
          <Button onClick={() => setNueva(true)}><Icon name="plus" size={14} /> Nueva orden de trabajo</Button>
          <Link href="/red/masivo" className="text-center text-[12px] font-medium text-brand hover:underline">Operaciones masivas (por sede) →</Link>
        </div>
      </div>

      {/* Mis órdenes abiertas */}
      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-bold text-text-primary">{data?.resolved ? "Mis órdenes abiertas" : "Órdenes abiertas del equipo"} ({tickets.length})</span>
          <Link href="/soporte" className="text-[12px] text-brand hover:underline">Ir a Soporte</Link>
        </div>
        {tickets.length ? (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {tickets.map((t) => (
              <li key={t.id}>
                <Link href={`/soporte/${t.id}`} className="flex items-center gap-3 py-2.5 text-[13px] hover:bg-surface-2">
                  <Badge label={TICKET_STATUS_LABEL[t.status] ?? t.status} tone={TICKET_STATUS_TONE[t.status] ?? "default"} />
                  <div className="min-w-0 grow">
                    <p className="truncate font-medium text-text-primary">{t.type} <span className="text-text-tertiary">· Nº {t.code ?? "—"}</span></p>
                    <p className="truncate text-[11px] text-text-tertiary">{t.client ?? "Sin cliente"}{t.sede ? ` · ${t.sede}` : ""}{t.address ? ` · ${t.address}` : ""}</p>
                  </div>
                  {t.priority && <span className="shrink-0 text-[11px] text-text-tertiary">{t.priority}</span>}
                  <Icon name="chevron-right" size={14} className="shrink-0 text-text-tertiary" />
                </Link>
              </li>
            ))}
          </ul>
        ) : <p className="py-4 text-center text-[12px] text-text-tertiary">Sin órdenes abiertas. ¡Buen trabajo! 🎉</p>}
      </div>

      <NuevaOrdenModal open={nueva} onClose={() => setNueva(false)} onDone={() => { setNueva(false); load(); }} />
      {conn && <MikrotikModal subscriberId={conn.id} subscriberName={conn.name} open={!!conn} onClose={() => setConn(null)} onDone={() => setConn(null)} />}
    </div>
  );
}

/* ─────────────────────────────  GENERAL  ───────────────────────────── */
function General() {
  const { can } = useAuth();
  // Accesos rápidos: primer ítem accesible de cada sección (menos PRINCIPAL).
  const quick = useMemo(() => {
    const out: { icon: string; label: string; href: string; section: string }[] = [];
    for (const s of navSections) {
      if (s.title === "PRINCIPAL") continue;
      const flat = s.items.flatMap((i) => (i.children?.length ? i.children : [i]));
      const leaf = flat.find((i) => i.href && can(i.perm));
      if (leaf?.href) out.push({ icon: leaf.icon, label: s.title, href: leaf.href, section: s.title });
    }
    return out;
  }, [can]);

  return (
    <div className="flex flex-col gap-4">
      {can("dashboard.view") && (
        <Link href="/dashboard" className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface p-4 hover:border-brand">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-soft"><Icon name="layout-dashboard" size={20} className="text-brand" /></span>
          <div className="grow"><p className="text-[14px] font-bold text-text-primary">Panel ejecutivo</p><p className="text-[12px] text-text-tertiary">Indicadores de abonados, recaudo, cartera y red</p></div>
          <Icon name="arrow-right" size={16} className="text-text-tertiary" />
        </Link>
      )}
      <div>
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">Accesos rápidos</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {quick.map((q) => (
            <Link key={q.section} href={q.href} className="flex items-center gap-2.5 rounded-xl border border-border-subtle bg-surface p-3 hover:border-brand">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2"><Icon name={q.icon} size={16} className="text-brand" /></span>
              <span className="min-w-0 truncate text-[12px] font-semibold capitalize text-text-primary">{q.label.toLowerCase()}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
