"use client";

import { useCallback, useEffect, useState } from "react";
import { objetoJson } from "@/lib/errores";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";
import { BotonOrden, useTablaOrdenable } from "@/components/ui/tabla-ordenable";
import { SUB_STATUS_LABEL, SUB_STATUS_TONE, cop } from "@/lib/subscribers";
import type { MkMode } from "@/lib/mikrotik";

type Plan = { plan: string | null; price: number } | null;
type Row = { id: string; name: string; abonado: number; status: string | null; docNumber: string | null; phone?: string | null; branch?: string | null; balance?: number; debt?: number; internet?: Plan; tv?: Plan };
type BranchStat = { id: string; name: string; total: number; activos: number; cortados: number; cartera: number };

const ALL: BranchStat = { id: "", name: "Todas las sedes", total: 0, activos: 0, cortados: 0, cartera: 0 };

/**
 * Operaciones masivas (estilo Clientgroup del legacy). Flujo sede-primero:
 * se elige una sede en la grilla y luego se ven/seleccionan sus clientes para
 * corte / reconexión en lote + mensajería masiva por WhatsApp.
 */
export default function OperacionesMasivasPage() {
  const { loading: authLoading, authFetch } = useAuth();

  // Paso 1: sedes
  const [branches, setBranches] = useState<BranchStat[] | null>(null);
  const [branchesErr, setBranchesErr] = useState(false);
  const [sede, setSede] = useState<BranchStat | null>(null); // null = mostrando grilla de sedes

  // Paso 2: clientes de la sede
  const [status, setStatus] = useState("");
  const [servicio, setServicio] = useState("");
  const [cuenta, setCuenta] = useState("");
  const [deuda, setDeuda] = useState("");
  const [tecnologia, setTecnologia] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false); // operar sobre TODOS los que cumplen el filtro

  const [confirmCut, setConfirmCut] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  // Qué servicio operan Cortar/Reconectar: internet (Mikrotik/PPPoE) o TV
  // (TR-069 u OLT según el equipo de cada abonado, resuelto en el backend).
  const [servicioOp, setServicioOp] = useState<"internet" | "tv">("internet");
  // Gate dry-run/LIVE del Mikrotik: en dry-run no se toca el router, así que la
  // confirmación no exige teclear nada.
  const [mkMode, setMkMode] = useState<MkMode | null>(null);
  const live = !!mkMode?.live;
  const [waOpen, setWaOpen] = useState(false);
  const [waMsg, setWaMsg] = useState("Hola {nombre}, le recordamos que su servicio Vestel (abonado {abonado}) presenta saldo pendiente. Acérquese a pagar para evitar la suspensión. Gracias.");
  const [busy, setBusy] = useState(false);

  const loadBranches = useCallback(() => {
    setBranchesErr(false);
    void authFetch("/subscribers/branches-stats")
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then(setBranches)
      .catch(() => setBranchesErr(true));
  }, [authFetch]);
  useEffect(() => { if (!authLoading) loadBranches(); }, [authLoading, loadBranches]);

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/network/mikrotik/mode").then(objetoJson).then(setMkMode).catch(() => {});
  }, [authLoading, authFetch]);

  const load = useCallback(() => {
    if (!sede) return;
    setLoading(true);
    // Carga acotada: 100 filas como vista previa. Para operar sobre más, el banner
    // "seleccionar los N que cumplen el filtro" ejecuta el lote server-side sobre el
    // filtro completo (no depende de cuántas filas estén cargadas en pantalla).
    const qs = new URLSearchParams({ pageSize: "100", page: "1", withPlan: "1" });
    if (status) qs.set("status", status);
    if (sede.id) qs.set("branchId", sede.id);
    if (search) qs.set("search", search);
    if (servicio) qs.set("servicio", servicio);
    if (cuenta) qs.set("cuenta", cuenta);
    if (deuda) qs.set("deuda", deuda);
    if (tecnologia) qs.set("tecnologia", tecnologia);
    void authFetch(`/subscribers?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : { items: [], total: 0 }))
      .then((d) => { setRows(d.items ?? []); setTotal(d.total ?? 0); setSel(new Set()); setAllMatching(false); })
      .catch(() => { setRows([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [authFetch, sede, status, search, servicio, cuenta, deuda, tecnologia]);
  useEffect(() => { if (!authLoading && sede) load(); }, [authLoading, sede, load]);

  // Persistir la sede en la URL (?sede=<id|all>) para que al recargar se restaure.
  const setSedeParam = (val: string | null) => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    if (val) u.searchParams.set("sede", val); else u.searchParams.delete("sede");
    window.history.replaceState(null, "", u.toString());
  };

  // Al cargar las sedes, restaura la que venga en la URL (sobrevive al recargar).
  useEffect(() => {
    if (sede || !branches) return;
    const param = new URLSearchParams(window.location.search).get("sede");
    if (!param) return;
    if (param === "all") { setSede(ALL); return; }
    const b = branches.find((x) => x.id === param);
    if (b) setSede(b);
  }, [branches, sede]);

  function openSede(b: BranchStat) { setSede(b); setSedeParam(b.id || "all"); setStatus(""); setServicio(""); setCuenta(""); setDeuda(""); setTecnologia(""); setSearch(""); setSel(new Set()); setRows([]); }
  function backToSedes() { setSede(null); setSedeParam(null); loadBranches(); }

  // Ordena la vista cargada. La selección va por id, así que reordenar no
  // desmarca a nadie ni cambia a quién se le aplica la acción masiva.
  const t = useTablaOrdenable(rows, {
    abonado: (r) => r.abonado,
    cliente: (r) => r.name,
    internet: (r) => r.internet?.plan,
    tv: (r) => r.tv?.plan,
    telefono: (r) => r.phone,
    estado: (r) => r.status,
    debe: (r) => r.debt,
  });

  const allChecked = rows.length > 0 && sel.size === rows.length;
  const toggleAll = () => { setAllMatching(false); setSel(allChecked ? new Set() : new Set(rows.map((r) => r.id))); };
  const toggle = (id: string) => { setAllMatching(false); setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); };

  // Cantidad efectiva sobre la que se opera y el filtro (para el modo "todos los que cumplen").
  const count = allMatching ? total : sel.size;
  const filter = () => ({
    status: status || undefined, branchId: sede?.id || undefined, search: search || undefined,
    servicio: servicio || undefined, cuenta: cuenta || undefined, deuda: deuda || undefined, tecnologia: tecnologia || undefined,
  });

  async function runBatch(kind: "cut" | "reconnect") {
    setBusy(true);
    try {
      let res: Response;
      if (servicioOp === "tv") {
        // TV: el backend resuelve el equipo de cada abonado (TR-069 u OLT).
        const accion = kind === "cut" ? "tv-cut" : "tv-restore";
        res = allMatching
          ? await authFetch(`/subscribers/bulk/${accion}`, { method: "POST", body: JSON.stringify(filter()) })
          : await authFetch(`/network/genieacs/${accion}-subscribers`, { method: "POST", body: JSON.stringify({ ids: [...sel] }) });
      } else {
        res = allMatching
          ? await authFetch(`/subscribers/bulk/${kind}`, { method: "POST", body: JSON.stringify(filter()) })
          : await authFetch(`/network/${kind}-batch`, { method: "POST", body: JSON.stringify({ ids: [...sel] }) });
      }
      const d = await res.json();
      if (!res.ok) { toast(d?.message ?? "Error", "x"); return; }
      if (servicioOp === "tv") {
        const partes = [`${d.done ?? 0}/${d.total ?? count} OK`];
        if (d.failed) partes.push(`${d.failed} fallidos`);
        if (d.sinEquipo) partes.push(`${d.sinEquipo} sin equipo identificado`);
        if (d.compromisosProtegidos) partes.push(`${d.compromisosProtegidos} protegidos por compromiso`);
        toast(`${kind === "cut" ? "Corte de TV" : "Alta de TV"}: ${partes.join(" · ")}${d.dryRun ? " (dry-run)" : ""}`, d.failed ? "x" : "check");
      } else {
        const dry = d.results?.[0]?.dryRun;
        toast(`${kind === "cut" ? "Corte" : "Reconexión"}: ${d.ok}/${d.total} OK${dry ? " (dry-run)" : ""}`, "check");
      }
      load();
    } catch (e) { toast((e as Error).message, "x"); }
    finally { setBusy(false); setConfirmCut(false); }
  }

  async function restoreBranch() {
    if (!sede?.id) return;
    setBusy(true);
    try {
      const res = await authFetch(`/network/mikrotik/restore-branch/${sede.id}`, { method: "POST", body: JSON.stringify({}) });
      const d = await res.json();
      if (!res.ok) { toast(d?.message ?? "Error", "x"); return; }
      toast(`${d.dryRun ? "DRY-RUN: " : ""}Restaurados ${d.ok}/${d.total}${d.failed ? ` · ${d.failed} con error` : ""}`, "check");
    } catch (e) { toast((e as Error).message, "x"); }
    finally { setBusy(false); setConfirmRestore(false); }
  }

  async function sendWhatsapp() {
    setBusy(true);
    try {
      const res = allMatching
        ? await authFetch(`/subscribers/bulk/message`, { method: "POST", body: JSON.stringify({ ...filter(), message: waMsg }) })
        : await authFetch(`/network/message-batch`, { method: "POST", body: JSON.stringify({ ids: [...sel], message: waMsg }) });
      const d = await res.json();
      if (!res.ok) { toast(d?.message ?? "Error", "x"); return; }
      toast(`WhatsApp enviados: ${d.sent}/${d.total}`, "check");
      setWaOpen(false);
    } catch (e) { toast((e as Error).message, "x"); }
    finally { setBusy(false); }
  }

  // ── PASO 1: grilla de sedes ──────────────────────────────────────
  if (!sede) {
    return (
      <div className="space-y-4">
        <PageHeading icon="wifi-off" title="Operaciones masivas" subtitle="Elige una sede para cortar, reconectar o notificar a sus clientes en lote." />
        {branchesErr && !branches ? (
          <LoadError message="No se pudieron cargar las sedes." onRetry={loadBranches} />
        ) : !branches ? (
          <p className="text-[13px] text-text-tertiary">Cargando sedes…</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {branches.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => openSede(b)}
                  className="group flex flex-col gap-3 rounded-xl border border-border-subtle bg-surface p-4 text-left shadow-sm transition-colors hover:border-brand hover:bg-surface-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-[15px] font-semibold text-text-primary group-hover:text-brand">
                      <Icon name="map-pin" size={16} /> {b.name}
                    </span>
                    <Icon name="chevron-right" size={16} className="text-text-tertiary group-hover:text-brand" />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="default" label={`${b.total} clientes`} />
                    <Badge tone="success" label={`${b.activos} activos`} />
                    <Badge tone="error" label={`${b.cortados} cortados`} />
                    <Badge tone="warning" label={`${b.cartera} cartera`} />
                  </div>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => openSede(ALL)}
              className="text-[13px] font-medium text-brand hover:underline"
            >
              Ver todas las sedes juntas →
            </button>
          </>
        )}
      </div>
    );
  }

  // ── PASO 2: clientes de la sede ──────────────────────────────────
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="wifi-off" title={sede.name} subtitle="Corte, reconexión y mensajería en lote." />
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={busy || !sede.id} onClick={() => setConfirmRestore(true)}><Icon name="refresh-cw" size={14} /> Restaurar secrets</Button>
          <Button variant="secondary" size="sm" onClick={backToSedes}><Icon name="arrow-left" size={14} /> Sedes</Button>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border-subtle bg-surface p-3">
        <label className="text-[12px] text-text-secondary">
          <span className="mb-1 block">Estado del cliente</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-border-default bg-surface px-2 py-1.5 text-[13px]">
            <option value="">Todos</option>
            {Object.entries(SUB_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="text-[12px] text-text-secondary">
          <span className="mb-1 block">Servicio</span>
          <select value={servicio} onChange={(e) => setServicio(e.target.value)} className="rounded-lg border border-border-default bg-surface px-2 py-1.5 text-[13px]">
            <option value="">Todos</option>
            <option value="internet">Internet</option>
            <option value="tv">TV</option>
            <option value="combo">Combo (Internet + TV)</option>
          </select>
        </label>
        <label className="text-[12px] text-text-secondary">
          <span className="mb-1 block">Estado de cuenta</span>
          <select value={cuenta} onChange={(e) => setCuenta(e.target.value)} className="rounded-lg border border-border-default bg-surface px-2 py-1.5 text-[13px]">
            <option value="">Todas</option>
            <option value="aldia">Al día</option>
            <option value="debe">Debe</option>
            <option value="compromiso">Compromiso</option>
          </select>
        </label>
        <label className="text-[12px] text-text-secondary">
          <span className="mb-1 block">Deuda</span>
          <select value={deuda} onChange={(e) => setDeuda(e.target.value)} className="rounded-lg border border-border-default bg-surface px-2 py-1.5 text-[13px]">
            <option value="">Cualquiera</option>
            {/* Lo primero es lo que se mira para cortar: PLATA. Las dos de abajo
                cuentan documentos abiertos, que no es lo mismo (una factura del
                legacy puede traer varios meses, y un abono parcial deja la
                factura abierta debiendo cuatro pesos). */}
            <option value="fija">Debe su mensualidad o más</option>
            <option value="1">Tiene 1 factura sin pagar</option>
            <option value="gt2">Tiene más de 2 facturas sin pagar</option>
          </select>
        </label>
        <label className="text-[12px] text-text-secondary">
          <span className="mb-1 block">Tecnología</span>
          <select value={tecnologia} onChange={(e) => setTecnologia(e.target.value)} className="rounded-lg border border-border-default bg-surface px-2 py-1.5 text-[13px]">
            <option value="">Todas</option>
            <option value="FTTH">FTTH (Fibra)</option>
            <option value="EOC">EOC</option>
          </select>
        </label>
        <label className="flex-1 text-[12px] text-text-secondary">
          <span className="mb-1 block">Buscar</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nombre, documento, abonado…" className="w-full rounded-lg border border-border-default bg-surface px-3 py-1.5 text-[13px]" />
        </label>
      </div>

      {/* Barra de acciones */}
      <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-border-subtle bg-surface/95 p-3 backdrop-blur">
        <span className="text-[13px] text-text-secondary">
          <b className="text-text-primary">{count}</b> {allMatching ? "que cumplen el filtro" : "seleccionados"} · {total} en el filtro
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Qué se corta/reconecta: internet (Mikrotik) o TV (TR-069/OLT según el equipo). */}
          <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
            Servicio
            <select
              value={servicioOp}
              onChange={(e) => setServicioOp(e.target.value as "internet" | "tv")}
              className="rounded-lg border border-border-default bg-surface px-2 py-1.5 text-[13px] font-medium"
            >
              <option value="internet">Internet</option>
              <option value="tv">TV</option>
            </select>
          </label>
          <Button variant="danger" disabled={count === 0 || busy} onClick={() => setConfirmCut(true)}>
            <Icon name={servicioOp === "tv" ? "tv" : "wifi-off"} size={15} /> Cortar {servicioOp === "tv" ? "TV" : "Internet"}
          </Button>
          <Button variant="secondary" disabled={count === 0 || busy} onClick={() => runBatch("reconnect")}>
            <Icon name={servicioOp === "tv" ? "tv" : "wifi"} size={15} /> Reconectar {servicioOp === "tv" ? "TV" : "Internet"}
          </Button>
          <Button disabled={count === 0 || busy} onClick={() => setWaOpen(true)}>
            <Icon name="message-circle" size={15} /> WhatsApp
          </Button>
        </div>
      </div>

      {/* Banner: seleccionar TODOS los que cumplen el filtro (no solo la página cargada) */}
      {allMatching ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/40 bg-brand-soft/40 px-3 py-2 text-[13px]">
          <Icon name="check" size={15} className="text-brand" />
          <span>Se operará sobre los <b>{total}</b> clientes que cumplen el filtro.</span>
          <button type="button" onClick={() => { setAllMatching(false); setSel(new Set()); }} className="ml-1 font-medium text-brand hover:underline">Quitar selección</button>
        </div>
      ) : allChecked && total > rows.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-[13px]">
          <span>Seleccionaste los {rows.length} de esta vista.</span>
          <button type="button" onClick={() => setAllMatching(true)} className="font-semibold text-brand hover:underline">
            Seleccionar los {total} que cumplen el filtro →
          </button>
        </div>
      ) : null}

      {/* Tabla */}
      <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border-subtle text-left text-text-tertiary">
              <th className="w-10 py-2 pl-3"><input type="checkbox" checked={allChecked} onChange={toggleAll} /></th>
              <th className="py-2 pr-3 font-medium"><BotonOrden t={t} clave="abonado">Abonado</BotonOrden></th>
              <th className="py-2 pr-3 font-medium"><BotonOrden t={t} clave="cliente">Cliente</BotonOrden></th>
              <th className="py-2 pr-3 font-medium"><BotonOrden t={t} clave="internet">Internet</BotonOrden></th>
              <th className="py-2 pr-3 font-medium"><BotonOrden t={t} clave="tv">TV</BotonOrden></th>
              <th className="py-2 pr-3 font-medium"><BotonOrden t={t} clave="telefono">Teléfono</BotonOrden></th>
              <th className="py-2 pr-3 font-medium"><BotonOrden t={t} clave="estado">Estado</BotonOrden></th>
              <th className="py-2 pr-3 text-right font-medium"><BotonOrden t={t} clave="debe">Debe</BotonOrden></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="py-6 text-center text-text-tertiary">Cargando…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="py-6 text-center text-text-tertiary">Sin clientes para este filtro.</td></tr>
            ) : t.filas.map((r) => (
              <tr key={r.id} className={`border-b border-border-subtle/60 ${sel.has(r.id) ? "bg-brand-soft/40" : ""}`}>
                <td className="py-1.5 pl-3"><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
                <td className="py-1.5 pr-3 font-mono">{r.abonado}</td>
                <td className="py-1.5 pr-3">
                  <Link href={`/clientes/${r.id}`} className="block font-medium text-brand hover:underline">{r.name}</Link>
                  {r.docNumber && <span className="block text-[11px] text-text-tertiary">{r.docNumber}</span>}
                </td>
                <td className="py-1.5 pr-3">
                  {r.internet?.plan
                    ? <span className="flex flex-col"><span className="text-text-primary">{r.internet.plan}</span>{r.internet.price > 0 && <span className="text-[11px] text-text-tertiary">{cop(r.internet.price)}</span>}</span>
                    : <span className="text-text-tertiary">—</span>}
                </td>
                <td className="py-1.5 pr-3">
                  {r.tv?.plan
                    ? <span className="flex flex-col"><span className="text-text-primary">{r.tv.plan}</span>{r.tv.price > 0 && <span className="text-[11px] text-text-tertiary">{cop(r.tv.price)}</span>}</span>
                    : <span className="text-text-tertiary">—</span>}
                </td>
                <td className="py-1.5 pr-3 text-text-secondary">{r.phone ?? "—"}</td>
                <td className="py-1.5 pr-3"><Badge label={SUB_STATUS_LABEL[r.status ?? ""] ?? r.status ?? "—"} tone={SUB_STATUS_TONE[r.status ?? ""] ?? "default"} /></td>
                <td className="py-1.5 pr-3 text-right font-semibold">
                  <span className={(r.debt ?? 0) > 0 ? "text-error-text" : "text-text-tertiary"}>{cop(r.debt ?? 0)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > rows.length && <p className="text-[12px] text-text-tertiary">Mostrando los primeros {rows.length} de {total}. Afina el filtro (estado / búsqueda) para abarcar el resto.</p>}

      {/* Confirmar corte */}
      <Modal open={confirmCut} onClose={() => setConfirmCut(false)} title={servicioOp === "tv" ? "Confirmar corte de TV masivo" : "Confirmar corte masivo"}>
        <p className="text-[13px] text-text-secondary">
          {servicioOp === "tv"
            ? <>Se apagará la <b>señal de TV</b> de <b>{count}</b> clientes de <b>{sede.name}</b>. El sistema resuelve el equipo de cada uno (CPE TR-069 o puerto CATV en la OLT); los que no tengan equipo identificable quedan reportados sin tocar.</>
            : <>Se cortará el servicio de <b>{count}</b> clientes de <b>{sede.name}</b> en el Mikrotik.</>}
          {allMatching && count > 200 ? " Esta operación puede tardar varios minutos." : ""} ¿Continuar?
        </p>
        <div className="mt-4 flex gap-2">
          <Button variant="danger" disabled={busy} onClick={() => runBatch("cut")}>{busy ? "Cortando…" : servicioOp === "tv" ? "Sí, cortar TV" : "Sí, cortar"}</Button>
          <Button variant="ghost" onClick={() => setConfirmCut(false)}>Cancelar</Button>
        </div>
      </Modal>

      {/* Restaurar/sincronizar secrets de la sede */}
      <ConfirmDialog
        open={confirmRestore}
        busy={busy}
        onClose={() => setConfirmRestore(false)}
        onConfirm={() => void restoreBranch()}
        tone={live ? "danger" : "primary"}
        icon="refresh-cw"
        title="Restaurar secrets PPP de la sede"
        confirmLabel={busy ? "Restaurando…" : "Restaurar secrets"}
        // En LIVE se reescribe la configuración de TODOS los abonados de la
        // sede en el router: se exige teclear el nombre para que sea deliberado.
        requireText={live ? sede.name : undefined}
        requireHint={<>Escriba el nombre de la sede <span className="font-mono font-semibold text-text-primary">{sede.name}</span> para confirmar</>}
        message={
          <>
            Se recreará o actualizará en el Mikrotik el secret PPP de <b>cada abonado
            activo o cortado</b> de {sede.name}, respetando su estado actual.{" "}
            {live
              ? <b className="text-error-text">Se escribe en el router de producción y puede tardar varios minutos.</b>
              : <>Está en <b>dry-run</b>: se calcula el plan sin tocar el router.</>}
          </>
        }
      />

      {/* WhatsApp masivo */}
      <Modal open={waOpen} onClose={() => setWaOpen(false)} title={`WhatsApp a ${count} clientes`}>
        <p className="mb-2 text-[12px] text-text-tertiary">Variables: <code>{"{nombre}"}</code>, <code>{"{abonado}"}</code>.</p>
        <textarea value={waMsg} onChange={(e) => setWaMsg(e.target.value)} rows={5} className="w-full rounded-lg border border-border-default bg-surface p-2 text-[13px]" />
        <div className="mt-3 flex gap-2">
          <Button disabled={busy || !waMsg.trim()} onClick={sendWhatsapp}>{busy ? "Enviando…" : "Enviar"}</Button>
          <Button variant="ghost" onClick={() => setWaOpen(false)}>Cancelar</Button>
        </div>
      </Modal>
    </div>
  );
}
