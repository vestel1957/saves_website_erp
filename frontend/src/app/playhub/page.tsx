"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Pagination } from "@/components/ui/Pagination";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { MultiSelect, type OpcionMulti } from "@/components/ui/MultiSelect";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { useOrden } from "@/lib/useOrden";
import { fmtDate } from "@/lib/format";
import { mensajeDeError } from "@/lib/errores";

/**
 * Reporte "Clientes PlayHub": una fila POR CLIENTE con las apps que tiene, igual
 * que el listado del legacy. Se listan también las cuentas que no llegan al mínimo
 * de Megas —marcadas en rojo—: son suscripciones a limpiar, no a esconder.
 *
 * FILTROS. Cuatro, y se combinan (Y entre filtros, O dentro de uno):
 *
 * - **Estado** reparte el total sin solaparse (Cumplen + Por limpiar + Solo cuenta
 *   = Todas), así que es excluyente y va aparte, en la tira de arriba: la pregunta
 *   más común de esta pantalla es "¿qué hay que limpiar?".
 * - **Plan** filtra por MEGAS, no por el nombre del plan: las mismas 300 Megas
 *   están escritas de cuatro formas en la base y por nombre serían cuatro casillas.
 * - **Nivel** son los 10 productos leídos como lo que son (Servicio, Premium,
 *   Premium plus, Diamante); el "01/02/05" del nombre es la cantidad de apps.
 * - **Sede**, que antes sólo se podía filtrar escribiéndola en el buscador.
 *
 * Todos los números cuentan CUENTAS, que es lo que lista la tabla, y el servidor
 * los recalcula con los demás filtros puestos (`facetas`).
 */
type Row = {
  id: string; subscriberId: string | null; subscriberName: string | null; abonado: number | null;
  docNumber: string | null; nameS: string | null; sede: string | null; apps: string[];
  total: number; syncedAt: string | null; planInternet: string | null; planTv: string | null;
  megas: number; elegible: boolean; niveles: string[];
};
type EstadoCuenta = "" | "cumple" | "limpiar" | "solo";
type Opcion = OpcionMulti & { count: number; bajo?: boolean };
type Facetas = {
  estado: Record<"todas" | "cumple" | "limpiar" | "solo", number>;
  megas: Opcion[]; nivel: Opcion[]; sede: Opcion[];
};
type List = {
  items: Row[]; total: number; cuentas: number; page: number; pageSize: number; pages: number;
  apps: number; appsNoElegibles: number; minMegas: number; facetas: Facetas;
};
type Barrida = {
  running: boolean; total: number; hechos: number; conSuscripcion: number;
  sinSuscripcion: number; errores: number; detalle: string[]; finishedAt: string | null;
};

const ESTADOS: { value: EstadoCuenta; label: string; ayuda: (min: number) => string }[] = [
  { value: "", label: "Todas", ayuda: () => "Todas las cuentas de PlayHub" },
  { value: "cumple", label: "Cumplen", ayuda: (m) => `Con apps y plan de ${m} Megas o más` },
  {
    value: "limpiar", label: "Por limpiar",
    ayuda: (m) => `Tienen apps, pero su plan no llega a ${m} Megas o la cuenta no es de un cliente`,
  },
  { value: "solo", label: "Solo cuenta", ayuda: () => "Cuenta creada en PlayHub, sin apps contratadas" },
];

