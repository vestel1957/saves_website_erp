"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { objetoJson } from "@/lib/errores";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Pagination, TODOS } from "@/components/ui/Pagination";
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
type Protegidos = { compromiso?: number; sinVencer?: number; sinServicio?: number };
type RespInternet = {
  total?: number; ok?: number; ordenes?: number; compromisosProtegidos?: number; protegidos?: Protegidos;
  results?: (QuienDelLote & { dryRun?: boolean; message?: string; error?: string; steps?: string[] })[];
};
type RespTv = {
  total?: number; done?: number; failed?: number; sinEquipo?: number; ordenes?: number;
  dryRun?: boolean; compromisosProtegidos?: number; protegidos?: Protegidos;
  /** El servidor TR-069 no contestó: el lote siguió sólo por la OLT. */
  acsCaido?: string | null;
  /** Clientes EOC que se sacaron del corte: su TV se corta en el poste. */
  eoc?: QuienDelLote[];
  /** TR-069 y OLT en pausa (`network.tvSoloSistema`): sólo se marcó la ficha. */
  soloSistema?: boolean;
  /** A cuántos se les dejó el estado de la TV escrito en la ficha. */
  marcados?: number;
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
      // Marcados por deuda, pero no tienen contratado lo que se corta (sólo TV / sólo internet).
      { label: "no cortados: no tienen ese servicio", valor: d.protegidos?.sinServicio ?? 0, tono: "warning" },
    ],
    filas,
  };
}

/** Corte / alta de la señal de TV (TR-069 u OLT según el equipo de cada abonado). */
function parteDeTv(d: RespTv, kind: "cut" | "reconnect"): ParteDelLote {
  const total = d.total ?? d.results?.length ?? 0;
  const hechos = d.done ?? 0;
  const verbo = kind === "cut" ? "Corte de TV" : "Alta de TV";
  if (d.soloSistema) return parteDeTvSoloSistema(d, kind, verbo, total);
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
    resumen: `${verbo}: se aplicó a ${hechos} de ${total} ${total === 1 ? "cliente" : "clientes"}.`
      + (d.acsCaido ? " El servidor TR-069 no respondió: sólo se tocaron los equipos de la OLT." : "")
      + (kind === "cut" && d.ordenes ? " Todos quedan marcados con la TV cortada en su ficha." : "")
      + (d.eoc?.length
        ? ` ${d.eoc.length} ${d.eoc.length === 1 ? "cliente es" : "clientes son"} de EOC y no se ${d.eoc.length === 1 ? "tocó" : "tocaron"}: esa TV se corta en el poste (${d.eoc.map((c) => c.abonado).filter(Boolean).join(", ")}).`
        : ""),
    dryRun: !!d.dryRun,
    avisoDryRun: "No se tocó ningún equipo: esto es lo que HABRÍA pasado en producción.",
    chips: [
      { label: "aplicados", valor: hechos, tono: "success" },
      { label: "fallidos", valor: d.failed ?? 0, tono: "error" },
      { label: "sin equipo (ni CPE en el ACS ni ONU en la OLT)", valor: d.sinEquipo ?? 0, tono: "warning" },
      { label: "no cortados: EOC, se corta en el poste", valor: d.eoc?.length ?? 0, tono: "warning" },
      // En un lote de puros "sin equipo" la orden es el ÚNICO rastro del trabajo. Las del
      // corte que hizo la red nacen cerradas; las que hay que hacer a mano, PENDIENTES.
      { label: "órdenes de corte registradas", valor: d.ordenes ?? 0, tono: "default" },
      { label: "protegidos por compromiso de pago", valor: d.protegidos?.compromiso ?? d.compromisosProtegidos ?? 0, tono: "warning" },
      // El que sólo debe el mes corriente NO se corta: todavía está en plazo. Se
      // enseña para que quien mandó el lote sepa por qué la cuenta no cuadra.
      { label: "no cortados: aún en plazo (sin factura vencida)", valor: d.protegidos?.sinVencer ?? 0, tono: "warning" },
      // Marcados por deuda, pero no tienen contratado lo que se corta (sólo TV / sólo internet).
      { label: "no cortados: no tienen ese servicio", valor: d.protegidos?.sinServicio ?? 0, tono: "warning" },
    ],
    filas,
  };
}

