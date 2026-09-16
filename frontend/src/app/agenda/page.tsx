"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";
import { useRequest } from "@/lib/useRequest";
import { TICKET_PRIORITIES } from "@/lib/support";
import { EventoModal } from "@/components/agenda/EventoModal";
import { MiniCalendario } from "@/components/agenda/MiniCalendario";
import { VistaMes } from "@/components/agenda/VistaMes";
import { VistaTabla } from "@/components/agenda/VistaTabla";
import { VistaTiempo } from "@/components/agenda/VistaTiempo";
import {
  inicioDeDia, nombreDeMes, rejillaDeMes, semanaDe, sumarDias, sumarMeses,
  ventanaDe, type Evento,
} from "@/components/agenda/calendario";

type Vista = "mes" | "semana" | "dia" | "lista";

const VISTAS: { value: Vista; label: string }[] = [
  { value: "mes", label: "Mes" },
  { value: "semana", label: "Semana" },
  { value: "dia", label: "Día" },
  { value: "lista", label: "Lista" },
];

/** Filtros que comparten las tres vistas de rejilla (la tabla lleva los suyos). */
type Filtros = { search: string; priority: string; assignedBy: string };
const SIN_FILTROS: Filtros = { search: "", priority: "", assignedBy: "" };

/**
 * AGENDA — el calendario de la empresa: tareas, reuniones, visitas.
 *
 * Cuatro vistas sobre los mismos eventos (`CalendarEvent`), y son cuatro porque son
 * cuatro preguntas distintas:
 *
 *   · **Mes** — cómo viene el mes. Es la que abre, porque es con la que se decide
 *     cuándo meter algo nuevo.
 *   · **Semana** — la jornada con sus horas, que es donde se ve si una reunión de las
 *     11 choca con otra.
 *   · **Día** — lo mismo para un solo día, en móvil y en los días cargados.
 *   · **Lista** — la tabla de siempre sobre los 131.913 eventos del histórico: buscar,
 *     ordenar y paginar. Ver `VistaTabla`, que explica por qué no sobra.
 *
 * ── POR QUÉ ESTA PANTALLA ESTÁ EN «PRINCIPAL» Y NO ES «MI AGENDA» ────────────
 * Son dos cosas distintas que se llaman parecido. `/mi-agenda` es el TURNO de un
 * técnico —lo que se le asignó a él, en el orden en que lo tiene que hacer—, y por eso
 * no la ve nadie más. Ésta es la agenda de la oficina: lo que cualquiera del equipo
 * apunta para sí o para todos. Una no sustituye a la otra y, sobre todo, no comparten
 * ni la tabla ni el permiso.
 *
 * ── UNA SOLA CARGA POR VENTANA ───────────────────────────────────────────────
 * Las tres rejillas piden lo mismo a `/omni/events/calendar`: los eventos que CRUZAN
 * los días visibles (no los que empiezan en ellos — ver el backend). Cambiar de mes a
 * semana sobre el mismo día no vuelve a pedir nada que no haga falta, porque la
 * ventana la calculan los días que se están pintando.
 */
