"use client";

import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/ui/PageHeading";
import { DataTable, type SortState } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { AutenticarOnuModal } from "@/components/network/AutenticarOnuModal";
import { PERM } from "@/lib/auth";
import { rxTone, runTone } from "@/lib/olt";
import type { OltRow, OltMode, Board, LiveOnu, AutofindOnu, SystemInfo, OltLog } from "@/lib/olt";

type Tab = "resumen" | "tableros" | "onus" | "autofind" | "buscar" | "sync" | "historial";
const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "resumen", label: "Resumen", icon: "router" },
  { key: "tableros", label: "Tableros", icon: "layers" },
  { key: "onus", label: "ONUs por puerto", icon: "network" },
  { key: "autofind", label: "Autofind", icon: "wand-sparkles" },
  { key: "buscar", label: "Buscar SN", icon: "search" },
  { key: "sync", label: "Sincronizar", icon: "refresh-cw" },
  { key: "historial", label: "Historial", icon: "clock" },
];

const SSH_MSG = "Consultando la OLT por SSH…";

/** Lecturas ópticas en vivo de una ONU (el comando lento; llega en 2.º plano). */
type OpticaOnu = { rx?: string; tx?: string; olt_rx?: string; temp?: string; voltage?: string; distance?: string };

/** Último puerto visitado por OLT: se retoma al volver sin tener que buscarlo. */
const lsPuerto = (oltId: string) => `olt-ultimo-puerto:${oltId}`;

/**
 * Aviso de carga que ocupa el lugar de los datos mientras no hay nada que
 * mostrar todavía. Va en la zona de resultados, no en la cabecera.
 */
function CargandoBloque({ text = SSH_MSG }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border-subtle bg-surface p-10 text-[13px] text-text-tertiary">
      <Icon name="loader" size={15} className="animate-spin" />{text}
    </div>
  );
}

/** Variante para refrescos: los datos ya están en pantalla y no deben saltar. */
function CargandoChip({ text = SSH_MSG }: { text?: string }) {
  return (
    <div className="mt-2 flex items-center justify-center gap-2 text-[12px] text-text-tertiary">
      <Icon name="loader" size={14} className="animate-spin" />{text}
    </div>
  );
}

function parseFsp(fsp: string): { frame: number; slot: number; port: number } {
  const [f, s, p] = (fsp || "0/0/0").split("/").map((x) => Number(x) || 0);
  return { frame: f, slot: s, port: p };
}

