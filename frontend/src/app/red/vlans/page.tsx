"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input, Select, Field } from "@/components/ui/Field";
import { Combobox, type ComboItem } from "@/components/ui/Combobox";
import { DataTable } from "@/components/ui/DataTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import type { Vlan, BranchOpt, MapaOlt, PuertoOlt, SaludSede, SaludOlt, SaludVlan, ConfigurarVlanRes } from "@/lib/network";
import { useFiltrosEnUrl, useFiltrosRecordados } from "@/lib/useFiltrosUrl";
import { listaJson, mensajeDeError } from "@/lib/errores";

type Draft = { branchId: string; vlan: string; detail: string; olt: string; oltId: string; tray: string; oltPort: string };

const EMPTY: Draft = { branchId: "", vlan: "", detail: "", olt: "", oltId: "", tray: "", oltPort: "" };

/** Estado de la lectura en vivo de la(s) OLT de la sede. */
type Mapa = { olts: MapaOlt[] | null; cargando: boolean; error: string | null };

/**
 * La salud de las VLANs en los EQUIPOS (OLT creada + uplink + Mikrotik con
 * interfaz y PPPoE). Se lee después del mapa, que ya dejó cacheados los
 * service-ports: así la OLT no se lee dos veces a la vez.
 */
type Salud = { data: SaludSede | null; cargando: boolean; error: string | null };

/** Lo mínimo para configurar una VLAN en los equipos (una fila del catálogo o la recién creada). */
type VlanAConfigurar = { id: string; vlan: number; detail: string };

/**
 * El puerto de la OLT al que apunta una fila del catálogo. Las heredadas del
 * legacy no traen OLT ligada: si la sede tiene una sola, se entiende que es esa.
 */
function puertoDe(olts: MapaOlt[] | null, oltId: string | null, tray: number | null, port: number | null) {
  if (!olts || tray == null || port == null) return undefined;
  const olt = oltId ? olts.find((o) => o.id === oltId) : olts.length === 1 ? olts[0] : undefined;
  if (!olt || !olt.ok) return undefined;
  const tarjeta = olt.tarjetas.find((t) => t.slot === tray);
  return { olt, puerto: tarjeta?.puertos.find((p) => p.port === port) ?? null };
}

/**
 * La VLAN principal de un puerto (la de más abonados) y, si las hay, cuántas
 * más arrastra: "590" o "190 (+3 más)".
 */
const vlansTxt = (p: PuertoOlt) =>
  p.vlans.length ? `${p.vlans[0].vlan}${p.vlans.length > 1 ? ` (+${p.vlans.length - 1} más)` : ""}` : "";

/**
 * Clave con la que se agrupa un texto del legacy: en mayúsculas y sin espacios
 * de sobra. Sin esto "Rosales" y "ROSALES" son dos opciones distintas del mismo
 * barrio. Es la misma normalización que hace Postgres en `/network/nap-addresses`.
 */
const norm = (t: string) => t.trim().toUpperCase();

/**
 * Sede de las VLANs que el legacy dejó huérfanas (`sede` que ya no existe como
 * grupo). No son de nadie, pero tienen que poder verse: una VLAN invisible es
 * una VLAN que nadie arregla. Viaja como `sede=none`, igual que el "Sin VLAN"
 * del listado de NAPs.
 */
const SIN_SEDE = "none";

/**
 * Administración de VLANs (legacy `vlans`). Es el catálogo del que tira el alta
 * de caja NAP: hasta ahora sólo se podían ELEGIR las 153 importadas del legacy,
 * no crear una nueva. Ojo: esta tabla NO viaja en el sync con el legacy (igual
 * que NAPs y puertos), así que lo que se cree aquí vive sólo en nexus.
 *
 * Se entra POR SEDE, como las cajas NAP: primero las sedes con cuántas VLANs
 * tiene cada una y luego el catálogo de esa sede. Una VLAN sólo significa algo
 * dentro de su sede (el número 300 se repite en tres municipios), así que la
 * sede no es un filtro más de la barra sino el sitio donde se está.
 */
export default function VlansPage() {
  // `useFiltrosRecordados` usa `useSearchParams`, que en el App Router exige una
  // frontera de Suspense.
  return (
    <Suspense fallback={<PageSkeleton />}>
      <VlansConUrl />
    </Suspense>
  );
}

/**
 * De dónde arranca la pantalla: de la dirección (`?sede=…&q=…`), que es lo que
 * permite mandar el enlace de "las VLANs de Villanueva" o volver a ellas desde
 * el navegador. Entrando por el MENÚ se empieza siempre en la lista de sedes:
 * lo recordado de la última visita no se aplica aquí porque la sede es un sitio,
 * no un filtro, y caer dentro de una sede sin haberla pedido desorienta.
 */
function VlansConUrl() {
  const inicial = useFiltrosRecordados();
  if (!inicial) return <PageSkeleton />;
  return <Vlans urlInicial={inicial.recordado ? {} : inicial.valores} />;
}

function Vlans({ urlInicial }: { urlInicial: Record<string, string> }) {
  const { loading: authLoading, authFetch } = useAuth();
  const [branches, setBranches] = useState<BranchOpt[] | null>(null);
  /** VLANs sin sede (las huérfanas del legacy): sólo se enseña la fila si las hay. */
  const [huerfanas, setHuerfanas] = useState(0);
  const [sedeId, setSedeId] = useState(urlInicial.sede ?? "");
  const [err, setErr] = useState(false);

  const load = useCallback(() => {
    setErr(false);
    void authFetch("/network/branches").then(listaJson).then(setBranches).catch(() => setErr(true));
    void authFetch(`/network/vlans?branchId=${SIN_SEDE}`)
      .then(listaJson)
      .then((v: Vlan[]) => setHuerfanas(v.length))
      .catch(() => setHuerfanas(0));
  }, [authFetch]);

  useEffect(() => {
    if (!authLoading) load();
  }, [authLoading, load]);

  if (authLoading || (!branches && !err)) return <PageSkeleton />;
  if (!branches) return <LoadError message="No se pudieron cargar las sedes." onRetry={load} />;

  const sede =
    sedeId === SIN_SEDE
      ? { id: SIN_SEDE, name: "VLANs sin sede", naps: 0, vlans: huerfanas }
      : branches.find((b) => b.id === sedeId);

  // Vista B: el catálogo de la sede elegida.
  if (sede) {
    return (
      <VlansDeSede
        sede={sede}
        urlInicial={urlInicial}
        branches={branches}
        onBack={() => { setSedeId(""); load(); }}
      />
    );
  }

  // Vista A: elegir sede. (Una `?sede=` que ya no existe cae aquí sola.)
  return <SedesConVlans branches={branches} huerfanas={huerfanas} onPick={setSedeId} />;
}