/**
 * El lote de TV con la red en pausa: no se tocó ningún equipo, sólo la ficha (y la
 * orden cerrada, al cortar). Contarlo como "sin equipo" haría creer que falló.
 */
function parteDeTvSoloSistema(d: RespTv, kind: "cut" | "reconnect", verbo: string, total: number): ParteDelLote {
  const marcados = d.marcados ?? 0;
  const filas: FilaDelLote[] = (d.results ?? []).map((r) => ({
    subscriberId: r.subscriberId,
    abonado: r.abonado,
    name: r.name,
    ok: r.detail !== "Cliente no encontrado.",
    via: "solo en el sistema",
    detalle: r.detail,
  }));
  return {
    titulo: verbo,
    resumen: `${verbo}: ${marcados} de ${total} ${total === 1 ? "cliente quedó" : "clientes quedaron"} ${kind === "cut" ? "con la TV cortada" : "con la TV activa"} en el sistema.`
      + " El TR-069 está en pausa: no se tocó ningún equipo, el trabajo en la red se hace a mano."
      + (kind === "cut" && d.ordenes ? ` Quedaron ${d.ordenes} ${d.ordenes === 1 ? "orden" : "órdenes"} de corte PENDIENTES: se cierran al cortar en sitio.` : ""),
    dryRun: false,
    chips: [
      { label: "marcados en el sistema", valor: marcados, tono: "success" },
      { label: "órdenes pendientes para hacer en sitio", valor: d.ordenes ?? 0, tono: "default" },
      { label: "protegidos por compromiso de pago", valor: d.protegidos?.compromiso ?? d.compromisosProtegidos ?? 0, tono: "warning" },
      { label: "no cortados: aún en plazo (sin factura vencida)", valor: d.protegidos?.sinVencer ?? 0, tono: "warning" },
      // Marcados por deuda, pero no tienen contratado lo que se corta (sólo TV / sólo internet).
      { label: "no cortados: no tienen ese servicio", valor: d.protegidos?.sinServicio ?? 0, tono: "warning" },
    ],
    filas,
  };
}

// ── El lote por tandas ────────────────────────────────────────────────────────
// Un lote de 500 en una sola petición dejaba la pantalla diciendo "Cortando…" sin
// saber cuánto iba ni si ya había terminado. Se parte en tandas y se pinta el avance.

/** Clientes por petición. El internet abre sesión en cada router: tandas cortas. */
const TANDA_INTERNET = 20;
const TANDA_TV = 50;

type Progreso = {
  titulo: string;
  hechos: number;
  total: number;
  inicio: number;
  /** Se pidió detener: se termina la tanda en curso y se para. */
  deteniendo: boolean;
};

const suma = (a?: number, b?: number) => (a ?? 0) + (b ?? 0);

function juntarProtegidos(a?: Protegidos, b?: Protegidos): Protegidos {
  return {
    compromiso: suma(a?.compromiso, b?.compromiso),
    sinVencer: suma(a?.sinVencer, b?.sinVencer),
    sinServicio: suma(a?.sinServicio, b?.sinServicio),
  };
}

/** Suma el parte de una tanda de internet al acumulado. */
function juntarInternet(a: RespInternet, b: RespInternet): RespInternet {
  return {
    total: suma(a.total, b.total), ok: suma(a.ok, b.ok), ordenes: suma(a.ordenes, b.ordenes),
    protegidos: juntarProtegidos(a.protegidos, b.protegidos),
    results: [...(a.results ?? []), ...(b.results ?? [])],
  };
}