function OperarOltVista() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch, can } = useAuth();
  // El historial de acciones (quién autenticó/borró qué) es solo para
  // administración y superadmin; el resto ni ve la pestaña.
  const puedeHistorial = can(PERM.AREA_ADMINISTRACION);
  const router = useRouter();
  const pathname = usePathname();
  const qs = useSearchParams();

  /**
   * El estado de navegación vive en la URL, no en useState: al recargar (o al
   * compartir el enlace) se vuelve al mismo sitio en vez de saltar al resumen.
   */
  const setQs = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(qs.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  }, [qs, router, pathname]);

  const tab: Tab = useMemo(() => {
    const t = qs.get("tab");
    if (t === "historial" && !puedeHistorial) return "resumen";
    return (TABS.find((x) => x.key === t)?.key ?? "resumen") as Tab;
  }, [qs, puedeHistorial]);
  const setTab = useCallback((t: Tab) => setQs({ tab: t === "resumen" ? null : t }), [setQs]);

  const [olt, setOlt] = useState<OltRow | null>(null);
  const [mode, setMode] = useState<OltMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");

  // Datos por pestaña
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [onus, setOnus] = useState<LiveOnu[] | null>(null);
  const [onuForm, setOnuForm] = useState({
    frame: qs.get("frame") ?? "0",
    slot: qs.get("slot") ?? "",
    port: qs.get("port") ?? "",
  });
  const [autofind, setAutofind] = useState<AutofindOnu[] | null>(null);
  const [snQuery, setSnQuery] = useState(qs.get("sn") ?? "");
  const [snResult, setSnResult] = useState<Record<string, unknown> | null>(null);
  const [syncSlot, setSyncSlot] = useState(qs.get("syncSlot") ?? "");
  const [syncMsg, setSyncMsg] = useState("");
  const [history, setHistory] = useState<OltLog[]>([]);

  // Búsqueda rápida dentro del puerto listado.
  const [buscarOnu, setBuscarOnu] = useState("");
  // Filtro por estado (chips del resumen del puerto) y orden por columna.
  const [filtroEstado, setFiltroEstado] = useState<"" | "online" | "offline" | "senal">("");
  const [orden, setOrden] = useState<SortState | undefined>(undefined);
  // Ficha de una ONU: al hacer clic en la lista se abre como vista propia
  // (reemplaza la tabla) con botón para volver; `ficha` trae los datos leídos.
  const [onuVista, setOnuVista] = useState<LiveOnu | null>(null);
  const [ficha, setFicha] = useState<Record<string, unknown> | null>(null);
  // Óptica de la ficha abierta, aparte del detalle: alimenta las escalas de señal.
  const [optica, setOptica] = useState<OpticaOnu | "cargando" | null>(null);

  // Modal autenticar
  const [authModal, setAuthModal] = useState<{ sn?: string; frame?: string; slot?: string; port?: string; model?: string } | null>(null);
  // Confirmación de acción destructiva sobre una ONU.
  const [confirmar, setConfirmar] = useState<{ action: "reboot" | "delete"; onu: LiveOnu } | null>(null);
  // Editor del comentario (desc) de la ONU abierta: null = cerrado.
  const [editDesc, setEditDesc] = useState<string | null>(null);

  const live = !!mode?.live;

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/network/olt/mode").then((r) => r.json()).then(setMode).catch(() => {});
    void authFetch("/network/olt/olts").then((r) => r.json()).then((list: OltRow[]) => setOlt(list.find((o) => o.id === id) ?? null)).catch(() => {});
  }, [authLoading, authFetch, id]);

  // Cargar automáticamente lecturas ligeras al abrir su pestaña. La primera
  // carga acepta la caché del backend (respuesta inmediata); el botón
  // "Refrescar" pasa refresh=1 para leer del equipo de verdad.
  const loadSystem = useCallback(async (refresh = false) => {
    setBusy(true); setErr("");
    try { const r = await authFetch(`/network/olt/${id}/system${refresh ? "?refresh=1" : ""}`).then((x) => x.json()); setSys(r.info ?? null); if (!r.ok) setErr(r.error || "Sin respuesta del equipo."); }
    finally { setBusy(false); }
  }, [authFetch, id]);

  const loadBoards = useCallback(async (refresh = false) => {
    setBusy(true); setErr("");
    try { const r = await authFetch(`/network/olt/${id}/boards${refresh ? "?refresh=1" : ""}`).then((x) => x.json()); setBoards(r.boards ?? []); if (!r.ok) setErr(r.error || "Sin respuesta del equipo."); }
    finally { setBusy(false); }
  }, [authFetch, id]);

  const loadAutofind = useCallback(async () => {
    setBusy(true); setErr("");
    try { const r = await authFetch(`/network/olt/${id}/autofind`).then((x) => x.json()); setAutofind(r.onus ?? []); if (!r.ok) setErr(r.error || "Sin respuesta del equipo."); }
    finally { setBusy(false); }
  }, [authFetch, id]);

  const loadHistory = useCallback(async () => {
    setBusy(true);
    try {
      const r = await authFetch(`/network/olt/history?oltId=${id}&limit=100`).then((x) => x.json());
      setHistory(Array.isArray(r) ? r : []);
    } finally { setBusy(false); }
  }, [authFetch, id]);

  useEffect(() => {
    if (!olt) return;
    if (tab === "resumen" && sys === null) void loadSystem();
    if (tab === "tableros" && boards === null) void loadBoards();
    if (tab === "autofind" && autofind === null) void loadAutofind();
    if (tab === "historial") void loadHistory();
    // Si la URL ya trae slot/puerto, se relista solo: recargar en la pestaña de
    // ONUs debe devolver la misma lista, no un formulario vacío. Sin URL, se
    // retoma el último puerto visitado en esta OLT.
    if (tab === "onus" && onus === null) {
      if (onuForm.slot !== "" && onuForm.port !== "") {
        void listOnus(onuForm.frame, onuForm.slot, onuForm.port);
      } else {
        try {
          const saved = JSON.parse(localStorage.getItem(lsPuerto(id)) ?? "null");
          if (saved && saved.slot !== undefined && saved.port !== undefined) {
            void listOnus(String(saved.frame ?? "0"), String(saved.slot), String(saved.port));
          }
        } catch { /* preferencia corrupta: se ignora */ }
      }
    }
    if (tab === "buscar" && snResult === null && snQuery.trim() !== "") void buscarSn();
  }, [tab, olt]); // eslint-disable-line react-hooks/exhaustive-deps

  const listOnus = async (frame: string, slot: string, port: string) => {
    if (slot === "" || port === "") { toast("Indique slot y puerto", "x"); return; }
    // Cambiar de puerto vacía la lista (los datos viejos serían de OTRO puerto)
    // y cierra la ficha abierta; refrescar el mismo puerto conserva ambas.
    if (slot !== onuForm.slot || port !== onuForm.port) {
      setOnus(null); setBuscarOnu(""); setFiltroEstado(""); setOrden(undefined);
      setOnuVista(null); setFicha(null); setOptica(null); fichaSeq.current++;
    }
    setOnuForm({ frame, slot, port });
    setQs({ frame: frame === "0" ? null : frame, slot, port });
    try { localStorage.setItem(lsPuerto(id), JSON.stringify({ frame, slot, port })); } catch { /* sin storage */ }
    setBusy(true); setErr("");
    try {
      const r = await authFetch(`/network/olt/${id}/onus`, { method: "POST", body: JSON.stringify({ frame: Number(frame) || 0, slot, port }) }).then((x) => x.json());
      setOnus(r.onus ?? []);
      if (!r.ok) setErr(r.error || "Sin respuesta del equipo.");
      // Si la URL traía una ONU abierta (?onu=), se reabre su ficha al recargar.
      const pend = pendienteOnu.current;
      if (pend !== null) {
        pendienteOnu.current = null;
        const row = (r.onus ?? []).find((x: LiveOnu) => String(x.ont_id) === pend);
        if (row) void detalle(row);
      }
    } finally { setBusy(false); }
  };

  /** Salta al puerto vecino (los tableros GPON de Huawei van del 0 al 15). */
  const cambiarPuerto = (delta: number) => {
    const p = Number(onuForm.port);
    if (onuForm.slot === "" || onuForm.port === "" || !Number.isFinite(p)) return;
    const np = Math.min(15, Math.max(0, p + delta));
    if (np !== p) void listOnus(onuForm.frame, onuForm.slot, String(np));
  };

  // Resumen del puerto listado: totales por estado y señal. Alimenta los chips
  // (que a la vez filtran) y el mensaje de vacío.
  const statsPuerto = useMemo(() => {
    const rows = onus ?? [];
    let online = 0, offline = 0, senal = 0;
    for (const o of rows) {
      const t = runTone(o.run_state);
      if (t === "success") online++;
      else if (t === "error") offline++;
      const s = rxTone(o.rx_power);
      if (s === "warning" || s === "error") senal++;
    }
    return { total: rows.length, online, offline, senal };
  }, [onus]);

  const onusFiltradas = useMemo(() => {
    let rows = onus ?? [];
    if (filtroEstado === "online") rows = rows.filter((o) => runTone(o.run_state) === "success");
    if (filtroEstado === "offline") rows = rows.filter((o) => runTone(o.run_state) === "error");
    if (filtroEstado === "senal") rows = rows.filter((o) => ["warning", "error"].includes(rxTone(o.rx_power)));
    const q = buscarOnu.trim().toLowerCase();
    if (q) rows = rows.filter((o) =>
      o.sn.toLowerCase().includes(q) || String(o.ont_id) === q || `${o.fsp}:${o.ont_id}`.includes(q) ||
      (o.client ?? "").toLowerCase().includes(q) || (o.description ?? "").toLowerCase().includes(q));
    if (orden) {
      const val = (o: LiveOnu): string | number => {
        switch (orden.by) {
          case "ont": return Number(o.ont_id) || 0;
          // "￿" manda las ONUs sin abonado al final del orden ascendente.
          case "abonado": return (o.client || "￿").toLowerCase();
          case "run": return o.run_state || "";
          case "rx": { const n = parseFloat(o.rx_power); return Number.isFinite(n) ? n : 999; }
          default: return 0;
        }
      };
      const dir = orden.dir === "desc" ? -1 : 1;
      rows = [...rows].sort((a, b) => { const x = val(a), y = val(b); return x < y ? -dir : x > y ? dir : 0; });
    }
    return rows;
  }, [onus, buscarOnu, filtroEstado, orden]);

  /** Clic en un encabezado ordenable: asc → desc → sin orden. */
  const toggleOrden = useCallback((by: string) => {
    setOrden((s) => (!s || s.by !== by) ? { by, dir: "asc" } : s.dir === "asc" ? { by, dir: "desc" } : undefined);
  }, []);

  // Óptica ya leída (o vacío mientras carga / si no hubo lectura).
  const opticaObj: OpticaOnu = typeof optica === "object" && optica !== null ? optica : {};
  // Distancia según la ficha (display ont info): respaldo cuando la lectura óptica no la trae.
  const fichaDistancia = ficha && typeof ficha.distance === "string" ? ficha.distance : "";

  const onuAction = async (action: "reboot" | "delete", o: LiveOnu) => {
    const { frame, slot, port } = parseFsp(o.fsp);
    setBusy(true);
    try {
      const r = await authFetch(`/network/olt/${id}/onu/${action}`, {
        method: "POST", body: JSON.stringify({ frame, slot, port, ont_id: o.ont_id, sn: o.sn }),
      }).then((x) => x.json());
      if (r.ok) toast(r.dryRun ? `Plan generado (dry-run): ${(r.commands || []).join(" · ")}` : (r.message || "OK"), "check");
      else toast(r.error || "Error", "x");
      if (r.ok && action === "delete") {
        setOnus((prev) => (prev ?? []).filter((x) => x.ont_id !== o.ont_id));
        // Si la ONU borrada era la de la ficha abierta, se vuelve a la lista.
        if (onuVista && onuVista.ont_id === o.ont_id) cerrarFicha();
      }
    } finally { setBusy(false); setConfirmar(null); }
  };

  // Vigencia de la ficha abierta: si se abre otro detalle (u otra búsqueda por
  // SN) antes de que llegue la óptica en segundo plano, esa óptica se descarta
  // para no pintarla en la ONU equivocada.
  const fichaSeq = useRef(0);
  // ONU abierta según la URL (?onu=): se reabre sola cuando la lista termina de
  // cargar, para que recargar (o compartir el enlace) vuelva a la misma ficha.
  const pendienteOnu = useRef<string | null>(qs.get("onu"));

  /** Abre la vista de ficha de una ONU (reemplaza la lista; "Volver" la cierra). */
  const detalle = async (o: LiveOnu) => {
    setOnuVista(o);
    setFicha(null);
    setEditDesc(null);
    setOptica("cargando");
    setQs({ onu: String(o.ont_id) });
    const { frame, slot, port } = parseFsp(o.fsp);
    const body = JSON.stringify({ frame, slot, port, ont_id: o.ont_id });
    const seq = ++fichaSeq.current;
    setBusy(true);
    try {
      // El detalle básico es UN comando (rápido con la sesión reutilizada) y se
      // muestra ya; la óptica es el comando lento y llega en segundo plano.
      const r = await authFetch(`/network/olt/${id}/onu/detail`, { method: "POST", body }).then((x) => x.json());
      if (fichaSeq.current !== seq) return;
      setFicha(r.ok ? (r.detail ?? {}) : { error: r.error });
      if (!r.ok) { setOptica(null); return; }
      void authFetch(`/network/olt/${id}/onu/optical`, { method: "POST", body })
        .then((x) => x.json())
        .then((or) => {
          // Solo se pinta si la ficha sigue abierta y es la misma consulta.
          if (fichaSeq.current !== seq) return;
          setOptica((or?.ok ? or.optical : null) ?? {});
        })
        .catch(() => { if (fichaSeq.current === seq) setOptica({}); });
    } finally { setBusy(false); }
  };

  /** Cierra la ficha y vuelve a la lista del puerto (sin volver a consultar). */
  const cerrarFicha = () => {
    fichaSeq.current++; // descarta ópticas pendientes
    setOnuVista(null);
    setFicha(null);
    setOptica(null);
    setEditDesc(null);
    setQs({ onu: null });
  };

  /** Graba el comentario (desc) de la ONU abierta en la OLT y en el inventario. */
  const guardarDesc = async () => {
    if (!onuVista || editDesc === null) return;
    const { frame, slot, port } = parseFsp(onuVista.fsp);
    const desc = editDesc.trim();
    setBusy(true);
    try {
      const r = await authFetch(`/network/olt/${id}/onu/desc`, {
        method: "POST",
        body: JSON.stringify({ frame, slot, port, ont_id: onuVista.ont_id, sn: onuVista.sn, desc }),
      }).then((x) => x.json());
      if (!r.ok) { toast(r.error || "Error", "x"); return; }
      if (r.dryRun) { toast(`Plan generado (dry-run): ${(r.commands || []).join(" · ")}`, "check"); return; }
      toast(r.message || "Comentario guardado", "check");
      setOnuVista((prev) => (prev ? { ...prev, description: desc || null } : prev));
      setOnus((prev) => (prev ?? []).map((x) => (x.ont_id === onuVista.ont_id ? { ...x, description: desc || null } : x)));
      setEditDesc(null);
    } finally { setBusy(false); }
  };

  const buscarSn = async () => {
    if (!snQuery.trim()) return;
    fichaSeq.current++; // invalida ópticas pendientes de un detalle anterior
    setQs({ sn: snQuery.trim() });
    setBusy(true); setSnResult(null);
    try {
      const r = await authFetch(`/network/olt/${id}/onu/find`, { method: "POST", body: JSON.stringify({ sn: snQuery.trim() }) }).then((x) => x.json());
      setSnResult(r.ok ? (r.onu ?? {}) : { error: r.error });
    } finally { setBusy(false); }
  };

  const doSync = async () => {
    if (syncSlot === "") { toast("Indique el slot", "x"); return; }
    setQs({ syncSlot });
    setBusy(true); setSyncMsg("");
    try {
      const r = await authFetch(`/network/olt/${id}/sync`, { method: "POST", body: JSON.stringify({ frame: 0, slot: syncSlot }) }).then((x) => x.json());
      if (r.ok) { setSyncMsg(`Sincronizadas ${r.synced} ONUs del slot ${syncSlot} al inventario.`); toast(`Sync OK: ${r.synced} ONUs`, "check"); }
      else { setSyncMsg(r.error || "Error de sincronización."); toast(r.error || "Error", "x"); }
    } finally { setBusy(false); }
  };

  if (authLoading || !olt) return <PageSkeleton />;

  return (
    <>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <PageHeading icon="radio-tower" title={`OLT ${olt.name}`} />
        <div className="flex items-center gap-2 text-[12px] text-text-tertiary">
          <span className="font-mono">{olt.brand} · {olt.ip}:{olt.port}</span>
          {mode && <Badge label={live ? "MODO LIVE" : "DRY-RUN"} tone={live ? "error" : "info"} />}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-1 border-b border-border-subtle">
        {TABS.filter((t) => t.key !== "historial" || puedeHistorial).map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 rounded-t-md px-3 py-2 text-[13px] font-medium ${tab === t.key ? "border-b-2 border-brand text-brand" : "text-text-tertiary hover:text-text-secondary"}`}>
            <Icon name={t.icon} size={14} />{t.label}
          </button>
        ))}
      </div>

      {err && <div className="mb-3 rounded-lg border border-border-subtle bg-error-soft p-2 text-[12px] text-error-text">{err}</div>}

      {/* RESUMEN */}
      {tab === "resumen" && (
        busy && !sys ? <CargandoBloque /> : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[["Modelo", sys?.model], ["Versión", sys?.version], ["Parche", sys?.patch], ["Uptime", sys?.uptime]].map(([k, v]) => (
                <div key={k} className="rounded-xl border border-border-subtle bg-surface p-3">
                  <div className="text-[11px] text-text-tertiary">{k}</div>
                  <div className="mt-0.5 truncate font-mono text-[13px] text-text-primary">{v || "—"}</div>
                </div>
              ))}
            </div>
            {busy && <CargandoChip />}
            <div className="mt-3"><Button variant="secondary" onClick={() => loadSystem(true)} disabled={busy}><Icon name="refresh-cw" size={14} className="mr-1" />Refrescar</Button></div>
          </>
        )
      )}

      {/* TABLEROS */}
      {tab === "tableros" && (
        <>
          <div className="mb-2"><Button variant="secondary" onClick={() => loadBoards(true)} disabled={busy}><Icon name="refresh-cw" size={14} className="mr-1" />Refrescar tableros</Button></div>
          <DataTable rows={boards ?? []} empty="No se leyeron tableros." loading={busy} loadingText={SSH_MSG} columns={[
            { key: "slot", header: "Slot", render: (b) => <span className="font-mono">{b.slot}</span> },
            { key: "board", header: "Tarjeta", render: (b) => b.board },
            { key: "status", header: "Estado", render: (b) => <Badge label={b.status} tone={/normal/i.test(b.status) ? "success" : "default"} /> },
            { key: "tipo", header: "Tipo", render: (b) => b.gpon ? <Badge label="GPON" tone="brand" /> : b.epon ? <Badge label="EPON" tone="info" /> : "—" },
            { key: "acc", header: "", render: (b) => b.gpon ? <Button size="sm" variant="secondary" onClick={() => { setTab("onus"); void listOnus("0", b.slot, "0"); }}>Ver ONUs →</Button> : null },
          ]} />
          {busy && !!boards?.length && <CargandoChip />}
        </>
      )}

      {/* ONUs POR PUERTO — ficha de una ONU (clic en la lista); "Volver" regresa a la lista. */}
      {tab === "onus" && onuVista && (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={cerrarFicha}>
                <Icon name="arrow-left" size={14} className="mr-1" />Volver a la lista
              </Button>
              <h3 className="text-[14px] font-bold text-text-primary">
                ONU <span className="font-mono">{onuVista.fsp}:{onuVista.ont_id}</span>
              </h3>
              <Badge label={onuVista.run_state || "—"} tone={runTone(onuVista.run_state)} />
              {onuVista.subscriberId ? (
                <Link href={`/clientes/${onuVista.subscriberId}`} className="flex items-center gap-1 text-[13px] text-brand hover:underline">
                  <Icon name="user" size={13} />{onuVista.client}
                </Link>
              ) : (onuVista.client || onuVista.description) && (
                <span className="flex items-center gap-1 text-[13px] text-text-secondary">
                  <Icon name="user" size={13} />{onuVista.client || onuVista.description}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => void detalle(onuVista)} disabled={busy}>
                <Icon name="refresh-cw" size={13} className="mr-1" />Refrescar
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setEditDesc(String(onuVista.description ?? ""))} disabled={busy}>
                <Icon name="pencil" size={13} className="mr-1" />Comentario
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirmar({ action: "reboot", onu: onuVista })} disabled={busy}>
                <Icon name="rotate-cw" size={13} className="mr-1 text-warning-text" />Reiniciar
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirmar({ action: "delete", onu: onuVista })} disabled={busy}>
                <Icon name="trash" size={13} className="mr-1 text-error-text" />Eliminar
              </Button>
            </div>
          </div>

          {/* Editor del comentario grabado en la OLT (desc del ont): identifica al abonado. */}
          {editDesc !== null && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border-subtle bg-surface p-3">
              <span className="text-[12px] text-text-secondary">Comentario en la OLT</span>
              <Input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Nombre/abonado del cliente" className="w-72 max-w-full" maxLength={64} />
              <Button size="sm" onClick={() => void guardarDesc()} disabled={busy}>Guardar</Button>
              <Button size="sm" variant="secondary" onClick={() => setEditDesc(null)} disabled={busy}>Cancelar</Button>
            </div>
          )}

          {/* Lo esencial siempre visible, aunque la ficha completa aún cargue. */}
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-xl border border-border-subtle bg-surface p-3">
              <div className="text-[11px] text-text-tertiary">Serial (SN)</div>
              <div className="mt-0.5 truncate font-mono text-[13px] text-text-primary">{onuVista.sn}</div>
            </div>
            <div className="rounded-xl border border-border-subtle bg-surface p-3">
              <div className="text-[11px] text-text-tertiary">Estado</div>
              <div className="mt-1"><Badge label={onuVista.run_state || "—"} tone={runTone(onuVista.run_state)} /></div>
            </div>
            <div className="rounded-xl border border-border-subtle bg-surface p-3">
              <div className="text-[11px] text-text-tertiary">Config</div>
              <div className="mt-0.5 truncate text-[13px] text-text-primary">{onuVista.config_state || "—"}</div>
            </div>
            <div className="rounded-xl border border-border-subtle bg-surface p-3">
              <div className="text-[11px] text-text-tertiary">Señal RX</div>
              <div className="mt-1"><Badge label={onuVista.rx_power ? `${onuVista.rx_power} dBm` : "—"} tone={rxTone(onuVista.rx_power)} /></div>
            </div>
          </div>

          {/* Señal óptica en vivo: lo primero que se mira al revisar una ONU. */}
          <div className="mb-3 rounded-xl border border-border-subtle bg-surface p-3.5">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px] font-semibold text-text-primary">
              <Icon name="signal" size={14} className="text-brand" />Señal óptica
              {optica === "cargando" && (
                <span className="flex items-center gap-1 text-[11px] font-normal text-text-tertiary">
                  <Icon name="loader" size={12} className="animate-spin" />leyendo del equipo…
                </span>
              )}
            </div>
            {optica !== "cargando" && !opticaObj.rx && !opticaObj.olt_rx && !opticaObj.tx ? (
              <p className="text-[12px] text-text-tertiary">
                La OLT no devolvió lecturas ópticas de esta ONU (suele pasar cuando está offline).
              </p>
            ) : (
              <>
                <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
                  <EscalaSenal label="RX en la ONU (lo que le llega al abonado)" dbm={opticaObj.rx ?? onuVista.rx_power} />
                  <EscalaSenal label="RX en la OLT (lo que devuelve la ONU)" dbm={opticaObj.olt_rx} />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {([
                    ["TX de la ONU", opticaObj.tx ? `${opticaObj.tx} dBm` : null],
                    ["Temperatura", opticaObj.temp ? `${opticaObj.temp} °C` : null],
                    ["Voltaje", opticaObj.voltage ? `${opticaObj.voltage} V` : null],
                    // La lectura de una sola ONU no trae distancia; la ficha (display ont info) sí.
                    ["Distancia óptica", (opticaObj.distance || fichaDistancia) ? `${opticaObj.distance || fichaDistancia} m` : null],
                  ] as [string, string | null][]).map(([k, v]) => (
                    <div key={k} className="rounded-lg border border-border-subtle bg-surface-2/50 p-2.5">
                      <div className="text-[11px] text-text-tertiary">{k}</div>
                      <div className="mt-0.5 truncate font-mono text-[13px] text-text-primary">{v ?? "—"}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {ficha === null ? (
            <CargandoBloque text="Leyendo la ficha de la ONU…" />
          ) : ficha.error ? (
            <div className="rounded-lg border border-border-subtle bg-error-soft p-3 text-[12px] text-error-text">{String(ficha.error)}</div>
          ) : (
            <div className="rounded-xl border border-border-subtle bg-surface p-3">
              <div className="mb-2 text-[13px] font-semibold text-text-primary">Ficha completa (leída de la OLT)</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-3">
                {Object.entries(ficha).filter(([, v]) => typeof v !== "object").map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2 border-b border-border-subtle py-0.5">
                    <span className="text-text-tertiary">{k}</span>
                    <span className="truncate font-mono text-text-primary" title={String(v)}>{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ONUs POR PUERTO — búsqueda y lista. */}
      {tab === "onus" && !onuVista && (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <label className="text-[12px] text-text-secondary">Frame<Input value={onuForm.frame} onChange={(e) => setOnuForm((f) => ({ ...f, frame: e.target.value }))} className="mt-0.5 w-20" /></label>
            <label className="text-[12px] text-text-secondary">Slot<Input value={onuForm.slot} onChange={(e) => setOnuForm((f) => ({ ...f, slot: e.target.value }))} className="mt-0.5 w-20" /></label>
            <label className="text-[12px] text-text-secondary">Puerto<Input value={onuForm.port} onChange={(e) => setOnuForm((f) => ({ ...f, port: e.target.value }))} className="mt-0.5 w-20" /></label>
            <Button onClick={() => listOnus(onuForm.frame, onuForm.slot, onuForm.port)} disabled={busy}><Icon name="search" size={14} className="mr-1" />Listar ONUs</Button>
            {onus !== null && onuForm.slot !== "" && onuForm.port !== "" && (
              <div className="flex items-center gap-1">
                <Button variant="secondary" onClick={() => cambiarPuerto(-1)} disabled={busy || Number(onuForm.port) <= 0} title="Puerto anterior">
                  <Icon name="chevron-left" size={15} />
                </Button>
                <Button variant="secondary" onClick={() => cambiarPuerto(1)} disabled={busy || Number(onuForm.port) >= 15} title="Puerto siguiente">
                  <Icon name="chevron-right" size={15} />
                </Button>
              </div>
            )}
          </div>

          {onus !== null && statsPuerto.total > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Input value={buscarOnu} onChange={(e) => setBuscarOnu(e.target.value)} placeholder="Buscar por serial, ONT o abonado…" className="w-64" />
              {/* Resumen del puerto: cada chip filtra la lista al hacer clic. */}
              <div className="flex flex-wrap items-center gap-1.5">
                {([
                  ["", `Todas · ${statsPuerto.total}`, null],
                  ["online", `En línea · ${statsPuerto.online}`, "var(--color-success)"],
                  ["offline", `Fuera de línea · ${statsPuerto.offline}`, "var(--color-error)"],
                  ["senal", `Señal baja · ${statsPuerto.senal}`, "var(--color-warning)"],
                ] as ["" | "online" | "offline" | "senal", string, string | null][]).map(([key, label, dot]) => (
                  <button key={key} onClick={() => setFiltroEstado(key)}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
                      filtroEstado === key
                        ? "border-brand bg-brand-soft font-medium text-brand"
                        : "border-border-subtle bg-surface text-text-secondary hover:bg-surface-2"
                    }`}>
                    {dot && <span className="h-2 w-2 rounded-full" style={{ background: dot }} />}
                    {label}
                  </button>
                ))}
              </div>
              {(buscarOnu.trim() !== "" || filtroEstado !== "") && (
                <button onClick={() => { setBuscarOnu(""); setFiltroEstado(""); }} className="text-[12px] text-brand hover:underline">
                  Quitar filtros ({onusFiltradas.length} de {statsPuerto.total})
                </button>
              )}
              <span className="text-[11px] text-text-tertiary">Haga clic en una ONU para ver su ficha.</span>
            </div>
          )}

          <DataTable rows={onusFiltradas}
            onRowClick={(o) => void detalle(o)}
            sort={orden} onSort={toggleOrden}
            empty={onus === null ? "Indique slot/puerto y liste las ONUs." : statsPuerto.total === 0 ? "El puerto no tiene ONUs dadas de alta." : "Ninguna ONU coincide con el filtro."}
            loading={busy} loadingText={SSH_MSG} columns={[
            { key: "ont", header: "ONT", sortable: true, render: (o) => <span className="font-mono">{o.fsp}:{o.ont_id}</span> },
            { key: "sn", header: "Serial", render: (o) => <span className="font-mono text-text-secondary">{o.sn}</span> },
            { key: "abonado", header: "Abonado", sortable: true, render: (o) => o.subscriberId
              ? <Link href={`/clientes/${o.subscriberId}`} onClick={(e) => e.stopPropagation()} className="text-brand hover:underline" title={o.description || undefined}>{o.client}</Link>
              : o.client || o.description
                ? <span title={o.description || undefined}>{o.client || o.description}</span>
                : <span className="text-[12px] text-text-tertiary">sin vincular</span> },
            { key: "run", header: "Estado", sortable: true, render: (o) => <Badge label={o.run_state} tone={runTone(o.run_state)} /> },
            { key: "cfg", header: "Config", render: (o) => o.config_state },
            { key: "rx", header: "RX (dBm)", sortable: true, render: (o) => <Badge label={o.rx_power || "—"} tone={rxTone(o.rx_power)} /> },
            { key: "acc", header: "Acciones", render: (o) => (
              <div className="flex gap-1">
                <button title="Ver ficha" onClick={(e) => { e.stopPropagation(); void detalle(o); }} className="tap rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-brand"><Icon name="eye" size={15} /></button>
                <button title="Reiniciar" onClick={(e) => { e.stopPropagation(); setConfirmar({ action: "reboot", onu: o }); }} className="tap rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-warning-text"><Icon name="rotate-cw" size={15} /></button>
                <button title="Eliminar" onClick={(e) => { e.stopPropagation(); setConfirmar({ action: "delete", onu: o }); }} className="tap rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-error-text"><Icon name="trash" size={15} /></button>
              </div>
            ) },
          ]} />
          {busy && !!onus?.length && <CargandoChip />}
        </>
      )}

      {/* AUTOFIND */}
      {tab === "autofind" && (
        <>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[12px] text-text-tertiary">ONUs detectadas sin aprovisionar. Pulse <b>Autenticar</b> para darlas de alta.</p>
            <Button variant="secondary" onClick={loadAutofind} disabled={busy}><Icon name="refresh-cw" size={14} className="mr-1" />Buscar</Button>
          </div>
          <DataTable rows={autofind ?? []} empty="No hay ONUs esperando autenticación." loading={busy} loadingText={SSH_MSG} columns={[
            { key: "sn", header: "Serial (SN)", render: (o) => <span className="font-mono text-text-secondary">{o.sn}</span> },
            { key: "mac", header: "MAC", render: (o) => o.mac
              ? <span className="font-mono text-text-secondary">{o.mac}</span>
              : <span className="text-text-tertiary" title="La ONU no reporta MAC en el autofind">—</span> },
            { key: "model", header: "Equipo", render: (o) => (
              <span className="text-[12px]">{o.model || o.vendor || "—"}</span>
            ) },
            { key: "fsp", header: "F/S/P", render: (o) => <span className="font-mono">{o.fsp || "—"}</span> },
            { key: "loid", header: "LOID", render: (o) => o.loid || "—" },
            { key: "acc", header: "", render: (o) => {
              const { frame, slot, port } = parseFsp(o.fsp);
              return <Button size="sm" onClick={() => setAuthModal({ sn: o.sn, frame: String(frame), slot: o.fsp ? String(slot) : "", port: o.fsp ? String(port) : "", model: o.model || o.vendor || "" })}><Icon name="wand-sparkles" size={14} className="mr-1" />Autenticar</Button>;
            } },
          ]} />
          {busy && !!autofind?.length && <CargandoChip />}
        </>
      )}

      {/* BUSCAR SN */}
      {tab === "buscar" && (
        <div className="max-w-xl">
          <div className="mb-3 flex gap-2">
            <Input value={snQuery} onChange={(e) => setSnQuery(e.target.value)} placeholder="Serial de la ONU (SN)…" className="font-mono" onKeyDown={(e) => e.key === "Enter" && buscarSn()} />
            <Button onClick={buscarSn} disabled={busy}><Icon name="search" size={14} className="mr-1" />Buscar</Button>
          </div>
          {busy
            ? <CargandoBloque text="Buscando el serial en la OLT…" />
            : snResult && <DetalleBox data={snResult} onClose={() => setSnResult(null)} />}
        </div>
      )}

      {/* SYNC */}
      {tab === "sync" && (
        <div className="max-w-xl">
          <p className="mb-2 text-[12px] text-text-tertiary">Recorre los puertos del slot indicado y actualiza el inventario local de ONUs (visible en <Link href="/red/onus" className="text-brand hover:underline">Inventario</Link>).</p>
          <div className="flex items-end gap-2">
            <label className="text-[12px] text-text-secondary">Slot GPON<Input value={syncSlot} onChange={(e) => setSyncSlot(e.target.value)} className="mt-0.5 w-24" /></label>
            <Button onClick={doSync} disabled={busy}><Icon name="refresh-cw" size={14} className="mr-1" />Sincronizar slot</Button>
          </div>
          {busy
            ? <div className="mt-3"><CargandoBloque text="Recorriendo los puertos del slot…" /></div>
            : syncMsg && <div className="mt-3 rounded-lg border border-border-subtle bg-surface-2 p-2 text-[12px]">{syncMsg}</div>}
        </div>
      )}

      {/* HISTORIAL */}
      {tab === "historial" && (
        <DataTable rows={history} empty="Sin acciones registradas." loading={busy} loadingText="Cargando el historial…" columns={[
          { key: "date", header: "Fecha", render: (l) => new Date(l.createdAt).toLocaleString("es-CO") },
          { key: "action", header: "Acción", render: (l) => <Badge label={l.action} tone={l.ok ? "success" : "error"} /> },
          { key: "mode", header: "Modo", render: (l) => <Badge label={l.dryRun ? "dry-run" : "live"} tone={l.dryRun ? "info" : "warning"} /> },
          { key: "sn", header: "ONU", render: (l) => <span className="font-mono text-[12px]">{l.sn || l.fsp || "—"}</span> },
          { key: "detail", header: "Detalle", render: (l) => <span className="text-[12px] text-text-tertiary">{l.detail}</span> },
          { key: "user", header: "Usuario", render: (l) => l.userName || "—" },
        ]} />
      )}

      {authModal && (
        <AutenticarOnuModal open onClose={() => setAuthModal(null)} oltId={id} olt={olt} live={live}
          preset={authModal} onDone={() => { if (tab === "autofind") void loadAutofind(); }} />
      )}

      {confirmar && (
        <ConfirmDialog
          open
          busy={busy}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void onuAction(confirmar.action, confirmar.onu)}
          tone={confirmar.action === "delete" ? "danger" : "primary"}
          icon={confirmar.action === "delete" ? "trash" : "rotate-cw"}
          title={confirmar.action === "delete" ? "Eliminar ONU de la OLT" : "Reiniciar ONU"}
          confirmLabel={confirmar.action === "delete" ? "Eliminar de la OLT" : "Reiniciar ahora"}
          // Solo en LIVE se exige teclear el serial: en dry-run no se toca nada.
          requireText={live && confirmar.action === "delete" ? confirmar.onu.sn : undefined}
          requireHint={<>Para confirmar, escriba el serial <span className="font-mono font-semibold text-text-primary">{confirmar.onu.sn}</span></>}
          message={
            confirmar.action === "delete" ? (
              <>
                Se borrará la ONU de la OLT junto con sus service-ports, que es lo que
                le da servicio.{" "}
                {live
                  ? <b className="text-error-text">El abonado quedará sin internet de inmediato.</b>
                  : <>Está en <b>dry-run</b>: solo se generará el plan de comandos, no se toca el equipo.</>}
              </>
            ) : (
              <>
                La ONU se reiniciará y el abonado perderá la conexión durante uno o dos minutos.{" "}
                {!live && <>Está en <b>dry-run</b>: no se toca el equipo.</>}
              </>
            )
          }
          detail={<OnuResumen onu={confirmar.onu} />}
        />
      )}
    </>
  );
}

