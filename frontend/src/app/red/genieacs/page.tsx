"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/accounting/PageHeading";
import { DataTable } from "@/components/inventory/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { GenieacsServerModal } from "@/components/network/GenieacsServerModal";
import {
  informLabel, informTone,
  type CpeRow, type GenieacsDashboard, type GenieacsMode, type GenieacsServer, type Paged, type TvBatchResult,
} from "@/lib/genieacs";

function Kpi({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-3">
      <div className={`text-2xl font-bold ${tone ?? "text-text-primary"}`}>{value.toLocaleString("es-CO")}</div>
      <div className="text-[12px] text-text-tertiary">{label}</div>
    </div>
  );
}

export default function GenieacsPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [mode, setMode] = useState<GenieacsMode | null>(null);
  const [dash, setDash] = useState<GenieacsDashboard | null>(null);
  const [servers, setServers] = useState<GenieacsServer[]>([]);
  const [loading, setLoading] = useState(true);

  // inventario
  const [page, setPage] = useState<Paged<CpeRow> | null>(null);
  const [search, setSearch] = useState("");
  const [estado, setEstado] = useState("vivos");
  const [pageNum, setPageNum] = useState(1);
  const [invLoading, setInvLoading] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());

  // modales / acciones
  const [serverModal, setServerModal] = useState(false);
  const [editServer, setEditServer] = useState<GenieacsServer | null>(null);
  const [confirm, setConfirm] = useState<null | { enable: boolean }>(null);
  const [busy, setBusy] = useState(false);

  const loadTop = useCallback(async () => {
    setLoading(true);
    try {
      const [m, s] = await Promise.all([
        authFetch("/network/genieacs/mode").then((r) => r.json()),
        authFetch("/network/genieacs/servers").then((r) => r.json()),
      ]);
      setMode(m);
      setServers(Array.isArray(s) ? s : []);
      if (Array.isArray(s) && s.length) {
        const d = await authFetch("/network/genieacs/dashboard").then((r) => r.json());
        setDash(d);
      } else {
        setDash(null);
      }
    } catch {
      toast("No se pudo cargar GenieACS", "x");
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  const loadInventory = useCallback(async () => {
    if (!servers.length) { setPage(null); return; }
    setInvLoading(true);
    try {
      const qs = new URLSearchParams({ estado, page: String(pageNum), pageSize: "50" });
      if (search.trim()) qs.set("search", search.trim());
      const p = await authFetch(`/network/genieacs/inventory?${qs.toString()}`).then((r) => r.json());
      setPage(p);
    } catch {
      toast("No se pudo cargar el inventario", "x");
    } finally {
      setInvLoading(false);
    }
  }, [authFetch, servers.length, estado, pageNum, search]);

  useEffect(() => { if (!authLoading) void loadTop(); }, [authLoading, loadTop]);
  useEffect(() => { if (!authLoading) void loadInventory(); }, [authLoading, loadInventory]);

  const toggle = (id: string) => setSel((prev) => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const toggleAll = () => setSel((prev) => {
    if (!page) return prev;
    const allSel = page.items.every((r) => prev.has(r.id));
    return allSel ? new Set() : new Set(page.items.map((r) => r.id));
  });

  const test = async (s: GenieacsServer) => {
    const r = await authFetch(`/network/genieacs/servers/${s.id}/test`, { method: "POST" }).then((x) => x.json());
    toast(r.ok ? `${s.name}: NBI OK` : `${s.name}: ${r.error || "sin conexión"}`, r.ok ? "check" : "x");
    setServers((prev) => prev.map((x) => (x.id === s.id ? { ...x, online: !!r.ok } : x)));
  };

  const runTvBatch = async (enable: boolean) => {
    setBusy(true);
    try {
      const ids = Array.from(sel);
      const endpoint = enable ? "/network/genieacs/restore-tv" : "/network/genieacs/cut-tv";
      const r: TvBatchResult = await authFetch(endpoint, { method: "POST", body: JSON.stringify({ ids }) }).then((x) => x.json());
      if (r.dryRun) {
        toast(`DRY-RUN: ${enable ? "alta" : "corte"} de TV planificado para ${r.plan?.devices ?? ids.length} CPEs (no se tocó el ACS)`, "check");
      } else if (r.ok) {
        toast(`${enable ? "Alta" : "Corte"} de TV: ${r.done ?? 0} OK, ${r.failed ?? 0} fallidos`, "check");
      } else {
        toast(`${enable ? "Alta" : "Corte"} con errores: ${r.failed ?? 0} fallidos`, "x");
      }
      setSel(new Set());
      void loadTop();
      void loadInventory();
    } catch (e) {
      toast((e as Error).message, "x");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const installProvision = async () => {
    setBusy(true);
    try {
      const r = await authFetch("/network/genieacs/install-provision", { method: "POST", body: JSON.stringify({}) }).then((x) => x.json());
      if (r.dryRun) toast("DRY-RUN: provision/preset listos para instalar (no se tocó el ACS)", "check");
      else toast(r.ok ? "Provision + preset instalados en el ACS" : "No se pudo instalar el provision", r.ok ? "check" : "x");
    } catch (e) {
      toast((e as Error).message, "x");
    } finally {
      setBusy(false);
    }
  };

  if (authLoading || (loading && !mode)) return <PageSkeleton />;

  const noServer = !servers.length;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <PageHeading icon="tv" title="GenieACS · TR-069" subtitle="Cortes masivos de TV sobre los CPEs de fibra" />
        <div className="flex items-center gap-2">
          {mode && <Badge label={mode.live ? "MODO LIVE" : "DRY-RUN (simulación)"} tone={mode.live ? "error" : "info"} />}
          <Button variant="secondary" onClick={() => { setEditServer(null); setServerModal(true); }}>
            <Icon name="network" size={15} className="mr-1" />Servidores
          </Button>
          <Button variant="secondary" disabled={busy || noServer} onClick={installProvision} title="Instala en el ACS el provision+preset que sostienen el corte entre informs">
            <Icon name="wand-sparkles" size={15} className="mr-1" />Instalar provision
          </Button>
        </div>
      </div>

      {noServer ? (
        <div className="rounded-xl border border-border-subtle bg-surface p-8 text-center">
          <Icon name="network" size={28} className="mx-auto mb-2 text-text-tertiary" />
          <p className="text-text-secondary">No hay ningún servidor GenieACS configurado.</p>
          <Button className="mt-3" onClick={() => { setEditServer(null); setServerModal(true); }}>
            <Icon name="plus" size={15} className="mr-1" />Agregar servidor
          </Button>
        </div>
      ) : (
        <>
          {dash && (
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <Kpi label="CPEs totales" value={dash.total} />
              <Kpi label="Vivos (≤1 día)" value={dash.active} tone="text-success-text" />
              <Kpi label="Recientes (≤180 d)" value={dash.mid} tone="text-warning-text" />
              <Kpi label="Muertos (>180 d)" value={dash.stale} tone="text-error-text" />
              <Kpi label="TV suspendida" value={dash.suspended} tone="text-brand" />
            </div>
          )}

          {/* servidores */}
          <div className="mb-4 flex flex-wrap gap-2">
            {servers.map((s) => (
              <div key={s.id} className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-sm">
                <Icon name="network" size={14} className={s.online ? "text-success-text" : "text-text-tertiary"} />
                <span className="font-medium text-text-primary">{s.name}</span>
                {s.isDefault && <Icon name="flag" size={12} className="text-success-text" />}
                <span className="font-mono text-[11px] text-text-tertiary">{s.nbiUrl}</span>
                <button title="Probar NBI" onClick={() => test(s)} className="rounded p-1 text-text-tertiary hover:text-brand"><Icon name="zap" size={14} /></button>
                <button title="Editar" onClick={() => { setEditServer(s); setServerModal(true); }} className="rounded p-1 text-text-tertiary hover:text-brand"><Icon name="pencil" size={14} /></button>
              </div>
            ))}
          </div>

          {/* filtros + acciones masivas */}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPageNum(1); }}
              placeholder="Buscar por abonado (PPPoE), serial, modelo, IP…"
              className="max-w-xs"
            />
            <Select value={estado} onChange={(e) => { setEstado(e.target.value); setPageNum(1); }} className="max-w-[180px]">
              <option value="">Todos</option>
              <option value="vivos">Vivos (≤1 día)</option>
              <option value="muertos">Muertos (&gt;180 días)</option>
              <option value="suspendidos">TV suspendida</option>
            </Select>
            <div className="ml-auto flex items-center gap-2">
              {sel.size > 0 && <span className="text-sm text-text-secondary">{sel.size} seleccionados</span>}
              <Button variant="danger" disabled={busy || sel.size === 0} onClick={() => setConfirm({ enable: false })}>
                <Icon name="ban" size={15} className="mr-1" />Cortar TV
              </Button>
              <Button variant="secondary" disabled={busy || sel.size === 0} onClick={() => setConfirm({ enable: true })}>
                <Icon name="tv" size={15} className="mr-1" />Restaurar TV
              </Button>
            </div>
          </div>

          <DataTable
            rows={page?.items ?? []}
            empty={invLoading ? "Cargando…" : "Sin CPEs para el filtro."}
            columns={[
              {
                key: "sel",
                header: (
                  <input type="checkbox" checked={!!page?.items.length && page.items.every((r) => sel.has(r.id))} onChange={toggleAll} />
                ),
                render: (r: CpeRow) => (
                  <input type="checkbox" checked={sel.has(r.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.id)} />
                ),
              },
              { key: "pppUser", header: "Abonado (PPPoE)", render: (r: CpeRow) => (
                <span className="flex items-center gap-1.5">
                  {r.tvSuspended && <span title="TV suspendida"><Icon name="ban" size={13} className="text-error-text" /></span>}
                  <span className="font-medium text-text-primary">{r.pppUser || <span className="text-text-tertiary">—</span>}</span>
                </span>
              ) },
              { key: "model", header: "Marca / Modelo", render: (r: CpeRow) => <span className="text-text-secondary">{r.manufacturer || "?"} · {r.model || "?"}</span> },
              { key: "wanIp", header: "IP WAN", render: (r: CpeRow) => <span className="font-mono text-text-secondary">{r.wanIp || "—"}</span> },
              { key: "inform", header: "Último inform", render: (r: CpeRow) => <Badge label={informLabel(r.daysSince)} tone={informTone(r.daysSince)} /> },
              { key: "tv", header: "TV", align: "right", render: (r: CpeRow) => (
                <Badge label={r.tvSuspended ? "Suspendida" : "Activa"} tone={r.tvSuspended ? "error" : "success"} />
              ) },
            ]}
          />

          {page && page.pages > 1 && (
            <div className="mt-3 flex items-center justify-center gap-2">
              <Button variant="ghost" size="sm" disabled={pageNum <= 1} onClick={() => setPageNum((n) => n - 1)}>Anterior</Button>
              <span className="text-sm text-text-secondary">Página {page.page} de {page.pages} · {page.total.toLocaleString("es-CO")} CPEs</span>
              <Button variant="ghost" size="sm" disabled={pageNum >= page.pages} onClick={() => setPageNum((n) => n + 1)}>Siguiente</Button>
            </div>
          )}
        </>
      )}

      <GenieacsServerModal open={serverModal} onClose={() => setServerModal(false)} onSaved={loadTop} server={editServer} />

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.enable ? "Restaurar TV" : "Cortar TV"}
        message={
          confirm?.enable
            ? `Se restaurará la TV a ${sel.size} CPE(s) (quita el tag y reactiva la salida CATV).`
            : `Se cortará la TV a ${sel.size} CPE(s) (marca el tag y desactiva la salida CATV vía TR-069).`
        }
        confirmLabel={confirm?.enable ? "Restaurar" : "Cortar"}
        onConfirm={() => confirm && runTvBatch(confirm.enable)}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}
