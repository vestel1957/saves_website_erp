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
import { BotonOrden } from "@/components/ui/tabla-ordenable";
import { useOrden } from "@/lib/useOrden";
import { ParteDelLoteModal, type ParteDelLote, type FilaDelLote } from "@/components/network/ParteDelLoteModal";
import { SUB_STATUS_LABEL, SUB_STATUS_TONE, cop } from "@/lib/subscribers";
import type { MkMode } from "@/lib/mikrotik";

type Plan = { plan: string | null; price: number } | null;
type Row = { id: string; name: string; abonado: number; status: string | null; docNumber: string | null; phone?: string | null; branch?: string | null; balance?: number; debt?: number; internet?: Plan; tv?: Plan };
type BranchStat = { id: string; name: string; total: number; activos: number; cortados: number; cartera: number };

const ALL: BranchStat = { id: "", name: "Todas las sedes", total: 0, activos: 0, cortados: 0, cartera: 0 };

/** Lo que cada abonado trae en común en la respuesta de cualquier lote. */
type QuienDelLote = { subscriberId?: string; abonado?: number | null; name?: string | null; ok?: boolean };
/** A cuántos NO se les tocó nada y por qué (candado de `corte.policy.ts`). */
type Protegidos = { compromiso?: number; sinVencer?: number };
type RespInternet = {
  total?: number; ok?: number; ordenes?: number; compromisosProtegidos?: number; protegidos?: Protegidos;
  results?: (QuienDelLote & { dryRun?: boolean; message?: string; error?: string; steps?: string[] })[];
};
type RespTv = {
  total?: number; done?: number; failed?: number; sinEquipo?: number; ordenes?: number;
  dryRun?: boolean; compromisosProtegidos?: number; protegidos?: Protegidos;
  results?: (QuienDelLote & { via?: string | null; detail?: string })[];
};
type RespWhatsapp = { total?: number; sent?: number; results?: (QuienDelLote & { phone?: string; error?: string })[] };
type RespSecrets = {
  dryRun?: boolean; total?: number; ok?: number; failed?: number;
  errors?: (QuienDelLote & { error?: string })[];
};

// ── Los partes: traducir la respuesta de cada lote a lo que se enseña ─────────
// Cada endpoint contesta con su propia forma (el Mikrotik habla de `results` con
// pasos, la TV de `done`/`sinEquipo`, el WhatsApp de `sent`). Se normalizan aquí,
// en un sitio, para que el modal sea uno solo y diga siempre lo mismo.

/** Corte / reconexión de internet en el Mikrotik. */
function parteDeInternet(d: RespInternet, kind: "cut" | "reconnect"): ParteDelLote {
  const total = d.total ?? d.results?.length ?? 0;
  const hechos = d.ok ?? 0;
  const verbo = kind === "cut" ? "Corte de internet" : "Reconexión de internet";
  const filas: FilaDelLote[] = (d.results ?? []).map((r) => ({
    subscriberId: r.subscriberId,
    abonado: r.abonado,
    name: r.name,
    ok: !!r.ok,
    detalle: r.ok ? r.message : (r.error ?? r.message ?? "No se pudo aplicar."),
    // Los pasos son lo que de verdad se hizo en el router, nombre por nombre. Es la
    // letra pequeña que se mira cuando algo no cuadra.
    pasos: (r.steps ?? []).join(" · ") || null,
  }));
  return {
    titulo: verbo,
    resumen: `${verbo}: se aplicó a ${hechos} de ${total} ${total === 1 ? "cliente" : "clientes"}.`,
    dryRun: (d.results ?? []).some((r) => r.dryRun),
    avisoDryRun: "No se tocó el router: esto es lo que HABRÍA pasado en producción.",
    chips: [
      { label: "aplicados", valor: hechos, tono: "success" },
      { label: "sin aplicar", valor: Math.max(0, total - hechos), tono: "error" },
      // Las órdenes sólo las devuelve el CORTE (la reconexión deja la suya al cobrar).
      // Se dicen porque son lo que queda escrito en la ficha del cliente.
      { label: "órdenes registradas y cerradas", valor: d.ordenes ?? 0, tono: "default" },
      { label: "protegidos por compromiso de pago", valor: d.protegidos?.compromiso ?? d.compromisosProtegidos ?? 0, tono: "warning" },
      // El que sólo debe el mes corriente NO se corta: todavía está en plazo. Se
      // enseña para que quien mandó el lote sepa por qué la cuenta no cuadra.
      { label: "no cortados: aún en plazo (sin factura vencida)", valor: d.protegidos?.sinVencer ?? 0, tono: "warning" },
    ],
    filas,
  };
}

