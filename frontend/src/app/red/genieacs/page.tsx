"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/ui/PageHeading";
import { DataTable, type SortState } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { GenieacsServerModal } from "@/components/network/GenieacsServerModal";
import { CpeDetailModal } from "@/components/network/CpeDetailModal";
import { OltCatvModal } from "@/components/network/OltCatvModal";
import {
  ESTADO_OPTIONS, informExact, informLabel, informTone,
  type CpeRow, type GenieacsDashboard, type GenieacsMode, type GenieacsServer, type Paged, type TvBatchResult,
} from "@/lib/genieacs";

export default function GenieacsPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [mode, setMode] = useState<GenieacsMode | null>(null);
  const [dash, setDash] = useState<GenieacsDashboard | null>(null);
  const [servers, setServers] = useState<GenieacsServer[]>([]);
  const [loading, setLoading] = useState(true);

  // inventario
  const [page, setPage] = useState<Paged<CpeRow> | null>(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [estado, setEstado] = useState("vivos");
  const [manufacturer, setManufacturer] = useState("");
  const [model, setModel] = useState("");
  const [serverId, setServerId] = useState("");
  const [sort, setSort] = useState<SortState>({ by: "inform", dir: "desc" });
  const [pageNum, setPageNum] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [invLoading, setInvLoading] = useState(false);

  // Guarda la fila completa, no sólo el id: la selección sobrevive al cambio de
  // página/filtro y hay que poder listar a quién se le corta antes de confirmar.
  const [sel, setSel] = useState<Map<string, CpeRow>>(new Map());

  // modales / acciones
  const [serverModal, setServerModal] = useState(false);
  // null = cerrado; {} = abierto vacío; {sn, oltId} = abierto desde una fila OLT (auto-busca).
  const [oltCatv, setOltCatv] = useState<null | { sn?: string; oltId?: string }>(null);
  const [editServer, setEditServer] = useState<GenieacsServer | null>(null);
  const [detail, setDetail] = useState<CpeRow | null>(null);
  const [confirm, setConfirm] = useState<null | { enable: boolean }>(null);
  const [busy, setBusy] = useState(false);

  // La búsqueda pega contra el NBI y trae el parque entero: sin debounce, cada
  // tecla es un barrido completo del ACS.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

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
        // El dashboard ya no pinta KPIs, pero sigue siendo la fuente de las
        // opciones (con su conteo) de los filtros de marca y modelo.
        const qs = serverId ? `?serverId=${encodeURIComponent(serverId)}` : "";
        const d = await authFetch(`/network/genieacs/dashboard${qs}`).then((r) => r.json());
        setDash(d);
      } else {
        setDash(null);
      }
    } catch {
      toast("No se pudo cargar GenieACS", "x");
    } finally {
      setLoading(false);
    }
  }, [authFetch, serverId]);

  const loadInventory = useCallback(async () => {
    if (!servers.length) { setPage(null); return; }
    setInvLoading(true);
    try {
      const qs = new URLSearchParams({
        page: String(pageNum), pageSize: String(pageSize),
        sortBy: sort.by, sortDir: sort.dir,
      });
      if (estado) qs.set("estado", estado);
      if (debounced) qs.set("search", debounced);
      if (manufacturer) qs.set("manufacturer", manufacturer);
      if (model) qs.set("model", model);
      if (serverId) qs.set("serverId", serverId);
      const p = await authFetch(`/network/genieacs/inventory?${qs.toString()}`).then((r) => r.json());
      setPage(p);
    } catch {
      toast("No se pudo cargar el inventario", "x");
    } finally {
      setInvLoading(false);
    }
  }, [authFetch, servers.length, estado, pageNum, pageSize, debounced, manufacturer, model, serverId, sort]);

  useEffect(() => { if (!authLoading) void loadTop(); }, [authLoading, loadTop]);
  useEffect(() => { if (!authLoading) void loadInventory(); }, [authLoading, loadInventory]);

  // Cualquier cambio de filtro/orden/tamaño devuelve a la página 1.
  useEffect(() => {
    setPageNum(1);
  }, [debounced, estado, manufacturer, model, serverId, pageSize, sort]);

  const toggleSort = (by: string) =>
    setSort((s) => (s.by === by ? { by, dir: s.dir === "asc" ? "desc" : "asc" } : { by, dir: "asc" }));

  const toggle = (row: CpeRow) => setSel((prev) => {
    const n = new Map(prev);
    n.has(row.id) ? n.delete(row.id) : n.set(row.id, row);
    return n;
  });
  const toggleAll = () => setSel((prev) => {
    if (!page) return prev;
    const allSel = page.items.every((r) => prev.has(r.id));
    const n = new Map(prev);
    for (const r of page.items) allSel ? n.delete(r.id) : n.set(r.id, r);
    return n;
  });

  const filtros = [estado, manufacturer, model, debounced].filter(Boolean).length;
  const limpiarFiltros = () => { setSearch(""); setEstado(""); setManufacturer(""); setModel(""); };

  // Cuántos seleccionados no se ven en la página actual: el corte los incluye igual.
  const offPage = useMemo(() => {
    if (!page) return sel.size;
    const visibles = new Set(page.items.map((r) => r.id));
    return Array.from(sel.keys()).filter((id) => !visibles.has(id)).length;
  }, [sel, page]);

  const runTvBatch = async (enable: boolean) => {
    setBusy(true);
    try {
      const ids = Array.from(sel.keys());
      const endpoint = enable ? "/network/genieacs/restore-tv" : "/network/genieacs/cut-tv";
      const r: TvBatchResult = await authFetch(endpoint, { method: "POST", body: JSON.stringify({ ids, serverId: serverId || undefined }) }).then((x) => x.json());
      if (r.dryRun) {
        toast(`DRY-RUN: ${enable ? "alta" : "corte"} de TV planificado para ${r.plan?.devices ?? ids.length} CPEs (no se tocó el ACS)`, "check");
      } else if (r.ok) {
        toast(`${enable ? "Alta" : "Corte"} de TV: ${r.done ?? 0} OK, ${r.failed ?? 0} fallidos`, "check");
      } else {
        toast(`${enable ? "Alta" : "Corte"} con errores: ${r.failed ?? 0} fallidos`, "x");
      }
      setSel(new Map());
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
      const r = await authFetch("/network/genieacs/install-provision", { method: "POST", body: JSON.stringify({ serverId: serverId || undefined }) }).then((x) => x.json());
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
  const defaultServer = servers.find((s) => s.isDefault) ?? servers[0] ?? null;

  return (
    <>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="tv" title="GenieACS · TR-069" subtitle="Cortes masivos de TV sobre los CPEs de fibra" />
        <div className="flex items-center gap-2">
          {mode && <Badge label={mode.live ? "MODO LIVE" : "DRY-RUN (simulación)"} tone={mode.live ? "error" : "info"} />}
          {defaultServer && (
            <span title={defaultServer.hasAuth ? "El NBI está protegido con basic-auth" : "El NBI no tiene autenticación configurada — asegúralo antes de activar LIVE"}>
              <Badge
                label={defaultServer.hasAuth ? "NBI autenticado" : "NBI sin auth"}
                tone={defaultServer.hasAuth ? "success" : "warning"}
              />
            </span>
          )}
          {/* Única vía de acceso a la config del ACS: abre el servidor por defecto
              para editarlo, o el alta si todavía no hay ninguno. */}
          <Button
            variant="secondary"
            title={defaultServer ? `Editar ${defaultServer.name}` : "Agregar un servidor GenieACS"}
            onClick={() => { setEditServer(defaultServer); setServerModal(true); }}
          >
            <Icon name="network" size={15} className="mr-1" />Servidor
          </Button>
          <Button variant="secondary" disabled={busy || noServer} onClick={installProvision} title="Instala en el ACS el provision+preset que sostienen el corte entre informs">
            <Icon name="wand-sparkles" size={15} className="mr-1" />Instalar provision
          </Button>
          {/* Las ONTs combo sin TR-069 no aparecen en el inventario del ACS:
              su corte de TV va por la OLT (puerto CATV, OMCI). */}
          <Button variant="secondary" onClick={() => setOltCatv({})} title="Cortar/activar la TV de ONTs sin TR-069 (la palanca es el puerto CATV en la OLT)">
            <Icon name="zap" size={15} className="mr-1" />Corte por OLT
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
          {/* filtros */}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="relative max-w-xs flex-1">
              <Icon name="search" size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Abonado, serial, modelo, IP…"
                className="pl-9"
              />
              {search && (
                <button onClick={() => setSearch("")} title="Limpiar búsqueda" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-tertiary hover:text-text-primary">
                  <Icon name="x" size={13} />
                </button>
              )}
            </div>

            <Select value={estado} onChange={(e) => setEstado(e.target.value)} className="max-w-[190px]">
              {ESTADO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>

            {!!dash?.byManufacturer.length && (
              <Select value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} className="max-w-[170px]">
                <option value="">Todas las marcas</option>
                {dash.byManufacturer.map((m) => <option key={m.name} value={m.name}>{m.name} ({m.count})</option>)}
              </Select>
            )}

            {!!dash?.byModel.length && (
              <Select value={model} onChange={(e) => setModel(e.target.value)} className="max-w-[190px]">
                <option value="">Todos los modelos</option>
                {dash.byModel.map((m) => <option key={m.name} value={m.name}>{m.name} ({m.count})</option>)}
              </Select>
            )}

            {servers.length > 1 && (
              <Select value={serverId} onChange={(e) => setServerId(e.target.value)} className="max-w-[170px]">
                <option value="">Servidor por defecto</option>
                {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}

            {filtros > 0 && (
              <Button variant="ghost" size="sm" onClick={limpiarFiltros} title="Quitar todos los filtros">
                <Icon name="x" size={14} className="mr-1" />Limpiar
              </Button>
            )}

            {page && (
              <span className="ml-auto text-[12px] text-text-tertiary">
                {invLoading ? "Cargando…" : <>{page.total.toLocaleString("es-CO")} CPEs</>}
              </span>
            )}
          </div>

          {/* barra de selección — pegajosa: la acción es destructiva y la selección
              cruza páginas y filtros, así que nunca debe quedar fuera de vista. */}
          {sel.size > 0 && (
            <div className="sticky top-2 z-20 mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-brand bg-brand-soft px-3 py-2">
              <Icon name="list-checks" size={15} className="text-brand" />
              <span className="text-[13px] font-semibold text-text-primary">
                {sel.size.toLocaleString("es-CO")} seleccionados
              </span>
              {offPage > 0 && (
                <span className="text-[12px] text-text-secondary">
                  ({offPage.toLocaleString("es-CO")} fuera de esta página)
                </span>
              )}
              <button onClick={() => setSel(new Map())} className="text-[12px] font-semibold text-brand underline underline-offset-2 hover:opacity-80">
                Limpiar selección
              </button>
              <div className="ml-auto flex items-center gap-2">
                <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirm({ enable: false })}>
                  <Icon name="ban" size={15} className="mr-1" />Cortar TV
                </Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirm({ enable: true })}>
                  <Icon name="tv" size={15} className="mr-1" />Restaurar TV
                </Button>
              </div>
            </div>
          )}

          <DataTable
            rows={page?.items ?? []}
            empty={invLoading ? "Cargando…" : "Sin CPEs para el filtro."}
            onRowClick={(r: CpeRow) => (r.source === "olt" ? setOltCatv({ sn: r.serial ?? undefined, oltId: r.oltId }) : setDetail(r))}
            sort={sort}
            onSort={toggleSort}
            columns={[
              {
                key: "sel",
                header: (
                  <input
                    type="checkbox"
                    aria-label="Seleccionar toda la página"
                    checked={!!page?.items.length && page.items.every((r) => sel.has(r.id))}
                    onChange={toggleAll}
                  />
                ),
                render: (r: CpeRow) => (
                  // Las ONUs sin TR-069 no entran al corte masivo del ACS: su TV va por la OLT.
                  <input type="checkbox" aria-label={`Seleccionar ${r.pppUser || r.id}`} checked={sel.has(r.id)} disabled={r.source === "olt"} onClick={(e) => e.stopPropagation()} onChange={() => toggle(r)} />
                ),
              },
              { key: "pppUser", header: "Abonado (PPPoE)", sortable: true, render: (r: CpeRow) => (
                <span className="flex items-center gap-1.5">
                  {r.tvSuspended && <span title="TV suspendida"><Icon name="ban" size={13} className="text-error-text" /></span>}
                  <span className="font-medium text-text-primary">{r.pppUser || <span className="text-text-tertiary">—</span>}</span>
                </span>
              ) },
              { key: "model", header: "Marca / Modelo", sortable: true, render: (r: CpeRow) => (
                r.source === "olt"
                  ? <span className="text-text-secondary">Sin TR-069 · OLT {r.oltName || "?"}{r.fsp ? ` (${r.fsp})` : ""}</span>
                  : <span className="text-text-secondary">{r.manufacturer || "?"} · {r.model || "?"}</span>
              ) },
              { key: "serial", header: "Serial", sortable: true, render: (r: CpeRow) => <span className="font-mono text-[12px] text-text-secondary">{r.serial || "—"}</span> },
              { key: "wanIp", header: "IP WAN", sortable: true, render: (r: CpeRow) => <span className="font-mono text-text-secondary">{r.wanIp || "—"}</span> },
              { key: "inform", header: "Último inform", sortable: true, render: (r: CpeRow) => (
                r.source === "olt"
                  ? <Badge label={r.runState || "sin sync"} tone={r.alive ? "success" : "default"} />
                  : <span title={informExact(r.lastInform)}><Badge label={informLabel(r.daysSince)} tone={informTone(r.daysSince)} /></span>
              ) },
              { key: "tv", header: "TV", align: "right", sortable: true, render: (r: CpeRow) => (
                r.source === "olt"
                  ? <span title="El estado real de la TV se lee de la OLT al abrir la fila"><Badge label="Corte por OLT" tone="info" /></span>
                  : <Badge label={r.tvSuspended ? "Suspendida" : "Activa"} tone={r.tvSuspended ? "error" : "success"} />
              ) },
            ]}
          />

          {page && page.total > 0 && (
            <div className="mt-3">
              <Pagination
                meta={{ page: page.page, pageSize: page.pageSize, total: page.total, pageCount: page.pages }}
                onPage={setPageNum}
                onPageSize={setPageSize}
              />
            </div>
          )}
        </>
      )}

      <GenieacsServerModal open={serverModal} onClose={() => setServerModal(false)} onSaved={loadTop} server={editServer} />

      <OltCatvModal open={!!oltCatv} onClose={() => setOltCatv(null)} initialSn={oltCatv?.sn} initialOltId={oltCatv?.oltId} />

      <CpeDetailModal cpe={detail} onClose={() => setDetail(null)} onChanged={() => { void loadTop(); void loadInventory(); }} />

      <ConfirmDialog
        open={!!confirm}
        busy={busy}
        title={confirm?.enable ? "Restaurar TV" : "Cortar TV"}
        tone={confirm?.enable ? "primary" : "danger"}
        message={
          <div className="flex flex-col gap-2">
            <p>
              {confirm?.enable
                ? `Se restaurará la TV a ${sel.size} CPE(s) (quita el tag y reactiva la salida CATV).`
                : `Se cortará la TV a ${sel.size} CPE(s) (marca el tag y desactiva la salida CATV vía TR-069).`}
            </p>
            {offPage > 0 && (
              <p className="font-semibold text-error-text">
                Ojo: {offPage} de los seleccionados no están visibles en la página actual y también se verán afectados.
              </p>
            )}
            <div className="max-h-40 overflow-y-auto rounded-lg border border-border-subtle bg-surface-2/40 p-2">
              {Array.from(sel.values()).map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 border-b border-border-subtle py-1 text-[12px] last:border-0">
                  <span className="min-w-0 truncate font-medium text-text-primary">{r.pppUser || r.id}</span>
                  <span className="shrink-0 text-text-tertiary">{r.model || "?"}</span>
                </div>
              ))}
            </div>
            {mode && !mode.live && (
              <p className="text-text-tertiary">El ACS está en DRY-RUN: se devolverá el plan sin aplicar cambios.</p>
            )}
          </div>
        }
        confirmLabel={confirm?.enable ? "Restaurar" : "Cortar"}
        onConfirm={() => confirm && runTvBatch(confirm.enable)}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}