export default function PlayhubPage() {
  const { authFetch } = useAuth();
  const [data, setData] = useState<List | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [estado, setEstado] = useState<EstadoCuenta>("");
  const [megas, setMegas] = useState<string[]>([]);
  const [niveles, setNiveles] = useState<string[]>([]);
  const [sedes, setSedes] = useState<string[]>([]);
  const [barrida, setBarrida] = useState<Barrida | null>(null);
  const corriendo = useRef(false);

  const orden = useOrden();

  // Las listas son arrays nuevos en cada render: a las dependencias va su texto.
  const megasQs = megas.join(",");
  const nivelQs = niveles.join(",");
  const sedeQs = sedes.join(",");

  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: String(page), pageSize: "30", ...orden.params });
    if (search) qs.set("search", search);
    if (estado) qs.set("estado", estado);
    if (megasQs) qs.set("megas", megasQs);
    if (nivelQs) qs.set("nivel", nivelQs);
    if (sedeQs) qs.set("sede", sedeQs);
    void authFetch(`/extras/playhub?${qs.toString()}`).then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {});
  }, [authFetch, page, search, estado, megasQs, nivelQs, sedeQs, orden.clave]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [search, estado, megasQs, nivelQs, sedeQs, orden.clave]);

  // La barrida contra PlayHub son ~15.000 consultas (una por cliente con email):
  // corre en el servidor y aquí sólo se sigue el progreso.
  const verEstado = useCallback(async () => {
    try {
      const r = await authFetch("/playhub/sync-status");
      if (!r.ok) return;
      const st: Barrida = await r.json();
      setBarrida(st);
      if (!st.running && corriendo.current) {
        corriendo.current = false;
        toast(`Sincronización terminada · ${st.conSuscripcion} con suscripción, ${st.sinSuscripcion} sin${st.errores ? ` · ${st.errores} con error` : ""}`, "check");
        load();
      }
      corriendo.current = st.running;
    } catch { /* la pantalla sigue viva aunque falle un sondeo */ }
  }, [authFetch, load]);

  useEffect(() => { void verEstado(); }, [verEstado]);
  useEffect(() => {
    if (!barrida?.running) return;
    const t = setInterval(() => { void verEstado(); }, 3000);
    return () => clearInterval(t);
  }, [barrida?.running, verEstado]);

  async function syncAll() {
    try {
      const res = await authFetch(`/playhub/sync-all`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo sincronizar");
      corriendo.current = true;
      setBarrida({ ...d, running: true });
      toast(d.yaEnCurso ? "Ya hay una sincronización en curso" : `Sincronizando ${d.total} clientes con PlayHub…`, "refresh-cw");
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); }
  }

  const pct = barrida && barrida.total > 0 ? Math.round((barrida.hechos / barrida.total) * 100) : 0;

  const f = data?.facetas;
  const etiquetaDe = (opts: Opcion[] | undefined, v: string) => opts?.find((o) => o.value === v)?.label ?? v;
  const quitarDe = (set: (fn: (xs: string[]) => string[]) => void, v: string) =>
    () => set((xs) => xs.filter((x) => x !== v));
  const chips = [
    ...(estado ? [{ key: `estado:${estado}`, label: ESTADOS.find((e) => e.value === estado)!.label, quitar: () => setEstado("") }] : []),
    ...megas.map((v) => ({ key: `megas:${v}`, label: etiquetaDe(f?.megas, v), quitar: quitarDe(setMegas, v) })),
    ...niveles.map((v) => ({ key: `nivel:${v}`, label: etiquetaDe(f?.nivel, v), quitar: quitarDe(setNiveles, v) })),
    ...sedes.map((v) => ({ key: `sede:${v}`, label: etiquetaDe(f?.sede, v), quitar: quitarDe(setSedes, v) })),
  ];
  const hayFiltro = chips.length > 0;
  const limpiar = () => { setEstado(""); setMegas([]); setNiveles([]); setSedes([]); };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="tv" title="PlayHub / IPTV" subtitle="Cuentas y apps de streaming contratadas por los abonados." />
        <Button size="sm" variant="secondary" onClick={syncAll} disabled={!!barrida?.running}>
          <Icon name={barrida?.running ? "loader" : "refresh-cw"} size={14} className={barrida?.running ? "animate-spin" : ""} />
          {barrida?.running ? `Sincronizando… ${pct}%` : "Sincronizar con PlayHub"}
        </Button>
      </div>

      {barrida?.running && (
        <div className="rounded-xl border border-border-subtle bg-surface p-3">
          <div className="mb-2 flex items-center justify-between text-[12px] text-text-secondary">
            <span>{barrida.hechos.toLocaleString("es-CO")} de {barrida.total.toLocaleString("es-CO")} clientes consultados</span>
            <span>{barrida.conSuscripcion} con suscripción · {barrida.errores} con error</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <EstadoTabs value={estado} onChange={setEstado} facetas={f} minMegas={data?.minMegas ?? 100} />
        {data && (
          <p className="text-[12px] text-text-tertiary">
            {data.apps.toLocaleString("es-CO")} apps en uso · {data.appsNoElegibles.toLocaleString("es-CO")} en cuentas por limpiar
          </p>
        )}
      </div>

      <div>
        <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar por cliente, usuario, documento, app o sede…">
          <MultiSelect label="Plan" todos="Todos los planes" options={f?.megas ?? []} value={megas} onChange={setMegas} />
          <MultiSelect label="Nivel" todos="Todos los niveles" options={f?.nivel ?? []} value={niveles} onChange={setNiveles} />
          <MultiSelect label="Sede" todos="Todas las sedes" options={f?.sede ?? []} value={sedes} onChange={setSedes} />
        </ListToolbar>

        {data && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-text-tertiary">
              {hayFiltro
                ? `Mostrando ${data.total.toLocaleString("es-CO")} de ${data.cuentas.toLocaleString("es-CO")} cuentas`
                : `${data.cuentas.toLocaleString("es-CO")} cuentas`}
            </span>
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={c.quitar}
                title="Quitar este filtro"
                className="inline-flex items-center gap-1 rounded-full bg-brand-soft py-0.5 pl-2.5 pr-2 text-[12px] font-semibold text-brand transition-colors hover:brightness-95"
              >
                {c.label}
                <Icon name="x" size={12} />
              </button>
            ))}
            {hayFiltro && (
              <button type="button" onClick={limpiar} className="text-[12px] font-medium text-brand hover:underline">
                Quitar filtros
              </button>
            )}
          </div>
        )}

        <DataTable
          sort={orden.sort}
          onSort={orden.onSort}
          columns={[
            {
              key: "cliente", header: "Cliente", sortable: true,
              render: (r) => (
                <>
                  {r.subscriberId
                    ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline">{r.subscriberName ?? "—"}</Link>
                    : <span className="text-text-secondary">{r.subscriberName ?? "—"}</span>}
                  {r.abonado != null && <span className="ml-1 text-[11px] text-text-tertiary">#{r.abonado}</span>}
                  {!r.subscriberId && <span className="ml-2 inline-block"><Badge label="Externo" /></span>}
                </>
              ),
            },
            { key: "nameS", header: "Usuario", sortable: true, render: (r) => <span className="font-mono text-[12px]">{r.nameS ?? "—"}</span> },
            { key: "sede", header: "Sede", render: (r) => r.sede ?? "—" },
            {
              // Ordena por Megas, no por el texto del plan (lo resuelve el servidor).
              key: "plan", header: "Plan de internet", sortable: true,
              render: (r) => (
                <span className={r.elegible ? undefined : "text-error-text"}>{r.planInternet ?? "—"}</span>
              ),
            },
            {
              key: "apps", header: "Apps", sortable: true,
              render: (r) => (
                r.total === 0
                  ? <span className="text-text-tertiary">Solo cuenta</span>
                  : <span className="text-[12px]">{r.apps.join(" · ")}</span>
              ),
            },
            { key: "syncedAt", header: "Últ. sync", sortable: true, render: (r) => <span className="text-text-tertiary">{fmtDate(r.syncedAt)}</span> },
          ] satisfies Column<Row>[]}
          rows={data?.items ?? []}
          loading={!data}
          loadingText="Cargando…"
          empty={hayFiltro || search
            ? "Ninguna cuenta cumple estos filtros."
            : "Sin cuentas de PlayHub. Usa «Sincronizar con PlayHub» para traerlas."}
        />
      </div>
      {data && data.pages > 1 && <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} />}
    </div>
  );
}