/** Vista A: las sedes con cuántas VLANs y cuántas cajas NAP tiene cada una. */
function SedesConVlans({ branches, huerfanas, onPick }: { branches: BranchOpt[]; huerfanas: number; onPick: (id: string) => void }) {
  const [sedeSearch, setSedeSearch] = useState("");
  // En la lista de sedes no hay filtros puestos: la dirección queda limpia (y se
  // olvida el filtro guardado, que era de la sede de la que se acaba de salir).
  useFiltrosEnUrl({});

  const total = branches.reduce((a, b) => a + b.vlans, 0) + huerfanas;
  const list = sedeSearch.trim()
    ? branches.filter((b) => b.name.toLowerCase().includes(sedeSearch.trim().toLowerCase()))
    : branches;
  const filas: BranchOpt[] = sedeSearch.trim() || huerfanas === 0
    ? list
    : [...list, { id: SIN_SEDE, name: "Sin sede", naps: 0, vlans: huerfanas }];

  return (
    <>
      <PageHeading
        icon="network"
        title="VLANs"
        subtitle="Catálogo de VLANs por sede. De aquí salen las opciones al crear una caja NAP; una VLAN con NAPs colgando no se puede eliminar."
      />
      <div className="mb-3 flex items-end justify-between gap-2">
        <div>
          <h1 className="text-[18px] font-bold text-text-primary">VLANs por sede</h1>
          <p className="text-[12px] text-text-tertiary">
            {total.toLocaleString("es-CO")} VLANs en {branches.length} sedes · elige una sede
          </p>
        </div>
        <div className="relative w-56">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder="Buscar sede…" value={sedeSearch} onChange={(e) => setSedeSearch(e.target.value)} />
        </div>
      </div>

      <DataTable
        rows={filas}
        empty="Sin sedes."
        onRowClick={(b) => onPick(b.id)}
        columns={[
          { key: "name", header: "Sede", sortable: true, render: (b) => (
            <span className="flex items-center gap-2.5">
              <span className={`flex h-7 w-7 items-center justify-center rounded-md ${b.id === SIN_SEDE ? "bg-surface-2 text-text-tertiary" : "bg-brand-soft text-brand"}`}>
                <Icon name={b.id === SIN_SEDE ? "help-circle" : "landmark"} size={15} />
              </span>
              <span className="font-semibold text-text-primary">{b.name}</span>
              {b.id === SIN_SEDE && <span className="text-[11px] text-text-tertiary">heredadas del legacy</span>}
            </span>
          ) },
          { key: "vlans", header: "VLANs", align: "right", render: (b) => <span className="font-mono font-semibold">{b.vlans.toLocaleString("es-CO")}</span> },
          { key: "naps", header: "Cajas NAP", align: "right", render: (b) => (
            b.id === SIN_SEDE ? <span className="text-text-tertiary">—</span> : <span className="font-mono text-text-tertiary">{b.naps.toLocaleString("es-CO")}</span>
          ) },
          { key: "go", header: "", align: "right", render: () => <Icon name="chevron-right" size={16} className="text-text-tertiary" /> },
        ]}
      />
    </>
  );
}