/** Suma el parte de una tanda de TV al acumulado. */
function juntarTv(a: RespTv, b: RespTv): RespTv {
  return {
    total: suma(a.total, b.total), done: suma(a.done, b.done), failed: suma(a.failed, b.failed),
    sinEquipo: suma(a.sinEquipo, b.sinEquipo), ordenes: suma(a.ordenes, b.ordenes), marcados: suma(a.marcados, b.marcados),
    dryRun: !!(a.dryRun || b.dryRun), acsCaido: a.acsCaido || b.acsCaido || null,
    soloSistema: !!(a.soloSistema || b.soloSistema),
    protegidos: juntarProtegidos(a.protegidos, b.protegidos),
    eoc: [...(a.eoc ?? []), ...(b.eoc ?? [])],
    results: [...(a.results ?? []), ...(b.results ?? [])],
  };
}

function minutos(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
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
/** Filas con plan que da el servidor por petición (su tope con `withPlan`). */
const TANDA = 500;
/** Peticiones simultáneas al armar "Todos": no ahogar la API con la sede entera. */
const EN_PARALELO = 3;

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
  const [page, setPage] = useState(1);
  // Arranca en "Todos": la sede entera en la tabla. El servidor no da más de
  // `TANDA` filas con plan por petición, así que "Todos" se arma por tandas.
  const [pageSize, setPageSize] = useState<number>(TODOS);
  const [cargadas, setCargadas] = useState(0); // progreso de la carga por tandas
  // La selección son ids, no filas: sobrevive al cambio de página, así se puede
  // marcar a uno de la página 1 y a otro de la 3 y operar sobre los dos.
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
  // El avance del lote en curso (null = no hay ninguno corriendo).
  const [progreso, setProgreso] = useState<Progreso | null>(null);
  const detener = useRef(false);
  // El reloj del modal de avance: que "lleva X" corra aunque una tanda tarde.
  const [, setTic] = useState(0);
  useEffect(() => {
    if (!progreso) return;
    const t = setInterval(() => setTic((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [!!progreso]); // eslint-disable-line react-hooks/exhaustive-deps
  // TR-069 en pausa: el corte de TV sólo se anota en el sistema. Null = no se sabe
  // (el usuario no ve el módulo de GenieACS): la confirmación habla en general.
  const [tvSoloSistema, setTvSoloSistema] = useState<boolean | null>(null);

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
    void authFetch("/network/genieacs/mode")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setTvSoloSistema(typeof d?.tvSoloSistema === "boolean" ? d.tvSoloSistema : null))
      .catch(() => {});
  }, [authLoading, authFetch]);

  // El orden lo pone el SERVIDOR, no la vista. La tabla va por páginas
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

  // Al cambiar el filtro salen dos cargas seguidas (la de la página vieja y la de la
  // página 1): sólo se pinta la última que se pidió, no la última que llegó.
  const pedido = useRef(0);
  const load = useCallback(() => {
    if (!sede) return;
    const este = ++pedido.current;
    const vigente = () => este === pedido.current;
    setLoading(true);
    setCargadas(0);
    // Para operar sobre todos, el banner "seleccionar los N que cumplen el filtro"
    // ejecuta el lote server-side sobre el filtro completo (no depende de lo cargado).
    const pedir = async (pg: number, size: number): Promise<{ items: Row[]; total: number }> => {
      const qs = filtrosQs();
      qs.set("page", String(pg));
      qs.set("pageSize", String(size));
      qs.set("withPlan", "1");
      const r = await authFetch(`/subscribers?${qs.toString()}`);
      if (!r.ok) throw new Error();
      const d = await r.json();
      return { items: d.items ?? [], total: d.total ?? 0 };
    };
    void (async () => {
      try {
        if (pageSize !== TODOS) {
          const d = await pedir(page, pageSize);
          if (vigente()) { setRows(d.items); setTotal(d.total); }
          return;
        }
        // "Todos": primera tanda para saber el total, y el resto de a TANDA con
        // unas pocas peticiones en paralelo. Se pinta al terminar, en el orden del
        // servidor, para que el # de la fila sea el mismo del Excel.
        const primera = await pedir(1, TANDA);
        if (!vigente()) return;
        const paginas = Math.ceil(primera.total / TANDA);
        const trozos: Row[][] = [primera.items];
        let hechas = primera.items.length;
        setCargadas(hechas);
        for (let pg = 2; pg <= paginas; pg += EN_PARALELO) {
          const lote = Array.from({ length: Math.min(EN_PARALELO, paginas - pg + 1) }, (_, k) => pedir(pg + k, TANDA));
          for (const d of await Promise.all(lote)) { trozos.push(d.items); hechas += d.items.length; }
          if (!vigente()) return;
          setCargadas(hechas);
        }
        setRows(trozos.flat());
        setTotal(primera.total);
      } catch {
        if (vigente()) { setRows([]); setTotal(0); }
      } finally {
        if (vigente()) setLoading(false);
      }
    })();
  }, [authFetch, sede, filtrosQs, page, pageSize]);
  useEffect(() => { if (!authLoading && sede) load(); }, [authLoading, sede, load]);

  // Al cambiar filtro u orden se vuelve a la página 1 y se suelta la selección:
  // marcados de un filtro anterior dirían "12 seleccionados" señalando a gente que
  // ya no está en la lista. Cambiar de PÁGINA no la suelta (ver `sel`).
  useEffect(() => { setPage(1); setSel(new Set()); setAllMatching(false); }, [filtrosQs]);

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

  // La casilla de la cabecera marca/desmarca ESTA página, sin tocar lo marcado en otras.
  const allChecked = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const toggleAll = () => {
    setAllMatching(false);
    setSel((s) => { const n = new Set(s); for (const r of rows) { if (allChecked) n.delete(r.id); else n.add(r.id); } return n; });
  };
  const toggle = (id: string) => { setAllMatching(false); setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); };

  // Cantidad efectiva sobre la que se opera y el filtro (para el modo "todos los que cumplen").
  const count = allMatching ? total : sel.size;
  const filter = () => ({
    status: status || undefined, branchId: sede?.id || undefined, search: search || undefined,
    servicio: servicio || undefined, cuenta: cuenta || undefined, deuda: deuda || undefined, tecnologia: tecnologia || undefined,
  });

  async function runBatch(kind: "cut" | "reconnect") {
    const tv = servicioOp === "tv";
    const titulo = `${kind === "cut" ? "Cortando" : "Reconectando"} ${tv ? "la TV" : "internet"}`;
    setBusy(true);
    setConfirmCut(false);
    detener.current = false;
    try {
      // 1. A quiénes. Con "todos los que cumplen el filtro" se le piden los ids al
      //    servidor (mismo filtro y misma sede que el lote), para poder contarlos.
      let ids: string[];
      if (allMatching) {
        const r = await authFetch("/subscribers/bulk/ids", { method: "POST", body: JSON.stringify(filter()) });
        const d = await r.json();
        if (!r.ok) { toast(d?.message ?? "Error", "x"); return; }
        ids = d.ids ?? [];
      } else {
        ids = [...sel];
      }
      if (!ids.length) { toast("No hay clientes para operar.", "x"); return; }

      // 2. Por tandas, una detrás de otra, pintando el avance.
      const tam = tv ? TANDA_TV : TANDA_INTERNET;
      const inicio = Date.now();
      setProgreso({ titulo, hechos: 0, total: ids.length, inicio, deteniendo: false });
      let accInternet: RespInternet = {};
      let accTv: RespTv = {};
      let hechos = 0;
      let fallosDeTanda = 0;
      for (let i = 0; i < ids.length; i += tam) {
        if (detener.current) break;
        const trozo = ids.slice(i, i + tam);
        let url: string;
        if (tv) {
          const accion = kind === "cut" ? "tv-cut" : "tv-restore";
          url = allMatching ? `/subscribers/bulk/${accion}` : `/network/genieacs/${accion}-subscribers`;
        } else {
          url = allMatching ? `/subscribers/bulk/${kind}` : `/network/${kind}-batch`;
        }
        const body = allMatching ? { ...filter(), ids: trozo, tanda: true } : { ids: trozo, tanda: true };
        let d: any;
        try {
          const res = await authFetch(url, { method: "POST", body: JSON.stringify(body) });
          d = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(d?.message ?? `Error ${res.status}`);
        } catch (e) {
          // Una tanda que falla no tumba el lote: sus clientes salen en el parte con el
          // motivo y se sigue con la siguiente.
          fallosDeTanda++;
          const detalle = `No se pudo procesar esta tanda: ${(e as Error).message}`;
          d = tv
            ? { total: trozo.length, failed: trozo.length, results: trozo.map((id) => ({ subscriberId: id, via: "error", ok: false, detail: detalle })) }
            : { total: trozo.length, results: trozo.map((id) => ({ subscriberId: id, ok: false, error: detalle })) };
        }
        if (tv) accTv = juntarTv(accTv, d); else accInternet = juntarInternet(accInternet, d);
        hechos += trozo.length;
        setProgreso((p) => (p ? { ...p, hechos } : p));
      }

      // 3. El parte de todo lo que se alcanzó a hacer.
      const parte = tv ? parteDeTv(accTv, kind) : parteDeInternet(accInternet, kind);
      if (hechos < ids.length) {
        parte.resumen = `Detenido a mano: se procesaron ${hechos} de ${ids.length}. ` + parte.resumen;
      }
      if (fallosDeTanda) {
        parte.resumen += ` ${fallosDeTanda} ${fallosDeTanda === 1 ? "tanda falló" : "tandas fallaron"}: sus clientes salen abajo con el motivo.`;
      }
      setParte(parte);
      setSel(new Set()); setAllMatching(false);
      load();
    } catch (e) { toast((e as Error).message, "x"); }
    finally { setBusy(false); setProgreso(null); }
  }

  /**
   * Excel de lo que hay en pantalla. Va contra el mismo endpoint que el listado de
   * clientes, así que el archivo respeta el filtro completo (sede, deuda, estado…) y
   * no solo la página cargada. Trae las columnas de conexión —usuario PPPoE,
   * IP remota y perfil—, que es lo que se necesita para ir a buscarlos al router.
   *
   * Y sale en el MISMO orden de la tabla: `filtrosQs()` mete el `sortBy`/`sortDir`
   * que pide la cabecera, así que la fila 1 del archivo es la fila 1 de la pantalla
   * (el archivo sigue después con las de las páginas siguientes).
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
            <option value="debe">Debe (más de $20.000)</option>
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
                la factura abierta debiendo cuatro pesos). Por eso todas llevan
                un piso: quien debe $20.000 o menos no sale (DEUDA_MINIMA en
                subscribers.service.ts). */}
            <option value="fija">Debe una mensualidad o más YA VENCIDA (más de $20.000)</option>
            <option value="1">Tiene 1 factura sin pagar (debe más de $20.000)</option>
            {/* La escalera de la cartera: 1 = va al día del mes que corre, 2 = está en
                compromiso, más de 2 = Cartera. "Compromiso" aquí es la definición de la
                operación (debe dos meses seguidos COMPLETOS), no la marca
                `status = COMPROMISO`, que está desfasada: la llevan 75 en Yopal y solo
                8 deben de verdad dos. Lo de "completas" no es un matiz: sin eso entra
                el que abonó casi todo y quedó debiendo $10.750, o el que "debe dos"
                y una es el prorrateo de $3.484 de su mes de instalación. Completa =
                la mensualidad entera de su plan, sin un peso abonado. */}
            <option value="compromiso">Debe 2 mensualidades completas: este mes + el pasado (compromiso)</option>
            <option value="gt2">Tiene más de 2 facturas sin pagar (debe más de $20.000)</option>
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
          <span>Seleccionaste los {rows.length} de esta página{sel.size > rows.length ? ` (${sel.size} en total)` : ""}.</span>
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
                  la página cargada, no el de la sede. Para la deuda está el filtro. */}
              <th className="py-2 pr-3 font-medium">Internet</th>
              <th className="py-2 pr-3 font-medium">TV</th>
              <th className="py-2 pr-3 font-medium"><BotonOrden t={th} clave="phone">Teléfono</BotonOrden></th>
              <th className="py-2 pr-3 font-medium"><BotonOrden t={th} clave="status">Estado</BotonOrden></th>
              <th className="py-2 pr-3 text-right font-medium">Debe</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="py-6 text-center text-text-tertiary">
                Cargando…{pageSize === TODOS && cargadas > 0 ? ` ${cargadas.toLocaleString("es-CO")} clientes` : ""}
              </td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="py-6 text-center text-text-tertiary">Sin clientes para este filtro.</td></tr>
            ) : rows.map((r, i) => (
              <tr key={r.id} className={`border-b border-border-subtle/60 ${sel.has(r.id) ? "bg-brand-soft/40" : ""}`}>
                <td className="py-1.5 pl-3"><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
                <td className="py-1.5 pr-5 text-right tabular-nums text-text-tertiary">{(page - 1) * pageSize + i + 1}</td>
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
      {total > 0 && (
        <Pagination
          meta={pageSize === TODOS
            ? { page: 1, pageSize: Math.max(total, 1), total, pageCount: 1 }
            : { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) }}
          onPage={setPage}
          onPageSize={(n) => { setPageSize(n); setPage(1); }}
          conTodos
          esTodos={pageSize === TODOS}
        />
      )}

      {/* Confirmar corte */}
      <Modal open={confirmCut} onClose={() => setConfirmCut(false)} title={servicioOp === "tv" ? "Confirmar corte de TV masivo" : "Confirmar corte masivo"}>
        <p className="text-[13px] text-text-secondary">
          {servicioOp === "tv"
            ? tvSoloSistema
              ? <>Se marcará la <b>TV como cortada</b> en el sistema a <b>{count}</b> clientes de <b>{sede.name}</b>, con su orden de corte creada y cerrada. <b>El TR-069 está en pausa: no se toca ningún equipo</b>, el corte en la red se hace a mano.</>
              : <>Se apagará la <b>señal de TV</b> de <b>{count}</b> clientes de <b>{sede.name}</b>. El sistema resuelve el equipo de cada uno (CPE TR-069 o puerto CATV en la OLT); los que no tengan equipo identificable quedan reportados sin tocar.</>
            : <>Se cortará el servicio de <b>{count}</b> clientes de <b>{sede.name}</b> en el Mikrotik.</>}
          {count > 200 ? " Va por tandas: verás el avance mientras corre." : ""} ¿Continuar?
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

      {/* Avance del lote en curso. No se cierra solo: cuando termina lo reemplaza el parte. */}
      <Modal open={!!progreso} onClose={() => {}} title={progreso?.titulo ?? ""}>
        {progreso && (() => {
          const pct = progreso.total ? Math.round((progreso.hechos / progreso.total) * 100) : 0;
          const transcurrido = Date.now() - progreso.inicio;
          const restante = progreso.hechos > 0 ? (transcurrido / progreso.hechos) * (progreso.total - progreso.hechos) : null;
          return (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between text-[13px]">
                <span><b className="tabular-nums">{progreso.hechos.toLocaleString("es-CO")}</b> de <b className="tabular-nums">{progreso.total.toLocaleString("es-CO")}</b> clientes</span>
                <span className="font-semibold tabular-nums">{pct}%</span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-full bg-brand transition-all duration-300" style={{ width: `${Math.max(pct, 2)}%` }} />
              </div>
              <p className="text-[12px] text-text-tertiary">
                {progreso.deteniendo
                  ? "Deteniendo: se termina la tanda en curso y se para."
                  : <>Lleva {minutos(transcurrido)}{restante !== null ? ` · faltan unos ${minutos(restante)}` : ""}. No cierres esta pestaña.</>}
              </p>
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" disabled={progreso.deteniendo}
                  onClick={() => { detener.current = true; setProgreso((p) => (p ? { ...p, deteniendo: true } : p)); }}>
                  Detener
                </Button>
              </div>
            </div>
          );
        })()}
      </Modal>

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
