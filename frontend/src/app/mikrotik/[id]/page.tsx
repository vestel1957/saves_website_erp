"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Pagination } from "@/components/ui/Pagination";
import { toast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { useOrden } from "@/lib/useOrden";
import { MK_ADMIN_ACTION_LABEL } from "@/lib/mikrotik";
import type { MkRouter, MkMode, MkSystem, MkSummary, MkSecret, MkActive, MkProfile, MkIpRow, MkIpStats, MkLog, Paged } from "@/lib/mikrotik";

type Tab = "resumen" | "secrets" | "activas" | "ips" | "perfiles" | "historial";
const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "resumen", label: "Resumen", icon: "router" },
  { key: "secrets", label: "Secrets PPPoE", icon: "key-round" },
  { key: "activas", label: "Sesiones activas", icon: "activity" },
  { key: "ips", label: "IPs", icon: "network" },
  { key: "perfiles", label: "Perfiles", icon: "gauge" },
  { key: "historial", label: "Historial", icon: "clock" },
];

export default function OperarMikrotikPage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch } = useAuth();
  const [router, setRouter] = useState<MkRouter | null>(null);
  const [mode, setMode] = useState<MkMode | null>(null);
  const [tab, setTab] = useState<Tab>("resumen");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [sys, setSys] = useState<MkSystem | null>(null);
  const [summary, setSummary] = useState<MkSummary | null>(null);
  const [secrets, setSecrets] = useState<Paged<MkSecret> | null>(null);
  const [secretSearch, setSecretSearch] = useState("");
  const [secretPage, setSecretPage] = useState(1);
  const [active, setActive] = useState<MkActive[] | null>(null);
  const [ips, setIps] = useState<MkIpRow[] | null>(null);
  const [ipStats, setIpStats] = useState<MkIpStats | null>(null);
  const [ipSearch, setIpSearch] = useState("");
  const [profiles, setProfiles] = useState<MkProfile[] | null>(null);
  const [history, setHistory] = useState<MkLog[]>([]);
  // Estado de la lectura en vivo del Resumen: si el router no respondió, se muestra
  // la estructura con "—" y un aviso, en vez de ceros confusos.
  const [resumenLoaded, setResumenLoaded] = useState(false);
  const [resumenOk, setResumenOk] = useState(false);
  const [resumenError, setResumenError] = useState("");
  // Confirmación de las acciones que tocan el router de producción.
  const [confirmar, setConfirmar] = useState<
    { kind: "secret"; secret: MkSecret } | { kind: "kick"; sesion: MkActive } | null
  >(null);

  const live = !!mode?.live;

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/network/mikrotik/mode").then((r) => r.json()).then(setMode).catch(() => {});
    void authFetch("/network/mikrotik/routers").then((r) => r.json())
      .then((list: MkRouter[]) => setRouter(list.find((x) => x.id === id) ?? null)).catch(() => {});
  }, [authLoading, authFetch, id]);

  const loadResumen = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const [s, sm] = await Promise.all([
        authFetch(`/network/mikrotik/${id}/system`).then((x) => x.json()),
        authFetch(`/network/mikrotik/${id}/summary`).then((x) => x.json()),
      ]);
      setSys(s.info ?? null); setSummary(sm.summary ?? null);
      const ok = !!s.ok && !!sm.ok;
      setResumenOk(ok);
      setResumenError(ok ? "" : (s.error || sm.error || "El router no respondió."));
      setResumenLoaded(true);
    } finally { setBusy(false); }
  }, [authFetch, id]);

  // Los secrets llegan del router y se cortan en el servidor, así que el orden
  // también se pide allí: aquí solo tenemos la página que se está viendo.
  const orden = useOrden();

  const loadSecrets = useCallback(async (page = 1, search = secretSearch) => {
    setBusy(true); setErr("");
    try {
      const qs = new URLSearchParams({ page: String(page), pageSize: "50", search, ...orden.params });
      const r = await authFetch(`/network/mikrotik/${id}/secrets?${qs}`).then((x) => x.json());
      setSecrets(r); setSecretPage(page);
      if (!r.ok) setErr(r.error || "Sin respuesta del router.");
    } finally { setBusy(false); }
  }, [authFetch, id, secretSearch, orden.clave]);

  const loadActive = useCallback(async () => {
    setBusy(true); setErr("");
    try { const r = await authFetch(`/network/mikrotik/${id}/active`).then((x) => x.json()); setActive(r.items ?? []); if (!r.ok) setErr(r.error || "Sin respuesta del router."); }
    finally { setBusy(false); }
  }, [authFetch, id]);

  const loadIps = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const r = await authFetch(`/network/mikrotik/${id}/ips`).then((x) => x.json());
      setIps(r.items ?? []); setIpStats(r.stats ?? null);
      if (!r.ok) setErr(r.error || "Sin respuesta del router.");
    } finally { setBusy(false); }
  }, [authFetch, id]);

  const loadProfiles = useCallback(async () => {
    setBusy(true); setErr("");
    try { const r = await authFetch(`/network/mikrotik/${id}/profiles`).then((x) => x.json()); setProfiles(r.items ?? []); if (!r.ok) setErr(r.error || "Sin respuesta del router."); }
    finally { setBusy(false); }
  }, [authFetch, id]);

  const loadHistory = useCallback(async () => {
    const r = await authFetch(`/network/mikrotik/${id}/history?limit=100`).then((x) => x.json());
    setHistory(Array.isArray(r) ? r : []);
  }, [authFetch, id]);

  // Al cambiar el orden, recarga desde la primera página (solo si ya se abrió
  // la pestaña: si no, la carga inicial de abajo se encarga).
  useEffect(() => {
    if (tab === "secrets" && secrets !== null) void loadSecrets(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orden.clave]);

  useEffect(() => {
    if (!router) return;
    if (tab === "resumen" && sys === null) void loadResumen();
    if (tab === "secrets" && secrets === null) void loadSecrets(1, "");
    if (tab === "activas" && active === null) void loadActive();
    if (tab === "ips" && ips === null) void loadIps();
    if (tab === "perfiles" && profiles === null) void loadProfiles();
    if (tab === "historial") void loadHistory();
  }, [tab, router]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSecret = async (s: MkSecret) => {
    const next = !s.disabled;
    setBusy(true);
    try {
      const r = await authFetch(`/network/mikrotik/${id}/secret/toggle`, { method: "POST", body: JSON.stringify({ name: s.name, disabled: next }) }).then((x) => x.json());
      if (r.ok) { toast(r.dryRun ? `Plan (dry-run): ${r.plan}` : (r.message || "OK"), "check"); void loadSecrets(secretPage); }
      else toast(r.error || "Error", "x");
    } finally { setBusy(false); setConfirmar(null); }
  };

  const kick = async (a: MkActive) => {
    setBusy(true);
    try {
      const r = await authFetch(`/network/mikrotik/${id}/active/kick`, { method: "POST", body: JSON.stringify({ name: a.name }) }).then((x) => x.json());
      if (r.ok) { toast(r.dryRun ? `Plan (dry-run): ${r.plan}` : (r.message || "OK"), "check"); void loadActive(); }
      else toast(r.error || "Error", "x");
    } finally { setBusy(false); setConfirmar(null); }
  };

  if (authLoading || !router) return <PageSkeleton />;

  return (
    <>
      {/* Antes esta ficha pintaba el título DOS veces: el `PageHeading` y un
          `<h1>` propio, ambos con "Mikrotik <nombre>". */}
      <DetailHeader
        backHref="/mikrotik"
        backLabel="Mikrotik"
        icon="router"
        title={`Mikrotik ${router.name}`}
        subtitle={<span className="font-mono">{(router.tech || "—")} · {router.ip}:{router.port}</span>}
        badges={mode ? <Badge label={live ? "MODO LIVE" : "DRY-RUN"} tone={live ? "error" : "info"} /> : undefined}
      />

      <div className="mb-3 flex flex-wrap gap-1 border-b border-border-subtle">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 rounded-t-md px-3 py-2 text-[13px] font-medium ${tab === t.key ? "border-b-2 border-brand text-brand" : "text-text-tertiary hover:text-text-secondary"}`}>
            <Icon name={t.icon} size={14} />{t.label}
          </button>
        ))}
      </div>

      {err && <div className="mb-3 rounded-lg border border-border-subtle bg-error-soft p-2 text-[12px] text-error-text">{err}</div>}
      {busy && <div className="mb-2 flex items-center gap-2 text-[12px] text-text-tertiary"><Icon name="loader" size={14} className="animate-spin" />Consultando el router por la API RouterOS…</div>}

      {/* RESUMEN */}
      {tab === "resumen" && (
        <>
          {resumenLoaded && !resumenOk && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft p-2.5 text-[12px] text-warning-text">
              <Icon name="alert-triangle" size={15} className="mt-0.5 shrink-0" />
              <span>
                El router no respondió{live ? "" : " (modo DRY-RUN)"} — los valores en vivo no están disponibles.
                {resumenError ? <span className="ml-1 font-mono text-[11px] opacity-80">({resumenError})</span> : null} Pulse «Refrescar» para reintentar.
              </span>
            </div>
          )}
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <SumBox label="Secrets PPPoE" value={resumenOk ? (summary?.secrets ?? 0) : "—"} icon="key-round" />
            <SumBox label="Sesiones activas" value={resumenOk ? (summary?.active ?? 0) : "—"} icon="activity" tone="text-success-text" />
            <SumBox label="En ACTIVOS" value={resumenOk ? (summary?.activos ?? 0) : "—"} icon="wifi" />
            <SumBox label="En MOROSOS" value={resumenOk ? (summary?.morosos ?? 0) : "—"} icon="wifi-off" tone="text-error-text" />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[["Identidad", sys?.identity], ["Modelo", sys?.model || sys?.boardName], ["RouterOS", sys?.version], ["Firmware", sys?.firmware],
              ["Uptime", sys?.uptime], ["CPU", sys?.cpuLoad ? `${sys.cpuLoad}%` : ""], ["Arquitectura", sys?.architecture], ["Serial", sys?.serial]].map(([k, v]) => (
              <div key={k} className="rounded-xl border border-border-subtle bg-surface p-3">
                <div className="text-[11px] text-text-tertiary">{k}</div>
                <div className="mt-0.5 truncate font-mono text-[13px] text-text-primary">{v || "—"}</div>
              </div>
            ))}
            <div className="col-span-2 sm:col-span-4"><Button variant="secondary" onClick={loadResumen}><Icon name="refresh-cw" size={14} className="mr-1" />Refrescar</Button></div>
          </div>
        </>
      )}

      {/* SECRETS PPPoE */}
      {tab === "secrets" && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input value={secretSearch} onChange={(e) => setSecretSearch(e.target.value)} placeholder="Buscar por usuario, IP o comentario…"
              className="max-w-xs" onKeyDown={(e) => e.key === "Enter" && loadSecrets(1)} />
            <Button onClick={() => loadSecrets(1)}><Icon name="search" size={14} className="mr-1" />Buscar</Button>
            <Button variant="secondary" onClick={() => loadSecrets(secretPage)}><Icon name="refresh-cw" size={14} className="mr-1" />Refrescar</Button>
          </div>
          <DataTable rows={secrets?.items ?? []} empty="Sin secrets PPPoE." sort={orden.sort} onSort={orden.onSort} columns={[
            { key: "name", header: "Usuario", sortable: true, render: (s) => <span className="font-mono text-text-primary">{s.name}</span> },
            { key: "profile", header: "Perfil", sortable: true, render: (s) => s.profile || "—" },
            { key: "remote", header: "IP remota", sortable: true, render: (s) => <span className="font-mono text-text-secondary">{s.remoteAddress || "—"}</span> },
            { key: "service", header: "Servicio", sortable: true, render: (s) => s.service || "—" },
            { key: "st", header: "Estado", sortable: true, render: (s) => <Badge label={s.disabled ? "Deshabilitado" : "Habilitado"} tone={s.disabled ? "error" : "success"} /> },
            { key: "comment", header: "Comentario", sortable: true, render: (s) => <span className="text-[12px] text-text-tertiary">{s.comment || "—"}</span> },
            { key: "acc", header: "Acciones", render: (s) => (
              <button title={s.disabled ? "Habilitar" : "Deshabilitar"} onClick={() => setConfirmar({ kind: "secret", secret: s })}
                className={`rounded p-1 hover:bg-surface-2 ${s.disabled ? "text-text-tertiary hover:text-success-text" : "text-text-tertiary hover:text-error-text"}`}>
                <Icon name={s.disabled ? "toggle-left" : "toggle-right"} size={17} />
              </button>
            ) },
          ]} />
          {secrets && (
            <div className="mt-2">
              <Pagination
                meta={{ page: secrets.page ?? secretPage, pageSize: secrets.pageSize ?? 50, total: secrets.total ?? 0, pageCount: secrets.pages ?? 1 }}
                onPage={(p) => void loadSecrets(p)}
              />
            </div>
          )}
        </>
      )}

      {/* SESIONES ACTIVAS */}
      {tab === "activas" && (
        <>
          <div className="mb-2"><Button variant="secondary" onClick={loadActive}><Icon name="refresh-cw" size={14} className="mr-1" />Refrescar</Button></div>
          <DataTable rows={active ?? []} empty="No hay sesiones PPP activas." columns={[
            { key: "name", header: "Usuario", render: (a) => <span className="font-mono text-text-primary">{a.name}</span> },
            { key: "address", header: "IP", render: (a) => <span className="font-mono text-text-secondary">{a.address || "—"}</span> },
            { key: "uptime", header: "Tiempo", render: (a) => a.uptime || "—" },
            { key: "caller", header: "MAC / Caller", render: (a) => <span className="font-mono text-[12px]">{a.callerId || "—"}</span> },
            { key: "acc", header: "", render: (a) => (
              <button title="Cerrar sesión" onClick={() => setConfirmar({ kind: "kick", sesion: a })} className="tap rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-error-text"><Icon name="power" size={15} /></button>
            ) },
          ]} />
        </>
      )}

      {/* IPs — vista de direccionamiento (clon de lista_vista_ips) */}
      {tab === "ips" && (
        <>
          {ipStats && (
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              <SumBox label="IPs asignadas" value={ipStats.total} icon="network" />
              <SumBox label="Online" value={ipStats.online} icon="wifi" tone="text-success-text" />
              <SumBox label="Offline" value={ipStats.offline} icon="wifi-off" tone="text-text-tertiary" />
              <SumBox label="Deshabilitados" value={ipStats.disabled} icon="ban" tone="text-error-text" />
              <SumBox label="IPs en conflicto" value={ipStats.conflicts} icon="alert-triangle" tone={ipStats.conflicts ? "text-error-text" : "text-text-primary"} />
            </div>
          )}
          {!!ipStats?.conflicts && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-error/40 bg-error-soft p-2.5 text-[12px] text-error-text">
              <Icon name="alert-triangle" size={15} className="mt-0.5 shrink-0" />
              <span>Hay {ipStats.conflicts} IP{ipStats.conflicts === 1 ? "" : "s"} asignada{ipStats.conflicts === 1 ? "" : "s"} a más de un abonado (filas resaltadas). Revíselas: dos clientes con la misma IP genera cortes intermitentes.</span>
            </div>
          )}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input value={ipSearch} onChange={(e) => setIpSearch(e.target.value)} placeholder="Filtrar por IP, usuario o perfil…" className="max-w-xs" />
            <Button variant="secondary" onClick={loadIps}><Icon name="refresh-cw" size={14} className="mr-1" />Refrescar</Button>
          </div>
          <DataTable
            rows={(ips ?? []).filter((x) => {
              const q = ipSearch.trim().toLowerCase();
              return !q || `${x.ip} ${x.user} ${x.profile} ${x.comment}`.toLowerCase().includes(q);
            })}
            empty="Sin IPs asignadas en los secrets PPPoE."
            columns={[
              { key: "ip", header: "IP", render: (x) => (
                <span className={`font-mono ${x.conflict ? "font-semibold text-error-text" : "text-text-primary"}`}>
                  {x.conflict && <Icon name="alert-triangle" size={12} className="mr-1 inline align-[-1px]" />}{x.ip}
                </span>
              ) },
              { key: "user", header: "Usuario", render: (x) => <span className="font-mono text-text-secondary">{x.user}</span> },
              { key: "profile", header: "Perfil", render: (x) => x.profile || "—" },
              { key: "conn", header: "Conexión", render: (x) => (
                <div className="flex items-center gap-1.5">
                  <Badge label={x.online ? "Online" : "Offline"} tone={x.online ? "success" : "info"} />
                  {x.online && x.liveAddress && x.liveAddress !== x.ip && (
                    <span className="font-mono text-[11px] text-warning-text" title="La sesión activa tiene una IP distinta a la del secret">→ {x.liveAddress}</span>
                  )}
                </div>
              ) },
              { key: "st", header: "Estado", render: (x) => <Badge label={x.disabled ? "Deshabilitado" : "Habilitado"} tone={x.disabled ? "error" : "success"} /> },
              { key: "comment", header: "Comentario", render: (x) => <span className="text-[12px] text-text-tertiary">{x.comment || "—"}</span> },
            ]}
          />
        </>
      )}

      {/* PERFILES */}
      {tab === "perfiles" && (
        <>
          <div className="mb-2"><Button variant="secondary" onClick={loadProfiles}><Icon name="refresh-cw" size={14} className="mr-1" />Refrescar</Button></div>
          <DataTable rows={profiles ?? []} empty="Sin perfiles PPP." columns={[
            { key: "name", header: "Perfil", render: (p) => <span className="font-medium text-text-primary">{p.name}</span> },
            { key: "rate", header: "Velocidad (rate-limit)", render: (p) => <span className="font-mono text-text-secondary">{p.rateLimit || "—"}</span> },
            { key: "local", header: "IP local", render: (p) => <span className="font-mono text-[12px]">{p.localAddress || "—"}</span> },
            { key: "remote", header: "Pool remoto", render: (p) => <span className="font-mono text-[12px]">{p.remoteAddress || "—"}</span> },
            { key: "one", header: "Única sesión", render: (p) => p.onlyOne || "—" },
          ]} />
        </>
      )}

      {/* HISTORIAL */}
      {tab === "historial" && (
        <DataTable rows={history} empty="Sin acciones registradas." columns={[
          { key: "date", header: "Fecha", render: (l) => new Date(l.createdAt).toLocaleString("es-CO") },
          { key: "action", header: "Acción", render: (l) => <Badge label={MK_ADMIN_ACTION_LABEL[l.action] ?? l.action} tone={l.ok ? "success" : "error"} /> },
          { key: "mode", header: "Modo", render: (l) => <Badge label={l.dryRun ? "dry-run" : "live"} tone={l.dryRun ? "info" : "warning"} /> },
          { key: "detail", header: "Detalle", render: (l) => <span className="text-[12px] text-text-tertiary">{l.detail}</span> },
          { key: "user", header: "Usuario", render: (l) => l.userName || "—" },
        ]} />
      )}

      {confirmar?.kind === "secret" && (() => {
        const s = confirmar.secret;
        const deshabilitar = !s.disabled; // acción que se va a ejecutar
        return (
          <ConfirmDialog
            open
            busy={busy}
            onClose={() => setConfirmar(null)}
            onConfirm={() => void toggleSecret(s)}
            tone={deshabilitar ? "danger" : "primary"}
            icon={deshabilitar ? "wifi-off" : "wifi"}
            title={deshabilitar ? "Deshabilitar secret PPPoE" : "Habilitar secret PPPoE"}
            confirmLabel={deshabilitar ? "Deshabilitar secret" : "Habilitar secret"}
            // Deshabilitar en LIVE deja al abonado sin internet: se teclea el usuario.
            // En dry-run no se toca el router, así que no se pide nada.
            requireText={live && deshabilitar ? s.name : undefined}
            requireHint={<>Para confirmar, escriba el usuario <span className="font-mono font-semibold text-text-primary">{s.name}</span></>}
            message={
              deshabilitar ? (
                <>
                  Se deshabilitará el secret en el router {router.name}.{" "}
                  {live
                    ? <b className="text-error-text">El abonado se quedará sin internet hasta que vuelva a habilitarlo.</b>
                    : <>Está en <b>dry-run</b>: solo se generará el plan, no se toca el router.</>}
                </>
              ) : (
                <>
                  Se habilitará el secret y el abonado podrá volver a conectarse{live ? " en cuanto reintente la sesión PPPoE" : ""}.{" "}
                  {!live && <>Está en <b>dry-run</b>: solo se generará el plan, no se toca el router.</>}
                </>
              )
            }
            detail={<SecretResumen secret={s} />}
          />
        );
      })()}

      {confirmar?.kind === "kick" && (
        <ConfirmDialog
          open
          busy={busy}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void kick(confirmar.sesion)}
          tone="danger"
          icon="power"
          title="Cerrar sesión PPPoE"
          confirmLabel="Cerrar la sesión"
          message={
            live ? (
              <>
                Se cortará la conexión de <b className="font-mono">{confirmar.sesion.name}</b> en el router {router.name}.
                El abonado perderá internet un momento y su equipo volverá a entrar solo en unos segundos.
              </>
            ) : (
              <>
                Se cerraría la sesión de <b className="font-mono">{confirmar.sesion.name}</b>, cortándole la conexión hasta que
                su equipo reconecte solo en unos segundos. Está en <b>dry-run</b>: solo se generará el plan, no se toca el router.
              </>
            )
          }
          detail={<SesionResumen sesion={confirmar.sesion} />}
        />
      )}
    </>
  );
}

/** Filas de una ficha compacta dentro de la confirmación. */
function FichaFilas({ filas }: { filas: [string, React.ReactNode][] }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-2 p-2.5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
        {filas.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-text-tertiary">{k}</dt>
            <dd className="text-right text-text-primary">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

/** Ficha del secret: para verificar que se toca el del abonado que se cree. */
function SecretResumen({ secret }: { secret: MkSecret }) {
  return <FichaFilas filas={[
    ["Usuario", <span key="a" className="font-mono">{secret.name}</span>],
    ["Perfil", secret.profile || "—"],
    ["IP remota", <span key="b" className="font-mono">{secret.remoteAddress || "—"}</span>],
    ["Estado", <Badge key="c" label={secret.disabled ? "Deshabilitado" : "Habilitado"} tone={secret.disabled ? "error" : "success"} />],
    ["Comentario", <span key="d" className="text-text-tertiary">{secret.comment || "—"}</span>],
  ]} />;
}

/** Ficha de la sesión activa que se va a cerrar. */
function SesionResumen({ sesion }: { sesion: MkActive }) {
  return <FichaFilas filas={[
    ["Usuario", <span key="a" className="font-mono">{sesion.name}</span>],
    ["IP", <span key="b" className="font-mono">{sesion.address || "—"}</span>],
    ["Tiempo conectado", sesion.uptime || "—"],
    ["MAC / Caller", <span key="c" className="font-mono">{sesion.callerId || "—"}</span>],
  ]} />;
}

function SumBox({ label, value, icon, tone }: { label: string; value: number | string; icon: string; tone?: string }) {
  const shown = typeof value === "number" ? value.toLocaleString("es-CO") : value;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand"><Icon name={icon} size={17} /></span>
      <div className="flex flex-col leading-tight">
        <span className={`text-[17px] font-bold ${tone ?? "text-text-primary"}`}>{shown}</span>
        <span className="text-[11px] text-text-tertiary">{label}</span>
      </div>
    </div>
  );
}