/** Corte / alta de la señal de TV (TR-069 u OLT según el equipo de cada abonado). */
function parteDeTv(d: RespTv, kind: "cut" | "reconnect"): ParteDelLote {
  const total = d.total ?? d.results?.length ?? 0;
  const hechos = d.done ?? 0;
  const verbo = kind === "cut" ? "Corte de TV" : "Alta de TV";
  const filas: FilaDelLote[] = (d.results ?? []).map((r) => ({
    subscriberId: r.subscriberId,
    abonado: r.abonado,
    name: r.name,
    ok: !!r.ok && !!r.via,
    // "Sin equipo" no es un fallo del sistema: es que ese abonado no tiene ni CPE en
    // el ACS ni ONU en la OLT, así que no había por dónde tocarlo. Se cuenta aparte.
    sinEquipo: !r.via,
    via: r.via === "TR069" ? "por TR-069" : r.via === "OLT" ? "por la OLT" : null,
    detalle: r.detail,
  }));
  return {
    titulo: verbo,
    resumen: `${verbo}: se aplicó a ${hechos} de ${total} ${total === 1 ? "cliente" : "clientes"}.`,
    dryRun: !!d.dryRun,
    avisoDryRun: "No se tocó ningún equipo: esto es lo que HABRÍA pasado en producción.",
    chips: [
      { label: "aplicados", valor: hechos, tono: "success" },
      { label: "fallidos", valor: d.failed ?? 0, tono: "error" },
      { label: "sin equipo (ni CPE en el ACS ni ONU en la OLT)", valor: d.sinEquipo ?? 0, tono: "warning" },
      // En un lote de puros "sin equipo" la orden es el ÚNICO rastro del trabajo.
      { label: "órdenes registradas y cerradas", valor: d.ordenes ?? 0, tono: "default" },
      { label: "protegidos por compromiso de pago", valor: d.protegidos?.compromiso ?? d.compromisosProtegidos ?? 0, tono: "warning" },
      // El que sólo debe el mes corriente NO se corta: todavía está en plazo. Se
      // enseña para que quien mandó el lote sepa por qué la cuenta no cuadra.
      { label: "no cortados: aún en plazo (sin factura vencida)", valor: d.protegidos?.sinVencer ?? 0, tono: "warning" },
    ],
    filas,
  };
}

/** WhatsApp masivo. */
function parteDeWhatsapp(d: RespWhatsapp): ParteDelLote {
  const total = d.total ?? d.results?.length ?? 0;
  const enviados = d.sent ?? 0;
  const filas: FilaDelLote[] = (d.results ?? []).map((r) => ({
    subscriberId: r.subscriberId,
    abonado: r.abonado,
    name: r.name,
    ok: !!r.ok,
    detalle: r.ok ? `Enviado a ${r.phone}` : r.error === "sin teléfono" ? "No tiene teléfono registrado." : (r.error ?? "No se pudo enviar."),
  }));
  return {
    titulo: "WhatsApp masivo",
    resumen: `Se envió a ${enviados} de ${total} ${total === 1 ? "cliente" : "clientes"}.`,
    dryRun: false,
    chips: [
      { label: "enviados", valor: enviados, tono: "success" },
      { label: "sin enviar", valor: Math.max(0, total - enviados), tono: "error" },
    ],
    filas,
  };
}