export default function AgendaPage() {
  const { loading: authLoading } = useAuth();

  const [vista, setVista] = useState<Vista>("mes");
  /** El día de referencia. Mueve la vista y es lo que el mini-calendario cambia. */
  const [ancla, setAncla] = useState<Date>(() => inicioDeDia(new Date()));
  /** El mes del mini, que puede ir por libre para ojear sin saltar de vista. */
  const [mesDelMini, setMesDelMini] = useState<Date>(() => new Date());
  const [filtros, setFiltros] = useState<Filtros>(SIN_FILTROS);
  const set = <K extends keyof Filtros>(k: K, v: Filtros[K]) => setFiltros((f) => ({ ...f, [k]: v }));

  const [modalAbierto, setModalAbierto] = useState(false);
  const [enEdicion, setEnEdicion] = useState<Evento | null>(null);
  const [fechaSugerida, setFechaSugerida] = useState<Date | null>(null);
  /** Se incrementa al guardar o borrar: es lo que hace recargar a la vista que toque. */
  const [recarga, setRecarga] = useState(0);

  const dias = useMemo(() => {
    if (vista === "mes") return rejillaDeMes(ancla);
    if (vista === "semana") return semanaDe(ancla);
    return [ancla];
  }, [vista, ancla]);

  const ventana = useMemo(() => ventanaDe(dias), [dias]);

  const qsFiltros = useMemo(() => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filtros)) if (v.trim()) qs.set(k, v.trim());
    return qs.toString();
  }, [filtros]);

  const { data, cargando, error, refrescar } = useRequest<{
    items: Evento[];
    truncado: boolean;
    /** Desde cuándo lo devuelto deja de ser completo (sólo si `truncado`). */
    cortadoDesde: string | null;
    tope: number;
  }>(
    () => {
      const qs = new URLSearchParams(qsFiltros);
      qs.set("from", ventana.from);
      qs.set("to", ventana.to);
      return `/omni/events/calendar?${qs}`;
    },
    [ventana.from, ventana.to, qsFiltros, recarga],
    { debounceMs: filtros.search ? 350 : 0, saltar: authLoading || vista === "lista" },
  );

  const eventos = data?.items ?? [];

  // ── Navegación ────────────────────────────────────────────────────────────
  const paso = (signo: 1 | -1) => {
    const siguiente =
      vista === "mes" ? sumarMeses(ancla, signo) : sumarDias(ancla, signo * (vista === "semana" ? 7 : 1));
    setAncla(inicioDeDia(siguiente));
    setMesDelMini(new Date(siguiente.getFullYear(), siguiente.getMonth(), 1));
  };

  const irA = (dia: Date) => {
    setAncla(inicioDeDia(dia));
    setMesDelMini(new Date(dia.getFullYear(), dia.getMonth(), 1));
  };

  const hoy = () => irA(new Date());

  /** El rótulo del periodo. Cambia con la vista porque cambia lo que hay que situar. */
  const periodo = useMemo(() => {
    if (vista === "mes") return nombreDeMes(ancla);
    if (vista === "dia") return ancla.toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const [lunes, ...resto] = semanaDe(ancla);
    const domingo = resto[resto.length - 1];
    // "28 sep – 4 oct 2026" cuando la semana cambia de mes; si no, el mes no se repite.
    const izq = lunes.toLocaleDateString("es-CO", { day: "numeric", ...(lunes.getMonth() === domingo.getMonth() ? {} : { month: "short" }) });
    const der = domingo.toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric" });
    return `${izq} – ${der}`;
  }, [vista, ancla]);

  // ── Alta y edición ────────────────────────────────────────────────────────
  const abrirNuevo = (fecha: Date | null) => { setEnEdicion(null); setFechaSugerida(fecha); setModalAbierto(true); };
  const abrirEvento = (e: Evento) => { setEnEdicion(e); setFechaSugerida(null); setModalAbierto(true); };

  const verDia = (dia: Date) => { irA(dia); setVista("dia"); };

  if (authLoading) return <PageSkeleton />;

  const enRejilla = vista !== "lista";

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="calendar-days" title="Agenda" subtitle="Tus tareas, reuniones y compromisos del equipo" />
        <div className="flex items-center gap-2">
          {/* Casi todo lo que se agenda acaba siendo una orden: el atajo estaba en la
              pantalla anterior y se queda. */}
          <Link href="/ordenes" className="hidden sm:block">
            <Button variant="ghost" size="sm"><Icon name="arrow-left" size={14} /> Órdenes</Button>
          </Link>
          <Button size="sm" onClick={() => abrirNuevo(null)}>
            <Icon name="plus" size={14} /> Nuevo evento
          </Button>
        </div>
      </div>

      {/* Barra de mando: mover el periodo (izquierda) y elegir la vista (derecha). */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {enRejilla && (
            <>
              <button
                type="button"
                onClick={hoy}
                className="foco tap rounded-lg border border-border-default bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-2"
              >
                Hoy
              </button>
              <div className="flex items-center">
                <button type="button" aria-label="Anterior" onClick={() => paso(-1)} className="foco tap rounded-lg p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary">
                  <Icon name="chevron-left" size={17} />
                </button>
                <button type="button" aria-label="Siguiente" onClick={() => paso(1)} className="foco tap rounded-lg p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary">
                  <Icon name="chevron-right" size={17} />
                </button>
              </div>
              <h2 className="truncate text-[15px] font-bold capitalize text-text-primary">{periodo}</h2>
              {cargando && <Icon name="loader" size={14} className="animate-spin text-text-tertiary" />}
            </>
          )}
        </div>
        <Segmented value={vista} onChange={setVista} options={VISTAS} ariaLabel="Vista del calendario" />
      </div>

      <div className="flex gap-4">
        {/* El riel del calendario. Se esconde por debajo de `lg` (no cabe) y en la
            vista de tabla (que trae sus propios filtros, más completos). */}
        {enRejilla && (
          <aside className="hidden w-[212px] shrink-0 flex-col gap-3 lg:flex">
            <MiniCalendario
              mes={mesDelMini}
              seleccionado={ancla}
              eventos={eventos}
              onMes={setMesDelMini}
              onDia={irA}
            />

            <div className="flex flex-col gap-2.5 rounded-xl border border-border-subtle bg-surface p-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Filtrar</p>
              <Field label="Buscar">
                <Input
                  value={filtros.search}
                  onChange={(e) => set("search", e.target.value)}
                  placeholder="Título, N° de orden…"
                />
              </Field>
              <Field label="Prioridad">
                <Select value={filtros.priority} onChange={(e) => set("priority", e.target.value)}>
                  <option value="">Todas</option>
                  {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
              </Field>
              {(filtros.search || filtros.priority || filtros.assignedBy) && (
                <button
                  type="button"
                  onClick={() => setFiltros(SIN_FILTROS)}
                  className="foco rounded-lg px-2 py-1 text-[11.5px] font-semibold text-text-tertiary hover:bg-surface-2 hover:text-brand"
                >
                  Limpiar filtros
                </button>
              )}
            </div>
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* El tope no se calla: un calendario al que le faltan eventos y no lo dice
              es peor que uno que no carga (ver `eventsCalendar` en el backend). */}
          {enRejilla && data?.truncado && (
            <p className="flex items-start gap-2 rounded-xl border border-warning bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
              <Icon name="alert-triangle" size={14} className="mt-[2px] shrink-0" />
              <span>
                Este periodo pasa de {data.tope.toLocaleString("es-CO")} eventos.
                {data.cortadoDesde ? (
                  <>
                    {" "}Lo que ves está completo <b>hasta el{" "}
                    {new Date(data.cortadoDesde).toLocaleDateString("es-CO", { day: "numeric", month: "long" })}</b>;
                    de ahí en adelante faltan eventos.
                  </>
                ) : (
                  " Faltan eventos por pintar."
                )}{" "}
                Afina con los filtros o mira una semana en vez del mes.
              </span>
            </p>
          )}

          {enRejilla && error ? (
            <LoadError message={error} onRetry={refrescar} />
          ) : vista === "mes" ? (
            <VistaMes
              dias={dias}
              mes={ancla}
              eventos={eventos}
              onNuevo={abrirNuevo}
              onAbrir={abrirEvento}
              onVerDia={verDia}
            />
          ) : vista === "semana" || vista === "dia" ? (
            <VistaTiempo dias={dias} eventos={eventos} onNuevo={abrirNuevo} onAbrir={abrirEvento} />
          ) : (
            <VistaTabla recarga={recarga} onAbrir={abrirEvento} />
          )}

          {/*
            UNA REJILLA VACÍA NO DICE POR QUÉ ESTÁ VACÍA, y las tres razones piden cosas
            distintas: no hay nada agendado (agenda algo), lo tapan los filtros (quítalos)
            o estás mirando un mes al que todavía no ha llegado la agenda. Sin esta línea
            las tres se ven igual —un calendario en blanco—, que es exactamente como se
            lee «esto está roto».
          */}
          {enRejilla && !cargando && !error && eventos.length === 0 && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-dashed border-border-subtle bg-surface px-3 py-2.5 text-[12.5px] text-text-tertiary">
              <Icon name="calendar-days" size={14} className="shrink-0" />
              {qsFiltros ? (
                <>
                  Ningún evento de este periodo pasa los filtros.
                  <button type="button" onClick={() => setFiltros(SIN_FILTROS)} className="foco font-semibold text-brand hover:underline">
                    Quitar los filtros
                  </button>
                </>
              ) : (
                <>
                  No hay nada agendado en este periodo.
                  <button type="button" onClick={() => abrirNuevo(null)} className="foco font-semibold text-brand hover:underline">
                    Agendar algo
                  </button>
                </>
              )}
            </p>
          )}

          {/* Los filtros del riel no existen en móvil; que al menos se sepa que hay
              algo puesto (si no, la rejilla recortada se lee como «no hay nada»). */}
          {enRejilla && qsFiltros && (
            <button
              type="button"
              onClick={() => setFiltros(SIN_FILTROS)}
              className="foco self-start rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-[11px] font-medium text-text-secondary lg:hidden"
            >
              Filtros activos · quitar <Icon name="x" size={11} className="inline text-text-tertiary" />
            </button>
          )}
        </div>
      </div>

      <EventoModal
        abierto={modalAbierto}
        evento={enEdicion}
        fechaSugerida={fechaSugerida}
        onCerrar={() => setModalAbierto(false)}
        onGuardado={() => setRecarga((n) => n + 1)}
      />
    </>
  );
}