/** Vista B: el catálogo de una sede, con su buscador y sus filtros. */
function VlansDeSede({
  sede, urlInicial, branches, onBack,
}: {
  sede: BranchOpt;
  urlInicial: Record<string, string>;
  branches: BranchOpt[];
  onBack: () => void;
}) {
  const { authFetch } = useAuth();
  const [vlans, setVlans] = useState<Vlan[] | null>(null);
  const [err, setErr] = useState(false);
  const [search, setSearch] = useState(urlInicial.q ?? "");
  const [detalle, setDetalle] = useState(urlInicial.barrio ?? "");
  const [olt, setOlt] = useState(urlInicial.olt ?? "");
  const [editing, setEditing] = useState<Vlan | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmar, setConfirmar] = useState<Vlan | null>(null);
  const [borrando, setBorrando] = useState(false);
  const [mapa, setMapa] = useState<Mapa>({ olts: null, cargando: false, error: null });
  const [salud, setSalud] = useState<Salud>({ data: null, cargando: false, error: null });
  const [configurando, setConfigurando] = useState<VlanAConfigurar | null>(null);

  // La sede va en la dirección junto con los filtros: así el enlace lleva a lo
  // que se está mirando y el "Volver" de una ficha devuelve aquí, no al índice.
  useFiltrosEnUrl({ sede: sede.id, q: search.trim(), barrio: detalle, olt });

  const load = useCallback(() => {
    setErr(false);
    void authFetch(`/network/vlans?branchId=${sede.id}`).then(listaJson).then(setVlans).catch(() => setErr(true));
  }, [authFetch, sede.id]);

  useEffect(() => { load(); }, [load]);

  /**
   * La OLT de la sede, leída en vivo: tarjetas, puertos y la VLAN que usa cada
   * uno. Es lo que llena los desplegables del formulario y contra lo que se
   * contrasta cada fila del catálogo. El servidor la guarda 10 min; "Releer"
   * la pide de nuevo al equipo.
   */
  const cargarMapa = useCallback((refresh = false): Promise<MapaOlt[] | null> => {
    if (sede.id === SIN_SEDE) { setMapa({ olts: [], cargando: false, error: null }); return Promise.resolve([]); }
    setMapa((m) => ({ ...m, cargando: true, error: null }));
    return authFetch(`/network/vlans/olt-mapa?branchId=${sede.id}${refresh ? "&refresh=1" : ""}`)
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.message || "No se pudo leer la OLT");
        const olts = (d?.olts ?? []) as MapaOlt[];
        setMapa({ olts, cargando: false, error: null });
        return olts;
      })
      .catch((e) => { setMapa({ olts: null, cargando: false, error: mensajeDeError(e, "No se pudo leer la OLT") }); return null; });
  }, [authFetch, sede.id]);

  /**
   * Salud en los equipos. `vlans` relee las VLANs de la OLT y los Mikrotik sin
   * volver a pedir los service-ports (que acaba de leer el mapa).
   */
  const cargarSalud = useCallback((refresh?: "vlans") => {
    if (sede.id === SIN_SEDE) return;
    setSalud((x) => ({ ...x, cargando: true, error: null }));
    void authFetch(`/network/vlans/salud?branchId=${sede.id}${refresh ? `&refresh=${refresh}` : ""}`)
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.message || "No se pudieron revisar los equipos");
        setSalud({ data: d as SaludSede, cargando: false, error: null });
      })
      .catch((e) => setSalud((x) => ({ ...x, cargando: false, error: mensajeDeError(e, "No se pudieron revisar los equipos") })));
  }, [authFetch, sede.id]);

  const releer = useCallback(() => {
    void cargarMapa(true).then((olts) => { if (olts?.some((o) => o.ok)) cargarSalud("vlans"); });
  }, [cargarMapa, cargarSalud]);

  useEffect(() => {
    void cargarMapa().then((olts) => { if (olts?.some((o) => o.ok)) cargarSalud(); });
  }, [cargarMapa, cargarSalud]);

  /** Fila de salud de cada VLAN del catálogo (por id). */
  const saludPorVlan = useMemo(() => {
    const m = new Map<string, { olt: SaludOlt; fila: SaludVlan }>();
    for (const o of salud.data?.olts ?? []) for (const f of o.filas) for (const c of f.catalogo) m.set(c.id, { olt: o, fila: f });
    return m;
  }, [salud.data]);

  /**
   * VLANs con clientes rotas en los equipos que el catálogo NO tiene: no salen
   * en la tabla, así que se enseñan arriba (la 102 de Villanueva, por ejemplo).
   */
  const rotasFuera = useMemo(
    () => (salud.data?.olts ?? []).flatMap((o) => o.filas.filter((f) => !f.catalogo.length && f.estado === "ROTA").map((f) => ({ olt: o, fila: f }))),
    [salud.data],
  );

  /**
   * Puertos que en la OLT YA dan servicio y que el catálogo no tiene. Son los
   * huecos que dejan al primer técnico de un puerto sin poder autenticar
   * cuando el puerto se vacía, y los que conviene llenar primero.
   */
  const faltantes = useMemo(() => {
    const out: { olt: MapaOlt; slot: number; puerto: PuertoOlt }[] = [];
    for (const olt of mapa.olts ?? []) {
      if (!olt.ok) continue;
      for (const t of olt.tarjetas) {
        for (const p of t.puertos) {
          if (p.servicios === 0 || !p.vlans.length) continue;
          const enCatalogo = (vlans ?? []).some((v) =>
            v.tray === t.slot && v.oltPort === p.port && (v.oltId === olt.id || (!v.oltId && (mapa.olts?.length ?? 0) === 1)));
          if (!enCatalogo) out.push({ olt, slot: t.slot, puerto: p });
        }
      }
    }
    return out;
  }, [mapa.olts, vlans]);

  /**
   * Dónde está cada VLAN según la OLT: los puertos de los que es la PRINCIPAL.
   * El catálogo heredado tiene la bandeja corrida en varias sedes (en Monterrey
   * la "bandeja 0" del legacy es el slot 1 de la OLT), y con esto cada fila que
   * no casa puede ofrecer su sitio real.
   */
  const dondeEsPrincipal = useMemo(() => {
    const m = new Map<number, { olt: MapaOlt; slot: number; port: number }[]>();
    for (const olt of mapa.olts ?? []) {
      if (!olt.ok) continue;
      for (const t of olt.tarjetas) for (const p of t.puertos) {
        const v = p.vlans[0]?.vlan;
        if (v != null) m.set(v, [...(m.get(v) ?? []), { olt, slot: t.slot, port: p.port }]);
      }
    }
    return m;
  }, [mapa.olts]);

  const [corrigiendo, setCorrigiendo] = useState<string | null>(null);
  async function corregirConOlt(v: Vlan, a: { olt: MapaOlt; slot: number; port: number }) {
    setCorrigiendo(v.id);
    try {
      const res = await authFetch(`/network/vlans/${v.id}`, {
        method: "PATCH",
        body: JSON.stringify({ branchId: v.branchId, vlan: v.vlan, detail: v.detail || "—", oltId: a.olt.id, tray: a.slot, oltPort: a.port }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "No se pudo corregir");
      toast(`VLAN ${v.vlan} → ${a.olt.name} 0/${a.slot}/${a.port}`, "check");
      load();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo corregir la VLAN"), "alert-circle");
    } finally {
      setCorrigiendo(null);
    }
  }

  function agregarDesdeOlt(f: { olt: MapaOlt; slot: number; puerto: PuertoOlt }) {
    setEditing(null);
    setDraft({
      ...EMPTY, branchId: sede.id, oltId: f.olt.id, olt: f.olt.name,
      tray: String(f.slot), oltPort: String(f.puerto.port), vlan: String(f.puerto.vlans[0]?.vlan ?? ""),
    });
  }

  // Las VLANs de una sede caben de sobra en memoria (55 la que más): el filtro y
  // el buscador van en el cliente y responden sin viaje al servidor.
  const deLaSede = useMemo(() => vlans ?? [], [vlans]);

  // El detalle de la VLAN es el BARRIO, y viene del legacy escrito de varias
  // formas (mayúsculas y espacios sueltos). Se agrupa normalizado, igual que las
  // direcciones de las NAPs, para que un barrio sea UNA opción y no tres.
  const barrios = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of deLaSede) {
      const k = norm(v.detail);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [deLaSede]);

  const itemsBarrio = useMemo<ComboItem[]>(
    () => [
      { value: "", label: "Todos los barrios" },
      ...barrios.map(([value, n]) => ({ value, label: value, sublabel: `${n} VLAN${n === 1 ? "" : "s"}` })),
    ],
    [barrios],
  );

  /** OLTs presentes, más la opción de pescar las que no tienen ninguna puesta. */
  const olts = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of deLaSede) {
      const k = norm(v.olt ?? "");
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [deLaSede]);

  const filtradas = useMemo(() => {
    const q = search.trim().toLowerCase();
    return deLaSede.filter((v) =>
      (!detalle || norm(v.detail) === detalle) &&
      (!olt || (olt === "none" ? !norm(v.olt ?? "") : norm(v.olt ?? "") === olt)) &&
      (!q || String(v.vlan).includes(q) || v.detail.toLowerCase().includes(q) || (v.olt ?? "").toLowerCase().includes(q)),
    );
  }, [deLaSede, search, detalle, olt]);

  const filtrosActivos = useMemo(
    () => [detalle, olt].filter(Boolean).length + (search.trim() ? 1 : 0),
    [detalle, olt, search],
  );

  function limpiar() {
    setSearch(""); setDetalle(""); setOlt("");
  }

  function openNew() {
    setEditing(null);
    // Nace en la sede que se está mirando; las huérfanas no son sede donde crear.
    const unica = mapa.olts?.length === 1 ? mapa.olts[0] : null;
    setDraft({ ...EMPTY, branchId: sede.id === SIN_SEDE ? "" : sede.id, oltId: unica?.id ?? "", olt: unica?.name ?? "" });
  }

  function openEdit(v: Vlan) {
    setEditing(v);
    setDraft({
      branchId: v.branchId ?? "", vlan: String(v.vlan), detail: v.detail,
      olt: v.olt ?? "",
      // Las heredadas no traen OLT ligada: con una sola OLT en la sede se propone esa.
      oltId: v.oltId ?? (mapa.olts?.length === 1 ? mapa.olts[0].id : ""),
      tray: v.tray != null ? String(v.tray) : "", oltPort: v.oltPort != null ? String(v.oltPort) : "",
    });
  }

  async function remove(v: Vlan) {
    setBorrando(true);
    try {
      const res = await authFetch(`/network/vlans/${v.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "No se pudo eliminar la VLAN");
      toast(`VLAN ${v.vlan} eliminada`, "check");
      load();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo eliminar la VLAN"), "alert-circle");
    } finally {
      setBorrando(false);
      setConfirmar(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-default text-text-secondary hover:bg-surface-2" title="Volver a sedes">
            <Icon name="arrow-left" size={16} />
          </button>
          <div>
            <h1 className="flex items-center gap-2 text-[18px] font-bold text-text-primary">
              <Icon name={sede.id === SIN_SEDE ? "help-circle" : "landmark"} size={18} className="text-brand" /> {sede.name}
            </h1>
            <p className="text-[12px] text-text-tertiary">
              {vlans
                ? filtrosActivos > 0
                  ? `${filtradas.length.toLocaleString("es-CO")} de ${vlans.length.toLocaleString("es-CO")} VLANs con estos filtros`
                  : `${vlans.length.toLocaleString("es-CO")} VLANs en esta sede`
                : "VLANs"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {sede.id !== SIN_SEDE && (
            <Button variant="ghost" size="sm" disabled={mapa.cargando || salud.cargando} onClick={releer} title="Volver a leer tarjetas, puertos y VLANs de la OLT, y los Mikrotik de la sede">
              <Icon name="refresh-cw" size={14} className={mapa.cargando ? "animate-spin" : ""} /> {mapa.cargando ? "Leyendo OLT…" : "Releer OLT"}
            </Button>
          )}
          <Button onClick={openNew}><Icon name="plus" size={15} /> Nueva VLAN</Button>
        </div>
      </div>

      <EstadoOlt mapa={mapa} />
      <EstadoSalud salud={salud} />

      {rotasFuera.length > 0 && (
        <div className="rounded-xl border border-border-subtle bg-error-soft p-3">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-error-text">
            <Icon name="alert-triangle" size={15} />
            {rotasFuera.length} VLAN{rotasFuera.length === 1 ? "" : "s"} con clientes que no llega{rotasFuera.length === 1 ? "" : "n"} al PPPoE y no está{rotasFuera.length === 1 ? "" : "n"} en el catálogo
          </p>
          <ul className="mt-1 space-y-0.5 text-[12px] text-text-secondary">
            {rotasFuera.map(({ olt: o, fila: f }) => (
              <li key={`${o.id}-${f.vlan}`}>
                <b className="font-mono text-text-primary">{f.vlan}</b> · {o.name} · {f.servicePorts} service-port{f.servicePorts === 1 ? "" : "s"}
                {f.pon.principal.length ? ` en ${f.pon.principal.join(", ")}` : f.pon.otros.length ? ` repartidos en ${f.pon.otros.length} PON` : ""}: {f.falta.join("; ")}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-text-tertiary">Para configurarla en los equipos, créela primero en el catálogo.</p>
        </div>
      )}

      {faltantes.length > 0 && (
        <div className="rounded-xl border border-border-subtle bg-warning-soft p-3">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-warning-text">
            <Icon name="alert-triangle" size={15} />
            {faltantes.length} puerto{faltantes.length === 1 ? "" : "s"} de la OLT dan servicio y no están en el catálogo
          </p>
          <p className="mt-0.5 text-[12px] text-text-secondary">
            Si uno de estos puertos se queda sin abonados, el primer técnico que instale ahí no podrá autenticar. Pulse uno para agregarlo con la VLAN que usa la OLT.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {faltantes.map((f) => (
              <button
                key={`${f.olt.id}-${f.slot}-${f.puerto.port}`}
                type="button"
                onClick={() => agregarDesdeOlt(f)}
                className="tap rounded-md border border-border-default bg-surface px-2 py-1 font-mono text-[12px] text-text-primary hover:border-brand hover:text-brand"
                title={`${f.puerto.servicios} servicio(s) en la OLT ${f.olt.name}`}
              >
                0/{f.slot}/{f.puerto.port} · VLAN {vlansTxt(f.puerto)}
              </button>
            ))}
          </div>
        </div>
      )}

      {err && !vlans ? (
        <LoadError message="No se pudieron cargar las VLANs." onRetry={load} />
      ) : !vlans ? (
        <PageSkeleton />
      ) : (
        <>
          <ListToolbar
            search={search}
            onSearch={setSearch}
            searchPlaceholder="Buscar por VLAN, detalle u OLT…"
            actions={filtrosActivos > 0 ? (
              <Button variant="ghost" size="sm" onClick={limpiar} title="Quitar todos los filtros">
                <Icon name="x" size={14} /> Limpiar ({filtrosActivos})
              </Button>
            ) : undefined}
          >
            {/* El detalle ES el barrio: en combobox porque son ~100 y lo que se
                hace es teclear tres letras, no bajar por la lista. */}
            <Combobox
              items={itemsBarrio}
              value={detalle}
              onChange={setDetalle}
              placeholder="Todos los barrios"
              emptyText="Ningún barrio coincide."
              icon="map-pin"
              className="w-full sm:w-52"
            />
            <Select value={olt} onChange={(e) => setOlt(e.target.value)} className="w-full sm:w-44" aria-label="Filtrar por OLT">
              <option value="">Todas las OLT</option>
              <option value="none">Sin OLT asignada</option>
              {olts.map(([v, n]) => <option key={v} value={v}>{v} ({n})</option>)}
            </Select>
          </ListToolbar>

          <DataTable
            rows={filtradas}
            empty={filtrosActivos > 0 ? "Ninguna VLAN coincide con los filtros." : "Esta sede aún no tiene VLANs."}
            columns={[
              { key: "vlan", header: "VLAN", sortable: true, align: "right", render: (v) => <span className="font-mono font-semibold text-text-primary">{v.vlan}</span> },
              { key: "detail", header: "Detalle", sortable: true, render: (v) => <span className="text-text-primary">{v.detail || <span className="text-text-tertiary">Sin detalle</span>}</span> },
              { key: "olt", header: "OLT", sortable: true, render: (v) => <span className="text-text-secondary">{v.olt || "—"}</span> },
              { key: "tray", header: "Bandeja", sortable: true, align: "right", render: (v) => <span className="font-mono text-text-secondary">{v.tray ?? "—"}</span> },
              { key: "oltPort", header: "Puerto OLT", sortable: true, align: "right", render: (v) => <span className="font-mono text-text-secondary">{v.oltPort ?? "—"}</span> },
              { key: "enOlt", header: "En la OLT", render: (v) => {
                const estado = estadoEnOlt(v, mapa);
                // Si no casa y la OLT dice sin ambigüedad dónde vive esa VLAN, se ofrece.
                const sitios = estado === "coincide" ? [] : (dondeEsPrincipal.get(v.vlan) ?? []);
                const sitio = sitios.length === 1 ? sitios[0] : null;
                return (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <EnLaOlt v={v} mapa={mapa} />
                    {sitio && (
                      <button
                        type="button"
                        disabled={corrigiendo === v.id}
                        onClick={(e) => { e.stopPropagation(); void corregirConOlt(v, sitio); }}
                        className="tap rounded-md border border-border-default px-1.5 py-0.5 font-mono text-[11px] text-brand hover:bg-brand-soft disabled:opacity-50"
                        title={`En la OLT ${sitio.olt.name} la VLAN ${v.vlan} es la principal del puerto 0/${sitio.slot}/${sitio.port}. Pulsar para corregir la bandeja y el puerto.`}
                      >
                        {corrigiendo === v.id ? "Corrigiendo…" : `Está en 0/${sitio.slot}/${sitio.port} · corregir`}
                      </button>
                    )}
                  </div>
                );
              } },
              { key: "enEquipos", header: "En equipos", render: (v) => (
                <EnEquipos
                  v={v}
                  s={saludPorVlan.get(v.id) ?? null}
                  salud={salud}
                  onConfigurar={() => setConfigurando({ id: v.id, vlan: v.vlan, detail: v.detail })}
                />
              ) },
              { key: "naps", header: "NAPs", sortable: true, align: "right", render: (v) => v.naps > 0 ? <Badge tone="info" label={String(v.naps)} /> : <span className="text-text-tertiary">0</span> },
              {
                key: "acciones", header: "", align: "right", render: (v) => (
                  <div className="flex items-center justify-end gap-1">
                    <button type="button" onClick={() => openEdit(v)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" title="Editar">
                      <Icon name="pencil" size={15} />
                    </button>
                    <button type="button" onClick={() => setConfirmar(v)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-error-soft hover:text-error-text" title="Eliminar">
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                ),
              },
            ]}
          />
        </>
      )}

      {draft && (
        <VlanModal
          draft={draft}
          setDraft={setDraft}
          editing={editing}
          branches={branches}
          vlans={vlans ?? []}
          mapa={mapa}
          onClose={() => { setDraft(null); setEditing(null); }}
          onSaved={(creada) => {
            setDraft(null); setEditing(null); load();
            // "Configurarla también en los equipos": primero el dry-run, luego confirmar.
            if (creada) setConfigurando(creada);
          }}
        />
      )}

      {configurando && (
        <ConfigurarEquiposModal
          vlan={configurando}
          onClose={() => setConfigurando(null)}
          onHecho={() => cargarSalud("vlans")}
        />
      )}

      {confirmar && (
        <ConfirmDialog
          open
          busy={borrando}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void remove(confirmar)}
          tone="danger"
          icon="trash"
          title={`Eliminar VLAN ${confirmar.vlan}`}
          confirmLabel="Eliminar VLAN"
          message={
            confirmar.naps > 0 ? (
              <>
                Esta VLAN todavía tiene <b>{confirmar.naps} caja(s) NAP</b> colgando,
                así que el sistema rechazará el borrado. Mueve esas NAPs a otra VLAN antes de eliminarla.
              </>
            ) : (
              <>
                La VLAN <b>{confirmar.vlan}{confirmar.detail ? ` · ${confirmar.detail}` : ""}</b> desaparece del
                catálogo y dejará de poder elegirse al crear cajas NAP. No se puede deshacer.
              </>
            )
          }
        />
      )}
    </div>
  );
}

/** Una línea sobre la lectura de la OLT: leyendo, falló, o de cuándo es. */
function EstadoOlt({ mapa }: { mapa: Mapa }) {
  if (mapa.cargando && !mapa.olts) {
    return (
      <p className="flex items-center gap-1.5 text-[12px] text-text-tertiary">
        <Icon name="refresh-cw" size={13} className="animate-spin" /> Leyendo tarjetas, puertos y VLANs de la OLT… (la primera vez tarda unos 20 s)
      </p>
    );
  }
  if (mapa.error) return <p className="text-[12px] text-error-text">No se pudo leer la OLT: {mapa.error}</p>;
  if (!mapa.olts) return null;
  if (mapa.olts.length === 0) {
    return <p className="text-[12px] text-text-tertiary">Esta sede no tiene OLT registrada: la bandeja y el puerto no se pueden elegir. Se registra en Red › OLT.</p>;
  }
  return (
    <p className="text-[12px] text-text-tertiary">
      {mapa.olts.map((o) => (
        <span key={o.id} className="mr-3">
          <Icon name="network" size={12} className="mr-1 inline" />
          <b className="text-text-secondary">{o.name}</b>{" "}
          {o.ok
            ? <>· {o.tarjetas.length} tarjeta{o.tarjetas.length === 1 ? "" : "s"} PON · leída {o.leidoEn ? new Date(o.leidoEn).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }) : ""}</>
            : <span className="text-error-text">· no responde ({o.error})</span>}
        </span>
      ))}
    </p>
  );
}

type EstadoEnOlt = "sin-puerto" | "sin-lectura" | "no-existe" | "sin-abonados" | "coincide" | "otra";

/**
 * Contraste de una fila del catálogo con la OLT. Casi todos los PON arrastran
 * VLANs ajenas (abonados trasladados que conservaron la suya): lo que cuenta es
 * la PRINCIPAL, que es la que se le da al primer abonado de un puerto vacío.
 */
function estadoEnOlt(v: Vlan, mapa: Mapa): EstadoEnOlt {
  if (v.tray == null || v.oltPort == null) return "sin-puerto";
  const r = puertoDe(mapa.olts, v.oltId, v.tray, v.oltPort);
  if (!r) return "sin-lectura";
  if (!r.puerto) return "no-existe";
  if (r.puerto.servicios === 0) return "sin-abonados";
  return r.puerto.vlans[0].vlan === v.vlan ? "coincide" : "otra";
}

function EnLaOlt({ v, mapa }: { v: Vlan; mapa: Mapa }) {
  const e = estadoEnOlt(v, mapa);
  if (e === "sin-puerto") return <span className="text-text-tertiary">Sin puerto</span>;
  if (e === "sin-lectura") return <span className="text-text-tertiary">{mapa.cargando ? "…" : "—"}</span>;
  if (e === "no-existe") return <Badge tone="error" label="Ese puerto no existe" />;
  if (e === "sin-abonados") return <Badge tone="default" label="Puerto sin abonados" />;
  if (e === "coincide") return <Badge tone="success" label="Coincide" />;
  const r = puertoDe(mapa.olts, v.oltId, v.tray, v.oltPort)!;
  return <Badge tone="warning" label={`La OLT usa ${r.puerto!.vlans[0].vlan}`} />;
}

function VlanModal({
  draft, setDraft, editing, branches, vlans, mapa, onClose, onSaved,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  editing: Vlan | null;
  branches: BranchOpt[];
  vlans: Vlan[];
  mapa: Mapa;
  onClose: () => void;
  /** `creada` solo cuando se pidió configurarla en los equipos al crearla. */
  onSaved: (creada?: VlanAConfigurar) => void;
}) {
  const { authFetch } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Alta: dejarla también en la OLT y el Mikrotik (siempre pasando por el dry-run). */
  const [enEquipos, setEnEquipos] = useState(false);
  const [sugerida, setSugerida] = useState<{ vlan: number | null; motivo: string } | null>(null);

  // La sede sólo se puede mover mientras la VLAN esté vacía (el backend lo
  // rechaza igual): con NAPs colgando quedarían apuntando a otra sede.
  const sedeBloqueada = !!editing && editing.naps > 0;

  // Las OLT son las de la sede que se está mirando: el mapa se leyó para ella.
  // Si se cambia la sede en el formulario, ya no valen y se pide guardar sin puerto.
  const mismaSede = !editing || draft.branchId === (editing.branchId ?? "");
  const olts = mismaSede ? (mapa.olts ?? []) : [];
  const olt = olts.find((o) => o.id === draft.oltId) ?? null;
  const tarjeta = olt?.tarjetas.find((t) => String(t.slot) === draft.tray) ?? null;
  const puerto = tarjeta?.puertos.find((p) => String(p.port) === draft.oltPort) ?? null;
  /** Sin lectura de la OLT (no responde) se deja teclear bandeja y puerto como antes. */
  const aMano = !!olt && !olt.ok;

  // Aviso, no bloqueo: en los datos importados hay números repetidos dentro de
  // una misma sede (Monterrey tiene dos veces la 60 y la 120), así que se avisa
  // y decide quien opera. Sólo se mira contra las VLANs de la sede que se está
  // viendo, que son las que el listado tiene cargadas.
  const num = Number(draft.vlan);
  const repetida = Number.isInteger(num) && draft.branchId
    ? vlans.find((v) => v.id !== editing?.id && v.branchId === draft.branchId && v.vlan === num)
    : undefined;

  /** Lo que el catálogo ya dice de cada puerto de la tarjeta elegida. */
  const catalogoDe = (port: number) =>
    vlans.filter((v) => v.id !== editing?.id && v.tray === tarjeta?.slot && v.oltPort === port && (v.oltId === olt?.id || !v.oltId));

  const otraVlanEnOlt = puerto && puerto.vlans.length > 0 && draft.vlan && puerto.vlans[0].vlan !== num;

  // Puerto sin abonados: el número se SUGIERE por el patrón de la tarjeta
  // (Villanueva slot 2: 460 + puerto·10). Solo se sugiere; lo decide quien opera.
  const puertoVacio = !!olt?.ok && !!tarjeta && !!puerto && puerto.servicios === 0;
  useEffect(() => {
    setSugerida(null);
    if (!puertoVacio || !olt || !tarjeta || !puerto) return;
    let vivo = true;
    void authFetch(`/network/vlans/sugerir?oltId=${olt.id}&slot=${tarjeta.slot}&port=${puerto.port}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (vivo && d) setSugerida(d); })
      .catch(() => undefined);
    return () => { vivo = false; };
  }, [authFetch, puertoVacio, olt, tarjeta, puerto]);

  function elegirPuerto(valor: string) {
    const p = tarjeta?.puertos.find((x) => String(x.port) === valor);
    // Si el número aún está en blanco, se trae el que usa la OLT en ese puerto.
    setDraft({ ...draft, oltPort: valor, vlan: draft.vlan || (p?.vlans[0] ? String(p.vlans[0].vlan) : "") });
  }

  async function save() {
    setErr(null);
    if (!draft.branchId) { setErr("Elige la sede a la que pertenece la VLAN."); return; }
    if (!Number.isInteger(num) || num < 1 || num > 4094) { setErr("El número de VLAN debe estar entre 1 y 4094."); return; }
    if (!draft.detail.trim()) { setErr("Escribe un detalle (el barrio o sector que atiende)."); return; }
    const tray = draft.tray.trim() ? Number(draft.tray) : undefined;
    const oltPort = draft.oltPort.trim() ? Number(draft.oltPort) : undefined;
    if (tray !== undefined && !Number.isInteger(tray)) { setErr("La bandeja debe ser un número entero."); return; }
    if (oltPort !== undefined && !Number.isInteger(oltPort)) { setErr("El puerto de OLT debe ser un número entero."); return; }
    if ((tray === undefined) !== (oltPort === undefined)) { setErr("Elige la bandeja y el puerto, o ninguno de los dos."); return; }

    setBusy(true);
    try {
      const body = JSON.stringify({
        branchId: draft.branchId, vlan: num, detail: draft.detail.trim(),
        oltId: draft.oltId || undefined,
        // Sin OLT elegida se conserva el texto heredado del legacy.
        olt: draft.oltId ? undefined : draft.olt.trim() || undefined,
        tray, oltPort,
      });
      const res = editing
        ? await authFetch(`/network/vlans/${editing.id}`, { method: "PATCH", body })
        : await authFetch("/network/vlans", { method: "POST", body });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "No se pudo guardar la VLAN");
      toast(editing ? `VLAN ${num} actualizada` : `VLAN ${num} creada`, "check");
      onSaved(!editing && enEquipos && data?.id ? { id: data.id, vlan: num, detail: draft.detail.trim() } : undefined);
    } catch (e) {
      setErr(mensajeDeError(e, "No se pudo guardar la VLAN"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={editing ? `Editar VLAN ${editing.vlan}` : "Nueva VLAN"}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Sede" required hint={sedeBloqueada ? "No se puede cambiar: la VLAN tiene NAPs" : undefined}>
          <Select value={draft.branchId} disabled={sedeBloqueada} onChange={(e) => setDraft({ ...draft, branchId: e.target.value })}>
            <option value="">Elige una sede…</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field label="Número de VLAN" required hint={puerto?.vlans.length ? `La principal de ese puerto en la OLT es la ${puerto.vlans[0].vlan}` : "Entre 1 y 4094"}>
          <Input type="number" min={1} max={4094} value={draft.vlan} onChange={(e) => setDraft({ ...draft, vlan: e.target.value })} placeholder="330" autoFocus />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Detalle" required hint="Barrio o sector que atiende">
            <Input value={draft.detail} onChange={(e) => setDraft({ ...draft, detail: e.target.value })} placeholder="PRIMAVERA" />
          </Field>
        </div>

        <div className="sm:col-span-2">
          <Field
            label="OLT"
            hint={
              !mismaSede ? "Cambió la sede: guarde y vuelva a editar para elegir su OLT."
                : mapa.cargando && !mapa.olts ? "Leyendo la OLT de la sede…"
                  : olts.length === 0 ? "Esta sede no tiene OLT registrada (Red › OLT)."
                    : !draft.oltId && draft.olt ? `En el legacy decía "${draft.olt}". Elija la OLT real.`
                      : undefined
            }
          >
            <Select
              value={draft.oltId}
              disabled={olts.length === 0}
              onChange={(e) => setDraft({ ...draft, oltId: e.target.value, tray: "", oltPort: "" })}
            >
              <option value="">{olts.length === 0 ? "Sin OLT" : "Elige la OLT…"}</option>
              {olts.map((o) => <option key={o.id} value={o.id}>{o.name}{o.ok ? "" : " (no responde)"}</option>)}
            </Select>
          </Field>
        </div>

        {aMano ? (
          <div className="grid grid-cols-2 gap-3 sm:col-span-2">
            <Field label="Bandeja" hint="La OLT no respondió: escríbala">
              <Input type="number" min={0} value={draft.tray} onChange={(e) => setDraft({ ...draft, tray: e.target.value })} placeholder="0" />
            </Field>
            <Field label="Puerto OLT" hint="La OLT no respondió: escríbalo">
              <Input type="number" min={0} value={draft.oltPort} onChange={(e) => setDraft({ ...draft, oltPort: e.target.value })} placeholder="3" />
            </Field>
          </div>
        ) : (
          <>
            <Field label="Bandeja (tarjeta)">
              <Select
                value={draft.tray}
                disabled={!olt}
                onChange={(e) => setDraft({ ...draft, tray: e.target.value, oltPort: "" })}
              >
                <option value="">{olt ? "Elige la bandeja…" : "Primero la OLT"}</option>
                {/* Una bandeja heredada que la OLT no tiene se conserva para verla y corregirla. */}
                {draft.tray && olt && !tarjeta && <option value={draft.tray}>{draft.tray} — no existe en la OLT</option>}
                {olt?.tarjetas.map((t) => (
                  <option key={t.slot} value={String(t.slot)}>
                    {t.slot} · {t.board} ({t.tech}, {t.puertos.length} puertos)
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Puerto PON">
              <Select value={draft.oltPort} disabled={!tarjeta} onChange={(e) => elegirPuerto(e.target.value)}>
                <option value="">{tarjeta ? "Elige el puerto…" : "Primero la bandeja"}</option>
                {draft.oltPort && tarjeta && !puerto && <option value={draft.oltPort}>{draft.oltPort} — no existe en la tarjeta</option>}
                {tarjeta?.puertos.map((p) => {
                  const cat = catalogoDe(p.port);
                  const enOlt = p.servicios > 0 ? `VLAN ${vlansTxt(p)} · ${p.servicios} abonado${p.servicios === 1 ? "" : "s"}` : "sin abonados";
                  const enCat = cat.length ? ` · catálogo: ${[...new Set(cat.map((c) => c.vlan))].join(", ")}` : "";
                  return <option key={p.port} value={String(p.port)}>{p.port} — {enOlt}{enCat}</option>;
                })}
              </Select>
            </Field>
          </>
        )}
      </div>

      {sugerida && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-text-secondary">
          <Icon name="info" size={14} className="shrink-0 text-brand" />
          {sugerida.vlan
            ? <>Ese puerto no tiene abonados. Según el patrón de la tarjeta le tocaría la <b className="font-mono">{sugerida.vlan}</b> ({sugerida.motivo}).</>
            : <>Ese puerto no tiene abonados y no hay número que sugerir: {sugerida.motivo}.</>}
          {sugerida.vlan && String(sugerida.vlan) !== draft.vlan && (
            <button type="button" className="tap rounded-md border border-border-default px-1.5 py-0.5 font-mono text-[11px] text-brand hover:bg-brand-soft" onClick={() => setDraft({ ...draft, vlan: String(sugerida.vlan) })}>
              Usar {sugerida.vlan}
            </button>
          )}
        </p>
      )}
      {!editing && olts.some((o) => o.ok) && (
        <label className="mt-3 flex items-start gap-2 text-[12px] text-text-secondary">
          <input type="checkbox" className="mt-0.5" checked={enEquipos} onChange={(e) => setEnEquipos(e.target.checked)} />
          <span>
            Configurarla también en los equipos (OLT y Mikrotik). Al crearla se muestran primero los comandos
            exactos y nada se aplica sin confirmar.
          </span>
        </label>
      )}
      {otraVlanEnOlt && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-warning-text">
          <Icon name="alert-triangle" size={14} className="mt-px shrink-0" />
          En la OLT la VLAN principal de ese puerto es la {puerto!.vlans[0].vlan}, no la {num}. El primer abonado que se instale ahí saldría con la VLAN del catálogo: revise cuál es la buena.
        </p>
      )}
      {repetida && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-warning-text">
          <Icon name="alert-triangle" size={14} className="mt-px shrink-0" />
          Esa sede ya tiene una VLAN {num}{repetida.detail ? ` (${repetida.detail})` : ""}. Se puede guardar igual, pero revisa que no sea un duplicado.
        </p>
      )}
      {err && <p className="mt-2 text-[12px] text-error-text">{err}</p>}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
          <Icon name="check" size={13} /> {busy ? "Guardando…" : editing ? "Guardar cambios" : "Crear VLAN"}
        </Button>
      </div>
    </Modal>
  );
}

/** Una línea sobre la revisión de los equipos (OLT + Mikrotik). */
function EstadoSalud({ salud }: { salud: Salud }) {
  if (salud.cargando && !salud.data) {
    return (
      <p className="flex items-center gap-1.5 text-[12px] text-text-tertiary">
        <Icon name="refresh-cw" size={13} className="animate-spin" /> Revisando las VLANs en la OLT y en el Mikrotik…
      </p>
    );
  }
  if (salud.error) return <p className="text-[12px] text-error-text">No se pudieron revisar los equipos: {salud.error}</p>;
  if (!salud.data) return null;
  const filas = salud.data.olts.flatMap((o) => o.filas);
  const rotas = filas.filter((f) => f.estado === "ROTA").length;
  const incompletas = filas.filter((f) => f.estado === "INCOMPLETA").length;
  return (
    <p className="text-[12px] text-text-tertiary">
      <Icon name="shield-check" size={12} className="mr-1 inline" />
      En equipos:{" "}
      {salud.data.olts.map((o) => (
        <span key={o.id} className="mr-2">
          <b className="text-text-secondary">{o.name}</b>
          {o.ok
            ? <> · uplink {o.uplink?.fsp ?? (o.uplink?.ambiguo ? `ambiguo (${o.uplink.candidatos.map((c) => c.fsp).join(" / ")})` : "—")} · Mikrotik {o.router?.name ?? "sin identificar"}</>
            : <span className="text-error-text"> · no responde ({o.error})</span>}
        </span>
      ))}
      {rotas > 0 && <span className="mr-2 font-semibold text-error-text">{rotas} con clientes y un tramo roto</span>}
      {incompletas > 0 && <span className="mr-2 text-warning-text">{incompletas} del catálogo incompletas</span>}
      {salud.data.mikrotikErrores.length > 0 && <span className="text-warning-text">Mikrotik: {salud.data.mikrotikErrores.join("; ")}</span>}
    </p>
  );
}

const ETIQUETA_ESTADO: Record<SaludVlan["estado"], { tone: "success" | "error" | "warning" | "default"; label: string }> = {
  OK: { tone: "success", label: "Completa" },
  ROTA: { tone: "error", label: "Clientes sin salida" },
  INCOMPLETA: { tone: "warning", label: "Incompleta" },
  SIN_CATALOGO: { tone: "success", label: "Completa" },
  SIN_USO: { tone: "default", label: "Sin uso" },
};

/**
 * Columna "En equipos": ✓ si está en los cuatro sitios; si no, qué falta y el
 * botón para configurarla (que primero enseña los comandos).
 */
function EnEquipos({ v, s, salud, onConfigurar }: { v: Vlan; s: { olt: SaludOlt; fila: SaludVlan } | null; salud: Salud; onConfigurar: () => void }) {
  if (!s) {
    if (salud.cargando) return <span className="text-text-tertiary">…</span>;
    if (!salud.data) return <span className="text-text-tertiary">—</span>;
    return (
      <span className="text-[11px] text-text-tertiary" title="Heredada sin OLT ligada y la OLT no tiene ese número (o el número no es válido): no se revisa en los equipos.">
        No está en la OLT
      </span>
    );
  }
  const e = ETIQUETA_ESTADO[s.fila.estado];
  const falta = s.fila.falta.filter((f) => f !== "no está en el catálogo de VLANs");
  return (
    <div className="flex max-w-[22rem] flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={e.tone} label={s.fila.estado === "OK" ? "✓ Completa" : e.label} />
        {s.fila.estado !== "OK" && v.vlan >= 2 && v.vlan <= 4094 && (
          <button
            type="button"
            onClick={(ev) => { ev.stopPropagation(); onConfigurar(); }}
            className="tap rounded-md border border-border-default px-1.5 py-0.5 text-[11px] text-brand hover:bg-brand-soft"
            title="Ver los comandos que faltan en la OLT y el Mikrotik y, si está de acuerdo, aplicarlos"
          >
            Configurar en equipos
          </button>
        )}
      </div>
      {falta.length > 0 && <span className="text-[11px] leading-snug text-text-tertiary">Falta: {falta.join("; ")}</span>}
    </div>
  );
}

/**
 * "Configurar en equipos": pide el plan en DRY-RUN (qué comandos, en qué
 * equipo), y solo si la persona confirma lo aplica. Después enseña lo que el
 * backend volvió a leer de los equipos. Nunca borra ni cambia lo existente.
 */
function ConfigurarEquiposModal({ vlan, onClose, onHecho }: { vlan: VlanAConfigurar; onClose: () => void; onHecho: () => void }) {
  const { authFetch, can } = useAuth();
  const [plan, setPlan] = useState<ConfigurarVlanRes | null>(null);
  const [uplink, setUplink] = useState("");
  const [cargando, setCargando] = useState(true);
  const [aplicando, setAplicando] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<ConfigurarVlanRes | null>(null);

  const pedir = useCallback(async (dryRun: boolean, up: string) => {
    const r = await authFetch(`/network/vlans/${vlan.id}/configurar-equipos`, {
      method: "POST",
      body: JSON.stringify({ dryRun, uplink: up || undefined }),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.message || "No se pudo consultar los equipos");
    return d as ConfigurarVlanRes;
  }, [authFetch, vlan.id]);

  const verPlan = useCallback((up: string) => {
    setCargando(true); setErr(null);
    pedir(true, up).then(setPlan).catch((e) => setErr(mensajeDeError(e, "No se pudo consultar los equipos"))).finally(() => setCargando(false));
  }, [pedir]);

  useEffect(() => { verPlan(""); }, [verPlan]);

  async function aplicar() {
    setAplicando(true); setErr(null);
    try {
      const d = await pedir(false, uplink);
      setRes(d);
      toast(d.ok ? `VLAN ${vlan.vlan} configurada en los equipos` : `VLAN ${vlan.vlan}: revise el resultado`, d.ok ? "check" : "alert-circle");
      onHecho();
    } catch (e) {
      setErr(mensajeDeError(e, "No se pudo configurar"));
    } finally {
      setAplicando(false);
    }
  }

  const hayOlt = !!plan?.olt?.comandos.length;
  const hayMk = !!plan?.mikrotik?.comandos.length;
  // El backend lo vuelve a exigir: aquí solo se evita ofrecer un botón que daría 403.
  const faltaPermiso = (hayOlt && !can("network.olt.manage")) || (hayMk && !can("network.routers.manage"));

  return (
    <Modal open onClose={onClose} maxWidth="max-w-2xl" title={`Configurar VLAN ${vlan.vlan} en los equipos`}>
      {vlan.detail && <p className="-mt-1 text-[12px] text-text-tertiary">{vlan.detail}</p>}
      {cargando && (
        <p className="flex items-center gap-1.5 text-[12px] text-text-tertiary">
          <Icon name="refresh-cw" size={13} className="animate-spin" /> Leyendo la OLT y el Mikrotik para ver qué falta…
        </p>
      )}
      {err && <p className="text-[12px] text-error-text">{err}</p>}

      {plan?.necesitaUplink && !res && (
        <div className="space-y-2">
          {plan.avisos.map((a) => <p key={a} className="text-[12px] text-warning-text">{a}</p>)}
          <Field label="Uplink de la OLT" hint="Por dónde sale la VLAN hacia el Mikrotik">
            <Select value={uplink} onChange={(e) => setUplink(e.target.value)}>
              <option value="">Elija el uplink…</option>
              {(plan.candidatos ?? []).map((c) => <option key={c.fsp} value={c.fsp}>{c.fsp} · lo usan {c.vlans} VLANs con clientes</option>)}
            </Select>
          </Field>
          <Button size="sm" disabled={!uplink || cargando} onClick={() => verPlan(uplink)}>Ver comandos con {uplink || "ese uplink"}</Button>
        </div>
      )}

      {plan && !plan.necesitaUplink && !res && (
        <div className="space-y-3">
          {plan.nadaQueHacer && !plan.avisos.length && (
            <p className="flex items-center gap-1.5 text-[13px] text-success-text"><Icon name="check" size={15} /> No falta nada: la VLAN ya está completa en la OLT y en el Mikrotik.</p>
          )}
          {hayOlt && (
            <div>
              <p className="text-[12px] font-semibold text-text-primary">OLT{plan.olt?.uplink ? ` · uplink ${plan.olt.uplink}` : ""}</p>
              <pre className="mt-1 overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-[12px] text-text-primary">{plan.olt!.comandos.join("\n")}</pre>
            </div>
          )}
          {hayMk && (
            <div>
              <p className="text-[12px] font-semibold text-text-primary">Mikrotik {plan.mikrotik!.name}{plan.mikrotik!.interfaz ? ` · sobre ${plan.mikrotik!.interfaz}` : ""}</p>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-md bg-surface-2 p-2 font-mono text-[12px] text-text-primary">{plan.mikrotik!.comandos.join("\n")}</pre>
            </div>
          )}
          {plan.avisos.map((a) => <p key={a} className="flex items-start gap-1.5 text-[12px] text-warning-text"><Icon name="alert-triangle" size={14} className="mt-px shrink-0" />{a}</p>)}
          {(plan.mikrotikErrores ?? []).length > 0 && <p className="text-[12px] text-warning-text">Mikrotik: {plan.mikrotikErrores!.join("; ")}</p>}
          {(hayOlt || hayMk) && (
            <p className="text-[11px] text-text-tertiary">
              Solo se AGREGA lo que falta; nada existente se borra ni se cambia. La OLT guarda sola sus cambios (autosave cada 60 min).
              {faltaPermiso && " Para aplicarlo hace falta el permiso de administrar la OLT / los routers: pídaselo a quien lo tenga."}
            </p>
          )}
        </div>
      )}

      {res && (
        <div className="space-y-2 text-[12px]">
          <p className={`flex items-center gap-1.5 font-semibold ${res.ok ? "text-success-text" : "text-error-text"}`}>
            <Icon name={res.ok ? "check" : "alert-triangle"} size={15} />
            {res.ok ? "Listo: la VLAN quedó completa en los equipos." : "La VLAN no quedó completa. Esto es lo que pasó:"}
          </p>
          {res.resultado?.olt && (
            <p className="text-text-secondary">
              OLT: {res.resultado.olt.dryRun ? "DRY-RUN (la OLT está en modo simulación: no se tocó)" : res.resultado.olt.ok ? "aplicado" : `rechazado — ${res.resultado.olt.error}`}
              {res.resultado.olt.respuestas?.length ? ` · ${res.resultado.olt.respuestas.map((x) => `${x.cmd} → ${x.out || "ok"}`).join(" · ")}` : ""}
            </p>
          )}
          {res.resultado?.mikrotik && (
            <p className="text-text-secondary">
              Mikrotik: {res.resultado.mikrotik.dryRun ? "DRY-RUN (no se tocó)" : res.resultado.mikrotik.ok ? "aplicado" : `error — ${res.resultado.mikrotik.error}`}
              {" · "}{res.resultado.mikrotik.steps.join(" · ")}
            </p>
          )}
          {res.resultado?.mikrotikOmitido && <p className="text-warning-text">{res.resultado.mikrotikOmitido}</p>}
          {res.despues && (
            <p className="text-text-secondary">
              Relectura de los equipos: <b>{ETIQUETA_ESTADO[res.despues.estado].label}</b>
              {res.despues.falta.length ? ` — falta: ${res.despues.falta.join("; ")}` : ""}
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>{res ? "Cerrar" : "Cancelar"}</Button>
        {!res && plan && !plan.necesitaUplink && (hayOlt || hayMk) && (
          <Button variant="primary" size="sm" disabled={aplicando || cargando || faltaPermiso} onClick={() => void aplicar()}>
            <Icon name="check" size={13} /> {aplicando ? "Aplicando y releyendo…" : "Confirmar y aplicar"}
          </Button>
        )}
      </div>
    </Modal>
  );
}