/** Restauración de los secrets PPP de una sede. Solo devuelve el detalle de los fallos. */
function parteDeSecrets(d: RespSecrets): ParteDelLote {
  const filas: FilaDelLote[] = (d.errors ?? []).map((e) => ({
    subscriberId: e.subscriberId,
    abonado: e.abonado,
    name: e.name,
    ok: false,
    detalle: e.error,
  }));
  return {
    titulo: "Restaurar secrets PPP de la sede",
    resumen: `Se crearon o actualizaron ${d.ok ?? 0} de ${d.total ?? 0} secrets.`,
    dryRun: !!d.dryRun,
    avisoDryRun: "No se tocó el router: se calculó el plan de cada secret sin escribirlo.",
    chips: [
      { label: "secrets al día", valor: d.ok ?? 0, tono: "success" },
      { label: "con error", valor: d.failed ?? 0, tono: "error" },
    ],
    filas,
    // El servicio solo devuelve el detalle de los primeros 15 errores: si no hubo
    // ninguno no hay nada que listar, y eso es exactamente la buena noticia.
    vacio: "Ninguno falló.",
  };
}

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
  const [exportando, setExportando] = useState(false);
  const [waOpen, setWaOpen] = useState(false);
  const [waMsg, setWaMsg] = useState("Hola {nombre}, le recordamos que su servicio Vestel (abonado {abonado}) presenta saldo pendiente. Acérquese a pagar para evitar la suspensión. Gracias.");
  const [busy, setBusy] = useState(false);
  // El parte del último lote ejecutado. Mientras hay uno, se enseña el modal.
  const [parte, setParte] = useState<ParteDelLote | null>(null);

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

  // El orden lo pone el SERVIDOR, no la vista. La tabla es una preview de 100 filas
  // y el Excel se baja entero: si ordenara aquí, el archivo saldría barajado
  // respecto de lo que se está mirando. Arranca por abonado ascendente, que es el
  // orden por defecto del endpoint, para que la cabecera no mienta al cargar.
  const orden = useOrden({ by: "abonado", dir: "asc" });
  const ordenSort = orden.sort; // estado: identidad estable entre renders
  const th = { orden: ordenSort ?? null, pulsar: orden.onSort };

  /**
   * Los filtros Y el orden que están puestos en pantalla, en forma de query.
   *
   * Lo usan la tabla y el Excel a la vez: si cada uno armara el suyo, el archivo
   * acabaría diciendo algo distinto —y en otro orden— de lo que se está mirando.
   */
  const filtrosQs = useCallback(() => {
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (sede?.id) qs.set("branchId", sede.id);
    if (search) qs.set("search", search);
    if (servicio) qs.set("servicio", servicio);
    if (cuenta) qs.set("cuenta", cuenta);
    if (deuda) qs.set("deuda", deuda);
    if (tecnologia) qs.set("tecnologia", tecnologia);
    if (ordenSort) { qs.set("sortBy", ordenSort.by); qs.set("sortDir", ordenSort.dir); }
    return qs;
  }, [status, sede, search, servicio, cuenta, deuda, tecnologia, ordenSort]);

  const load = useCallback(() => {
    if (!sede) return;
    setLoading(true);
    // Carga acotada: 100 filas como vista previa. Para operar sobre más, el banner
    // "seleccionar los N que cumplen el filtro" ejecuta el lote server-side sobre el
    // filtro completo (no depende de cuántas filas estén cargadas en pantalla).
    const qs = filtrosQs();
    qs.set("page", "1");
    qs.set("pageSize", "100");
    qs.set("withPlan", "1");
    // Al recargar se suelta la selección, también al reordenar: el orden lo resuelve
    // el servidor, así que las 100 filas de la preview ya no son las mismas y dejar
    // marcados a los de antes diría "12 seleccionados" señalando a gente que no está
    // en pantalla.
    void authFetch(`/subscribers?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : { items: [], total: 0 }))
      .then((d) => { setRows(d.items ?? []); setTotal(d.total ?? 0); setSel(new Set()); setAllMatching(false); })
      .catch(() => { setRows([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [authFetch, sede, filtrosQs]);
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
      setParte(servicioOp === "tv" ? parteDeTv(d, kind) : parteDeInternet(d, kind));
      load();
    } catch (e) { toast((e as Error).message, "x"); }
    finally { setBusy(false); setConfirmCut(false); }
  }

  /**
   * Excel de lo que hay en pantalla. Va contra el mismo endpoint que el listado de
   * clientes, así que el archivo respeta el filtro completo (sede, deuda, estado…) y
   * no solo las 100 filas cargadas. Trae las columnas de conexión —usuario PPPoE,
   * IP remota y perfil—, que es lo que se necesita para ir a buscarlos al router.
   *
   * Y sale en el MISMO orden de la tabla: `filtrosQs()` mete el `sortBy`/`sortDir`
   * que pide la cabecera, así que la fila 1 del archivo es la fila 1 de la pantalla
   * (el archivo sigue después con las que no cabían en la vista previa).
   */
  const exportar = async () => {
    setExportando(true);
    try {
      const res = await authFetch(`/subscribers/export.xlsx?${filtrosQs().toString()}`);
      if (!res.ok) throw new Error("No se pudo exportar");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `clientes-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast((e as Error).message, "alert-triangle");
    } finally {
      setExportando(false);
    }
  };

  async function restoreBranch() {
    if (!sede?.id) return;
    setBusy(true);
    try {
      const res = await authFetch(`/network/mikrotik/restore-branch/${sede.id}`, { method: "POST", body: JSON.stringify({}) });
      const d = await res.json();
      if (!res.ok) { toast(d?.message ?? "Error", "x"); return; }
      setParte(parteDeSecrets(d));
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
      setWaOpen(false);
      setParte(parteDeWhatsapp(d));
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
          <Button variant="secondary" size="sm" disabled={exportando || total === 0} onClick={() => void exportar()}>
            <Icon name="download" size={14} /> {exportando ? "Generando…" : "Excel"}
          </Button>
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
            <option value="compromiso">Compromiso (marca de estado)</option>
          </select>
        </label>
        <label className="text-[12px] text-text-secondary">
          <span className="mb-1 block">Deuda</span>
          <select value={deuda} onChange={(e) => setDeuda(e.target.value)} className="rounded-lg border border-border-default bg-surface px-2 py-1.5 text-[13px]">
            <option value="">Cualquiera</option>
            {/* Lo primero es lo que se mira para cortar: PLATA **ya vencida**. La
                factura del mes corriente sale el día 1 y vence el 20, así que sin
                el "vencida" el que está al día aparecería aquí desde el día 1 (fue
                exactamente lo que pasó en el corte del legacy del 09-09-2026). Las
                de abajo cuentan documentos abiertos, que no es lo mismo (una
                factura del legacy puede traer varios meses, y un abono parcial deja
                la factura abierta debiendo cuatro pesos). */}
            <option value="fija">Debe una mensualidad o más YA VENCIDA</option>
            <option value="1">Tiene 1 factura sin pagar</option>
            {/* La escalera de la cartera: 1 = va al día del mes que corre, 2 = está en
                compromiso, más de 2 = Cartera. "Compromiso" aquí es la definición de la
                operación (debe dos meses seguidos COMPLETOS), no la marca
                `status = COMPROMISO`, que está desfasada: la llevan 75 en Yopal y solo
                8 deben de verdad dos. Lo de "completas" no es un matiz: sin eso entra
                el que abonó casi todo y quedó debiendo $10.750, o el que "debe dos"
                y una es el prorrateo de $3.484 de su mes de instalación. Completa =
                la mensualidad entera de su plan, sin un peso abonado. */}
            <option value="compromiso">Debe 2 mensualidades completas: este mes + el pasado (compromiso)</option>
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
              {/* Nº de fila: el mismo que lleva la primera columna del Excel. */}
              <th className="w-12 py-2 pr-5 text-right font-medium tabular-nums">#</th>
              <th className="py-2 pr-3 font-medium"><BotonOrden t={th} clave="abonado">Abonado</BotonOrden></th>
              <th className="py-2 pr-3 font-medium"><BotonOrden t={th} clave="name">Cliente</BotonOrden></th>
              {/* Internet, TV y Debe se quedan sin flecha a propósito: el plan sale de
                  los servicios contratados y la deuda es Σ(total − pagado) de las
                  facturas, dos cosas que el ORDER BY del listado no sabe poner. Antes
                  ordenaban en la vista, y eso mentía: "más deudor" era el mayor de las
                  100 filas cargadas, no el de la sede. Para la deuda está el filtro. */}
              <th className="py-2 pr-3 font-medium">Internet</th>
              <th className="py-2 pr-3 font-medium">TV</th>
              <th className="py-2 pr-3 font-medium"><BotonOrden t={th} clave="phone">Teléfono</BotonOrden></th>
              <th className="py-2 pr-3 font-medium"><BotonOrden t={th} clave="status">Estado</BotonOrden></th>
              <th className="py-2 pr-3 text-right font-medium">Debe</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="py-6 text-center text-text-tertiary">Cargando…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="py-6 text-center text-text-tertiary">Sin clientes para este filtro.</td></tr>
            ) : rows.map((r, i) => (
              <tr key={r.id} className={`border-b border-border-subtle/60 ${sel.has(r.id) ? "bg-brand-soft/40" : ""}`}>
                <td className="py-1.5 pl-3"><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
                <td className="py-1.5 pr-5 text-right tabular-nums text-text-tertiary">{i + 1}</td>
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

      {/* Parte del último lote: qué se hizo, a quién y qué falló. */}
      <ParteDelLoteModal parte={parte} onClose={() => setParte(null)} />

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
