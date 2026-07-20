"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/ui/PageHeading";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
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

  const loadSecrets = useCallback(async (page = 1, search = secretSearch) => {
    setBusy(true); setErr("");
    try {
      const r = await authFetch(`/network/mikrotik/${id}/secrets?page=${page}&pageSize=50&search=${encodeURIComponent(search)}`).then((x) => x.json());
      setSecrets(r); setSecretPage(page);
      if (!r.ok) setErr(r.error || "Sin respuesta del router.");
    } finally { setBusy(false); }
  }, [authFetch, id, secretSearch]);

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
    if (live && !confirm(`¿${next ? "DESHABILITAR" : "HABILITAR"} el secret "${s.name}" en el router REAL?`)) return;
    setBusy(true);
    try {
      const r = await authFetch(`/network/mikrotik/${id}/secret/toggle`, { method: "POST", body: JSON.stringify({ name: s.name, disabled: next }) }).then((x) => x.json());
      if (r.ok) { toast(r.dryRun ? `Plan (dry-run): ${r.plan}` : (r.message || "OK"), "check"); void loadSecrets(secretPage); }
      else toast(r.error || "Error", "x");
    } finally { setBusy(false); }
  };

  const kick = async (a: MkActive) => {
    if (live && !confirm(`¿Cerrar la sesión activa de "${a.name}" en el router REAL?`)) return;
    setBusy(true);
    try {
      const r = await authFetch(`/network/mikrotik/${id}/active/kick`, { method: "POST", body: JSON.stringify({ name: a.name }) }).then((x) => x.json());
      if (r.ok) { toast(r.dryRun ? `Plan (dry-run): ${r.plan}` : (r.message || "OK"), "check"); void loadActive(); }
      else toast(r.error || "Error", "x");
    } finally { setBusy(false); }
  };

  if (authLoading || !router) return <PageSkeleton />;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col items-start gap-1">
          <PageHeading icon="router" title={`Mikrotik ${router.name}`} />
          <h1 className="flex items-center gap-1.5 text-[16px] font-bold text-text-primary">
            <Icon name="router" size={17} className="text-brand" />Mikrotik {router.name}
          </h1>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-text-tertiary">
          <span className="font-mono">{(router.tech || "—")} · {router.ip}:{router.port}</span>
          {mode && <Badge label={live ? "MODO LIVE" : "DRY-RUN"} tone={live ? "error" : "info"} />}
        </div>
      </div>

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
          <DataTable rows={secrets?.items ?? []} empty="Sin secrets PPPoE." columns={[
            { key: "name", header: "Usuario", render: (s) => <span className="font-mono text-text-primary">{s.name}</span> },
            { key: "profile", header: "Perfil", render: (s) => s.profile || "—" },
            { key: "remote", header: "IP remota", render: (s) => <span className="font-mono text-text-secondary">{s.remoteAddress || "—"}</span> },
            { key: "service", header: "Servicio", render: (s) => s.service || "—" },
            { key: "st", header: "Estado", render: (s) => <Badge label={s.disabled ? "Deshabilitado" : "Habilitado"} tone={s.disabled ? "error" : "success"} /> },
            { key: "comment", header: "Comentario", render: (s) => <span className="text-[12px] text-text-tertiary">{s.comment || "—"}</span> },
            { key: "acc", header: "Acciones", render: (s) => (
              <button title={s.disabled ? "Habilitar" : "Deshabilitar"} onClick={() => toggleSecret(s)}
                className={`rounded p-1 hover:bg-surface-2 ${s.disabled ? "text-text-tertiary hover:text-success-text" : "text-text-tertiary hover:text-error-text"}`}>
                <Icon name={s.disabled ? "toggle-left" : "toggle-right"} size={17} />
              </button>
            ) },
          ]} />
          {secrets && secrets.pages > 1 && (
            <div className="mt-2 flex items-center justify-between text-[12px] text-text-tertiary">
              <span>{secrets.total.toLocaleString("es-CO")} secrets · página {secrets.page}/{secrets.pages}</span>
              <div className="flex gap-1">
                <Button size="sm" variant="secondary" disabled={secretPage <= 1} onClick={() => loadSecrets(secretPage - 1)}>Anterior</Button>
                <Button size="sm" variant="secondary" disabled={secretPage >= secrets.pages} onClick={() => loadSecrets(secretPage + 1)}>Siguiente</Button>
              </div>
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
              <button title="Cerrar sesión" onClick={() => kick(a)} className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-error-text"><Icon name="power" size={15} /></button>
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
    </>
  );
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