/**
 * Estado de la cuenta: las cuatro opciones reparten el total sin solaparse, así que
 * es una tira de pestañas y no un desplegable más —se ve de un vistazo cuántas hay
 * que limpiar sin abrir nada—. Los conteos los manda el servidor ya cruzados con
 * los otros filtros.
 */
function EstadoTabs({ value, onChange, facetas, minMegas }: {
  value: EstadoCuenta;
  onChange: (v: EstadoCuenta) => void;
  facetas?: Facetas;
  minMegas: number;
}) {
  return (
    <div
      role="group"
      aria-label="Estado de la cuenta"
      // En móvil se arrastra de lado en vez de envolverse en dos renglones, como
      // la fila de filtros de `ListToolbar`.
      className="inline-flex max-w-full overflow-x-auto rounded-lg border border-border-subtle bg-surface-2 p-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {ESTADOS.map((e) => {
        const activo = e.value === value;
        const n = facetas ? facetas.estado[e.value === "" ? "todas" : e.value] : null;
        const alerta = e.value === "limpiar" && !!n;
        return (
          <button
            key={e.value}
            type="button"
            aria-pressed={activo}
            title={e.ayuda(minMegas)}
            onClick={() => onChange(e.value)}
            className={`tap shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
              activo ? "bg-surface text-brand shadow-sm" : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {e.label}
            {n != null && (
              <span
                className={`ml-1.5 tabular-nums ${
                  alerta
                    ? "rounded-full bg-error-soft px-1.5 py-0.5 text-error-text"
                    : activo ? "text-brand" : "text-text-tertiary"
                }`}
              >
                {n.toLocaleString("es-CO")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