export default function OperarOltPage() {
  // `useSearchParams` obliga a un límite de Suspense en el App Router.
  return (
    <Suspense fallback={<PageSkeleton />}>
      <OperarOltVista />
    </Suspense>
  );
}

/**
 * Ficha compacta de la ONU dentro de la confirmación: sirve para que el
 * operador verifique que va a tocar la que cree, no la de al lado.
 */
function OnuResumen({ onu }: { onu: LiveOnu }) {
  const filas: [string, React.ReactNode][] = [
    ["ONT", <span key="a" className="font-mono">{onu.fsp}:{onu.ont_id}</span>],
    ["Serial", <span key="b" className="font-mono">{onu.sn}</span>],
    ["Estado", <Badge key="c" label={onu.run_state || "—"} tone={runTone(onu.run_state)} />],
    ["Señal", <Badge key="d" label={onu.rx_power ? `${onu.rx_power} dBm` : "—"} tone={rxTone(onu.rx_power)} />],
  ];
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

/**
 * Escala de potencia óptica (dBm) con las zonas de rxTone() de fondo y la
 * lectura marcada encima: misma semántica de color que los badges de la lista,
 * y la zona además se nombra con un Badge (nunca color solo).
 */
function EscalaSenal({ label, dbm }: { label: string; dbm?: string }) {
  const MIN = -35, MAX = -10; // rango visible de la escala
  const val = dbm !== undefined && dbm !== null && /^-?[0-9.]+$/.test(dbm) ? parseFloat(dbm) : null;
  const pct = (x: number) => ((x - MIN) / (MAX - MIN)) * 100;
  const pos = val === null ? null : Math.max(0, Math.min(100, pct(val)));
  const tone = rxTone(dbm);
  const zona = tone === "success" ? "OK" : tone === "warning" ? "Débil" : tone === "error" ? "Crítica" : null;
  const colorZona = tone === "warning" ? "var(--color-warning)" : tone === "error" ? "var(--color-error)" : "var(--color-success)";
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-text-secondary">{label}</span>
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[15px] font-bold text-text-primary">{val === null ? "—" : `${dbm} dBm`}</span>
          {zona && <Badge label={zona} tone={tone} />}
        </span>
      </div>
      <div className="relative mt-1.5">
        <div className="flex h-2.5 overflow-hidden rounded-full">
          <div style={{ width: `${pct(-28)}%`, background: "var(--color-error)", opacity: 0.3 }} />
          <div style={{ width: `${pct(-25) - pct(-28)}%`, background: "var(--color-warning)", opacity: 0.3 }} />
          <div style={{ width: `${100 - pct(-25)}%`, background: "var(--color-success)", opacity: 0.3 }} />
        </div>
        {pos !== null && (
          <div className="absolute -top-[3px] h-4 w-[3px] -translate-x-1/2 rounded-full"
            style={{ left: `${pos}%`, background: colorZona }} />
        )}
      </div>
      <div className="relative mt-1 h-4 font-mono text-[10px] text-text-tertiary">
        <span className="absolute left-0">−35</span>
        <span className="absolute -translate-x-1/2" style={{ left: `${pct(-28)}%` }}>−28</span>
        <span className="absolute -translate-x-1/2" style={{ left: `${pct(-25)}%` }}>−25</span>
        <span className="absolute right-0">−10 dBm</span>
      </div>
    </div>
  );
}

function DetalleBox({ data, onClose }: { data: Record<string, unknown>; onClose: () => void }) {
  const entries = Object.entries(data).filter(([, v]) => typeof v !== "object");
  return (
    <div className="mt-3 rounded-xl border border-border-subtle bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-semibold text-text-primary">Detalle de ONU</span>
        <button onClick={onClose} className="text-text-tertiary hover:text-text-primary"><Icon name="x" size={15} /></button>
      </div>
      {data.error ? <p className="text-[12px] text-error-text">{String(data.error)}</p> : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-3">
          {entries.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 border-b border-border-subtle py-0.5">
              <span className="text-text-tertiary">{k}</span>
              <span className="truncate font-mono text-text-primary">{String(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
