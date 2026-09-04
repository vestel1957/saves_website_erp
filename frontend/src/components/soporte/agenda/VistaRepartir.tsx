"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { toast } from "@/components/ui/Toast";
import { Select } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError, objetoJson } from "@/lib/errores";
import { TICKET_PRIORITY_TONE } from "@/lib/support";
import {
  BarraFiltros, BotonExcel, TONO_BADGE, diaCorto, diaLargo, diasEsperando, hayFiltros, queryAgenda, sumarDias,
  type Filtros, type Tablero, type Tarjeta,
} from "./comun";

/** Lo que el contenedor de pestañas le pasa a cada vista: el día enfocado y los filtros. */
export type VistaProps = {
  /** Día para el que se reparte ('YYYY-MM-DD'), o `null` = "hoy, el que diga el servidor". */
  fecha: string | null;
  setFecha: (f: string) => void;
  filtros: Filtros;
  setFiltros: Dispatch<SetStateAction<Filtros>>;
};

/** Para ordenar por prioridad de verdad y no alfabéticamente (Alta antes que Baja). */
const RANGO_PRIORIDAD: Record<string, number> = { Urgente: 0, Alta: 1, Media: 2, Baja: 3 };

/**
 * REPARTIR: la lista de órdenes sin agendar, con dos mandos por renglón.
 *
 * Reemplaza al tablero de arrastre (2026-09-02, a pedido del usuario). El tablero
 * respondía "qué tan cargado va cada técnico", pero el trabajo de la ventanilla es
 * el otro: coger una orden y decir QUIÉN la hace y QUÉ DÍA. Eso son dos datos, y en
 * el tablero costaban un arrastre a una columna (el quién) más navegar a otro día
 * antes de arrastrar (el cuándo) — dos gestos en dos sitios distintos para una sola
 * decisión, y ninguno de los dos posible con el dedo en la tableta de ventanilla.
 *
 * Aquí la orden es un renglón y la decisión son los dos desplegables que lleva al
 * final: técnico y fecha. La fecha viene puesta (la de arriba, que vale para toda la
 * tanda) y se cambia por renglón cuando esa visita va otro día; **elegir el técnico
 * es lo que agenda** — es el último dato que falta, y pedir además un botón sería un
 * clic por orden sobre 120 órdenes.
 *
 * Lo repartido desaparece de la lista: la bandeja son las órdenes ABIERTAS SIN DÍA,
 * así que agendar una la saca sola. Para ver dónde quedó —y en qué puesto— está la
 * pestaña "Por técnico".
 */
export function VistaRepartir({ fecha, setFecha, filtros, setFiltros }: VistaProps) {
  const { loading: authLoading, authFetch } = useAuth();
  const [d, setD] = useState<Tablero | null>(null);
  const [err, setErr] = useState(false);
  const [guardando, setGuardando] = useState(false);
  /** Órdenes marcadas para mandarlas juntas. */
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  /** A quién va la tanda marcada. Aparte de los renglones: aquí sí hay botón. */
  const [aQuien, setAQuien] = useState("");
  /** Técnico del que se está mirando la carga del día. "" = el resumen de todos. */
  /**
   * La fecha propia de un renglón, cuando esa visita no va el día de arriba.
   * Solo guarda las EXCEPCIONES: lo que no está aquí usa la fecha común.
   */
  const [fechaFila, setFechaFila] = useState<Record<string, string>>({});

  const filtrando = hayFiltros(filtros);
  const claveFiltros = useMemo(() => queryAgenda(filtros), [filtros]);

  // Los filtros se leen de una ref para que `cargar` no cambie de identidad al
  // teclear: es la que se llama después de cada agendamiento.
  const filtrosRef = useRef(filtros);
  useEffect(() => { filtrosRef.current = filtros; }, [filtros]);

  /**
   * Número de la última carga pedida. Solo la ÚLTIMA puede pintar.
   *
   * Tecleando en el buscador salen varias peticiones solapadas y no tienen por qué
   * volver en orden: si la de "cen" contesta después que la de "centro", la pantalla
   * se queda con la lista ancha mientras el campo dice "centro" — y ahí la cajera
   * agenda una orden que creía filtrada. En la red local el desorden no se ve nunca;
   * en la de la sede, sí.
   */
  const pedido = useRef(0);

  const cargar = useCallback(async (f?: string | null) => {
    const mio = ++pedido.current;
    setErr(false);
    try {
      const qs = queryAgenda(filtrosRef.current, { fecha: f });
      const r = await authFetch(`/support/agenda${qs ? `?${qs}` : ""}`);
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      if (mio === pedido.current) setD(j);
    } catch {
      if (mio === pedido.current) setErr(true);
    }
  }, [authFetch]);

  // Una sola carga por cambio: día o filtros. El buscador espera a que se deje de
  // teclear; los desplegables van sin retardo, que es lo que se espera al elegir.
  useEffect(() => {
    if (authLoading) return;
    const t = window.setTimeout(() => { void cargar(fecha); }, filtrosRef.current.q.trim() ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [authLoading, fecha, claveFiltros, cargar]);

  // El día de verdad NO se puede leer del estado `fecha`: vale `null` mientras no se
  // navegue —el caso normal, "hoy"— y sólo el servidor sabe qué día es en Colombia.
  const dia = fecha ?? d?.fecha ?? null;
  const diaRef = useRef<string | null>(null);
  useEffect(() => { diaRef.current = dia; }, [dia]);

  /** La fecha con la que se va a agendar este renglón: la suya, o la común. */
  const fechaDe = useCallback((t: Tarjeta) => fechaFila[t.id] ?? dia ?? "", [fechaFila, dia]);

  /**
   * Quién tiene ya trabajo en cada barrio ESE día.
   *
   * Es la recomendación más barata de las dos que hay: ordenar bien un día mal
   * repartido sólo recorta el zigzag; no mandar a dos técnicos al mismo barrio
   * ahorra el desplazamiento entero. Por eso vive aquí, en el desplegable donde
   * se decide, y no en una pantalla aparte que nadie abriría.
   *
   * Sólo se pide para el día COMÚN de arriba. Las filas que se hayan salido a
   * otra fecha con su propio calendario no llevan pista en vez de llevar una
   * pista de otro día, que sería peor que ninguna.
   */
  const [zonas, setZonas] = useState<Record<string, Record<string, number>>>({});
  useEffect(() => {
    if (authLoading || !dia) return;
    let vivo = true;
    void (async () => {
      const r = await authFetch(`/support/agenda/zonas?fecha=${encodeURIComponent(dia)}`).catch(() => null);
      if (!r?.ok || !vivo) return;
      const j = await objetoJson<{ porTecnico?: Record<string, Record<string, number>> }>(r);
      if (vivo) setZonas(j?.porTecnico ?? {});
    })();
    return () => { vivo = false; };
  }, [authLoading, authFetch, dia]);

  /*
   * Lo agendado sale solo de la lista, y con ello de la selección: `seleccion` y
   * `fechaFila` guardan ids, pero TODO lo que se lee de ellos —cuántas van marcadas,
   * qué se manda en la tanda, qué fecha lleva un renglón— se cruza antes contra
   * `d.sinAgendar`. Un id que ya no está en la lista no cuenta para nada.
   *
   * Por eso no hay un efecto que los limpie: sincronizar estado con estado en un
   * efecto es una renderizada de más para conseguir lo que el cruce ya da, y era la
   * puerta por la que "18 seleccionadas" llegaba a contar órdenes ya repartidas.
   */

  /** Agenda UNA orden: el técnico que se acaba de elegir, el día de su renglón. */
  const agendar = useCallback(async (t: Tarjeta, staffId: string) => {
    const cuando = fechaFila[t.id] ?? diaRef.current;
    if (!cuando) return;
    setGuardando(true);
    try {
      const r = await authFetch("/support/agenda/mover", {
        method: "POST",
        body: JSON.stringify({ ticketId: t.id, staffId, fecha: cuando }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.message || "No se pudo agendar la orden");
      const quien = d?.columnas.find((c) => c.staffId === staffId)?.nombre ?? "el técnico";
      toast(`Orden #${t.code ?? "—"} → ${quien} · ${diaCorto(cuando)}`, "calendar-check");
      await cargar(diaRef.current);
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally { setGuardando(false); }
  }, [authFetch, cargar, d, fechaFila]);

  /**
   * Agenda de una vez todas las marcadas, al final del día de ese técnico.
   *
   * Van en el orden en que se ven en la lista (no en el que se fueron marcando): es
   * el orden que la cajera tiene delante, ya puesto por urgencia y antigüedad —o por
   * la columna que haya pulsado—.
   *
   * Se manda una llamada POR FECHA: casi siempre es una sola (todas al día común),
   * pero si entre las marcadas hay renglones con día propio, cada uno tiene que
   * viajar con el suyo o el lote le pisaría la fecha que la cajera ya eligió.
   */
  const agendarLote = useCallback(async (staffId: string) => {
    const marcadas = (d?.sinAgendar ?? []).filter((t) => seleccion.has(t.id));
    if (!staffId || !marcadas.length) return;
    const porFecha = new Map<string, string[]>();
    for (const t of marcadas) {
      const cuando = fechaDe(t);
      if (!cuando) continue;
      porFecha.set(cuando, [...(porFecha.get(cuando) ?? []), t.id]);
    }
    setGuardando(true);
    try {
      let agendadas = 0;
      let omitidas = 0;
      let tecnico = "";
      for (const [cuando, ticketIds] of porFecha) {
        const r = await authFetch("/support/agenda/mover-lote", {
          method: "POST",
          body: JSON.stringify({ ticketIds, staffId, fecha: cuando }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.message || "No se pudieron agendar las órdenes");
        const j = await r.json();
        agendadas += j.agendadas ?? 0;
        omitidas += j.omitidas ?? 0;
        tecnico = j.tecnico ?? tecnico;
      }
      setSeleccion(new Set());
      setAQuien("");
      toast(
        `${agendadas} ${agendadas === 1 ? "orden agendada" : "órdenes agendadas"} a ${tecnico}` +
          (porFecha.size > 1 ? ` en ${porFecha.size} días` : "") +
          (omitidas ? ` · ${omitidas} ya no estaban` : ""),
        "calendar-check",
      );
      await cargar(diaRef.current);
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally { setGuardando(false); }
  }, [authFetch, cargar, d, fechaDe, seleccion]);

  const alternar = (id: string) => setSeleccion((s) => {
    const n = new Set(s);
    if (!n.delete(id)) n.add(id);
    return n;
  });

  const lista = d?.sinAgendar ?? [];
  const marcadas = lista.filter((t) => seleccion.has(t.id)).length;
  const todas = lista.length > 0 && marcadas === lista.length;
  /** "Todas" son las que hay A LA VISTA: con filtro puesto, las que coinciden. */
  const alternarTodas = () => setSeleccion((s) => {
    if (todas) {
      const n = new Set(s);
      for (const t of lista) n.delete(t.id);
      return n;
    }
    return new Set([...s, ...lista.map((t) => t.id)]);
  });

  const columnas: Column<Tarjeta>[] = useMemo(() => {
    const tecnicos = d?.columnas ?? [];
    /** ¿Esta fila va al día común de arriba? Sólo entonces la pista de zona vale. */
    const mismaFecha = (t: Tarjeta) => !fechaFila[t.id] || fechaFila[t.id] === dia;
    return [
      {
        key: "orden",
        header: "Orden",
        sortValue: (t) => t.code ?? 0,
        render: (t) => (
          <span className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={seleccion.has(t.id)}
              onChange={() => alternar(t.id)}
              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-brand"
              aria-label={`Seleccionar la orden ${t.code ?? ""}`}
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                <Link href={`/soporte/${t.id}`} className="font-mono text-[12px] font-semibold text-text-secondary hover:text-brand hover:underline">
                  #{t.code ?? "—"}
                </Link>
                {t.status === "REALIZANDO" && (
                  <span className="rounded bg-warning-soft px-1 py-0.5 text-[9px] font-bold uppercase text-warning-text">En curso</span>
                )}
              </span>
              <span className="block text-[12.5px] font-semibold leading-snug text-text-primary" title={t.type}>{t.type}</span>
              <span className="block text-[11px] capitalize text-text-tertiary">{t.subject}</span>
            </span>
          </span>
        ),
      },
      {
        key: "cliente",
        header: "Cliente",
        sortValue: (t) => t.cliente ?? "",
        render: (t) => (
          <span className="block min-w-0">
            <span className="block truncate text-[12.5px] text-text-primary">{t.cliente ?? "—"}</span>
            {t.abonado != null && <span className="block font-mono text-[11px] text-text-tertiary">{t.abonado}</span>}
            {t.telefono && (
              <span className="flex items-center gap-1 text-[11px] text-text-tertiary">
                <Icon name="phone" size={10} className="shrink-0" /> {t.telefono}
              </span>
            )}
            {/* Ya hubo un viaje a esa casa y no se pudo: es la cola que se reagenda
                primero, y el motivo decide el día (llamar antes, mandar material). */}
            {t.noAtendida && (
              <span className="mt-1 flex items-start gap-1 rounded bg-warning-soft px-1.5 py-1 text-[10.5px] text-warning-text">
                <Icon name="alert-triangle" size={10} className="mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <b>No se pudo atender</b>{t.noAtendida.motivo ? `: ${t.noAtendida.motivo}` : ""}
                </span>
              </span>
            )}
          </span>
        ),
      },
      {
        // Lo que hay que saber para atenderla, al lado del cliente (2026-09-02, a
        // pedido del usuario). Estaba en la tarjeta del tablero viejo y se perdió al
        // pasar a tabla: sin esto hay que abrir la orden para saber qué se va a hacer,
        // y repartir 120 al día abriendo cada una no es repartir.
        //
        // Se pintan las DOS y pegadas: la falla corta (`problem`) casi nunca viene —45
        // de 200— y lo que de verdad describe el trabajo es la observación (`section`),
        // que traen 185. Mirar solo una dejaría la columna muda.
        key: "descripcion",
        header: "Descripción",
        sortValue: (t) => [t.problema, t.observacion].filter(Boolean).join(" · "),
        render: (t) => {
          const texto = [t.problema, t.observacion].filter(Boolean).join(" · ");
          if (!texto) return <span className="text-[12px] text-text-tertiary">—</span>;
          // Recortada a tres renglones y el resto en el título: las hay de 441
          // caracteres, y una sola de ésas estira la fila y descoloca la tabla entera.
          return (
            <span
              // Sin `block`: `line-clamp-3` fija `display:-webkit-box` y ponerle un
              // `block` al lado lo anulaba — la columna salía con las seis líneas de
              // una observación larga y estiraba la fila entera.
              className="line-clamp-3 max-w-[26rem] whitespace-pre-line text-[12px] leading-snug text-text-secondary"
              title={texto}
            >
              {texto}
            </span>
          );
        },
      },
      {
        key: "donde",
        header: "Dónde",
        sortValue: (t) => t.barrio ?? t.direccion ?? "",
        render: (t) => (
          <span className="block min-w-0 text-[12px] text-text-secondary">
            {t.barrio && <span className="block font-medium text-text-primary">{t.barrio}</span>}
            {t.direccion && <span className="block text-[11px] text-text-tertiary" title={t.direccion}>{t.direccion}</span>}
            {!t.barrio && !t.direccion && "—"}
          </span>
        ),
      },
      {
        key: "prioridad",
        header: "Prioridad",
        sortValue: (t) => RANGO_PRIORIDAD[t.priority ?? ""] ?? 9,
        render: (t) => (
          <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TONO_BADGE[TICKET_PRIORITY_TONE[t.priority ?? ""] ?? "default"]}`}>
            {t.priority ?? "—"}
          </span>
        ),
      },
      {
        key: "espera",
        header: "Espera",
        align: "right",
        sortValue: (t) => diasEsperando(t.created, d?.hoy ?? ""),
        render: (t) => {
          const dias = diasEsperando(t.created, d?.hoy ?? "");
          return (
            <span className={`whitespace-nowrap text-[12px] ${dias >= 15 ? "font-bold text-error-text" : dias >= 7 ? "font-semibold text-warning-text" : "text-text-tertiary"}`}>
              {dias === 0 ? "hoy" : `${dias} d`}
            </span>
          );
        },
      },
      {
        // La decisión entera, en un sitio: quién y cuándo. La clave dice "acciones"
        // para que en móvil la tarjeta la baje al pie, donde los mandos caben.
        key: "acciones",
        header: "Agendar a",
        sortable: false,
        render: (t) => (
          <span className="flex min-w-[15rem] flex-col gap-1.5 sm:flex-row sm:items-center">
            <Select
              value=""
              disabled={guardando}
              onChange={(e) => { if (e.target.value) void agendar(t, e.target.value); }}
              className="h-8 min-w-0 flex-1 !py-0 text-[11.5px]"
              aria-label={`Técnico para la orden ${t.code ?? ""}`}
            >
              <option value="">Técnico…</option>
              {tecnicos.map((c) => {
                // "ya tiene 3 aquí": lo que convierte el desplegable en una
                // recomendación sin quitarle a nadie la decisión. Sólo cuando la
                // fila va al día común, que es para el que se pidieron las zonas.
                const ya = mismaFecha(t) && t.barrioId ? zonas[c.staffId]?.[t.barrioId] ?? 0 : 0;
                return (
                  <option key={c.staffId} value={c.staffId}>
                    {c.nombre}{ya ? ` · ya tiene ${ya} en este barrio` : ""}
                  </option>
                );
              })}
            </Select>
            {/* El calendario del renglón. Arranca en la fecha común de arriba; se
                toca solo cuando ESTA visita va otro día, y se marca cuando se salió
                de la común para que no pase inadvertido al elegir el técnico. */}
            <input
              type="date"
              value={fechaDe(t)}
              onChange={(e) => e.target.value && setFechaFila((m) => ({ ...m, [t.id]: e.target.value }))}
              aria-label={`Día para la orden ${t.code ?? ""}`}
              className={`h-8 shrink-0 rounded-lg border bg-surface px-2 text-[11.5px] font-semibold ${
                fechaFila[t.id] && fechaFila[t.id] !== dia
                  ? "border-brand text-brand"
                  : "border-border-default text-text-secondary"
              }`}
            />
          </span>
        ),
      },
    ];
  }, [d, seleccion, guardando, agendar, fechaDe, fechaFila, dia, zonas]);

  if (authLoading || (!d && !err)) return <PageSkeleton />;
  if (err && !d) return <div className="p-6"><LoadError message="No se pudo cargar la agenda." onRetry={() => void cargar(fecha)} /></div>;
  if (!d) return <PageSkeleton />;

  const esHoy = d.fecha === d.hoy;

  return (
    <div className="flex flex-col gap-3">
      {/* La fecha COMÚN de la tanda. Es lo primero porque es la mitad de la decisión
          y casi nunca cambia dentro de una tanda: se pone una vez ("estoy repartiendo
          el jueves") y todos los renglones nacen con ella. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] font-semibold text-text-secondary">Agendar para</span>
          <button type="button" onClick={() => setFecha(sumarDias(d.fecha, -1))} aria-label="Día anterior"
            className="tap rounded-lg border border-border-default px-2 py-1.5 text-text-secondary hover:bg-surface-2">
            <Icon name="chevron-left" size={15} />
          </button>
          <input
            type="date"
            value={d.fecha}
            onChange={(e) => e.target.value && setFecha(e.target.value)}
            className="rounded-lg border border-border-default bg-surface px-2.5 py-1.5 text-[12.5px] font-semibold text-text-primary"
            aria-label="Día para el que se reparte"
          />
          <button type="button" onClick={() => setFecha(sumarDias(d.fecha, 1))} aria-label="Día siguiente"
            className="tap rounded-lg border border-border-default px-2 py-1.5 text-text-secondary hover:bg-surface-2">
            <Icon name="chevron-right" size={15} />
          </button>
          {!esHoy && (
            <button type="button" onClick={() => setFecha(d.hoy)}
              className="rounded-lg border border-border-default px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2">
              Hoy
            </button>
          )}
          <span className="text-[12px] text-text-tertiary first-letter:uppercase">{diaLargo(d.fecha)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {guardando && <Icon name="loader" size={15} className="animate-spin text-text-tertiary" />}
          <BotonExcel filtros={filtros} desde={d.fecha} />
        </div>
      </div>

      {/* Cuánto trabajo tiene puesto el día, en una línea.

          Aquí hubo un desplegable para ver la carga de CADA técnico —y antes de él,
          una tira con los 16 nombres—. Se fue el 2026-09-03 a pedido del usuario: la
          pregunta que contestaba ("¿cómo va de cargado fulano?") la responde mejor la
          pestaña «Por técnico», que enseña la agenda entera de cada uno y encima deja
          corregirla. Tener las dos era pagar un mando en la pantalla de trabajo por
          una respuesta peor.

          El TOTAL se queda: es una línea sin mando, y sin él no se sabe si el día va
          vacío o desbordado antes de empezar a repartir. */}
      {d.columnas.length > 0 && (
        <div className="text-[12px] text-text-secondary">
          <b className="text-text-primary">{d.columnas.reduce((n, c) => n + c.pendientes, 0)}</b>
          {d.columnas.reduce((n, c) => n + c.pendientes, 0) === 1 ? " visita puesta" : " visitas puestas"}
          {" "}entre {d.columnas.length} {d.columnas.length === 1 ? "técnico" : "técnicos"}
        </div>
      )}

      <BarraFiltros filtros={filtros} setFiltros={setFiltros} tipos={d.tipos} sedes={d.sedes} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-secondary">
        <span>
          <b className="text-text-primary">{d.sinAgendarSinFiltro ?? d.sinAgendarTotal}</b> órdenes abiertas sin día
        </span>
        {/* Solo cuando el filtro de verdad recorta algo. Elegir sede estrecha el
            ALCANCE, así que la cuenta "sin filtro" ya viene contada dentro de esa
            sede: sin esta comprobación el renglón decía "138 sin día · 138 coinciden
            con el filtro", el mismo número dos veces y con dos nombres distintos. */}
        {filtrando && d.sinAgendarTotal !== (d.sinAgendarSinFiltro ?? d.sinAgendarTotal) && (
          <>
            <span>·</span>
            <span className="font-semibold text-brand">
              {d.sinAgendarTotal === 1 ? "1 coincide" : `${d.sinAgendarTotal} coinciden`} con el filtro
            </span>
          </>
        )}
        {lista.length > 0 && (
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11.5px] font-semibold text-text-secondary">
            <input type="checkbox" checked={todas} onChange={alternarTodas} className="h-4 w-4 cursor-pointer accent-brand" />
            Seleccionar las {lista.length} de la lista
          </label>
        )}
      </div>

      {/* La barra de tanda solo aparece con algo marcado. Aquí SÍ hay botón aparte:
          un clic de más manda 40 órdenes de golpe, y elegir técnico no puede ser ya
          la orden de ejecutar cuando lo que se mueve es toda una tanda. */}
      {marcadas > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand bg-brand-soft/40 p-2.5">
          <span className="text-[12px] font-bold text-text-primary">
            {marcadas} {marcadas === 1 ? "seleccionada" : "seleccionadas"}
          </span>
          {/* Se valida contra las columnas de AHORA: al cambiar de sede, el técnico
              que estuviera elegido puede no existir ya en la lista, y mandar su id
              en el lote sería un 403 con 40 órdenes por medio. */}
          <Select
            value={d.columnas.some((c) => c.staffId === aQuien) ? aQuien : ""}
            onChange={(e) => setAQuien(e.target.value)}
            className="h-8 w-auto min-w-[10rem] !py-0 text-[12px]"
            aria-label="Técnico al que se agenda la tanda"
          >
            <option value="">Agendar a…</option>
            {d.columnas.map((c) => <option key={c.staffId} value={c.staffId}>{c.nombre}</option>)}
          </Select>
          <span className="text-[11.5px] text-text-secondary">
            para el <b className="text-text-primary">{diaCorto(d.fecha)}</b>
            {/* Un renglón con día propio se lleva el suyo aunque vaya en la tanda: si
                no se dice, la cajera daría por hecho que todo cae en el día de arriba. */}
            {(() => {
              const propios = lista.filter((t) => seleccion.has(t.id) && fechaFila[t.id] && fechaFila[t.id] !== d.fecha).length;
              return propios ? <span className="text-text-tertiary"> ({propios} con día propio)</span> : null;
            })()}
          </span>
          <button
            type="button"
            disabled={!d.columnas.some((c) => c.staffId === aQuien) || guardando}
            onClick={() => void agendarLote(aQuien)}
            className="tap rounded-lg bg-brand px-3 py-1.5 text-[12px] font-bold text-on-brand disabled:opacity-40"
          >
            Agendar {marcadas}
          </button>
          <button
            type="button"
            onClick={() => setSeleccion(new Set())}
            className="ml-auto text-[11.5px] font-semibold text-text-secondary hover:text-text-primary hover:underline"
          >
            Quitar selección
          </button>
        </div>
      )}

      <DataTable
        columns={columnas}
        rows={lista}
        empty={filtrando ? "Ninguna orden sin agendar coincide con el filtro." : "No queda nada sin agendar."}
      />

      {/* Lo que la búsqueda encontró pero YA tiene día.

          Sin esto, teclear el abonado de un cliente cuyo trabajo ya se repartió
          contestaba "Ninguna orden sin agendar coincide con el filtro" — y el cliente
          tenía dos órdenes abiertas, las dos con técnico y fecha. Quien busca un
          abonado quiere saber qué pasa con ese cliente, no auditar una bandeja: la
          respuesta honesta es "sí hay, están aquí", no "no hay nada".

          Va DEBAJO de la lista y en gris: es contexto, no trabajo por hacer. Lo que
          se reparte sigue siendo lo de arriba. */}
      {d.yaAgendadas && d.yaAgendadas.length > 0 && (
        <div className="rounded-xl border border-border-subtle bg-surface-2 p-3">
          <p className="mb-2 text-[12px] font-semibold text-text-secondary">
            {d.yaAgendadas.length === 1
              ? "1 orden de esta búsqueda ya tiene día"
              : `${d.yaAgendadas.length} órdenes de esta búsqueda ya tienen día`}
            {d.yaAgendadasHayMas ? " (se muestran las más próximas)" : ""}
          </p>
          <ul className="flex flex-col gap-1">
            {d.yaAgendadas.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
                <Link href={`/soporte/${o.id}`} className="font-semibold text-brand hover:underline">
                  #{o.code}
                </Link>
                <span className="text-text-primary">{o.tipo}</span>
                <span className="text-text-secondary">
                  {o.cliente ?? "Sin cliente"}
                  {o.abonado != null ? ` · ${o.abonado}` : ""}
                </span>
                <span className="ml-auto flex items-center gap-2 text-[11.5px] text-text-tertiary">
                  <span>{o.tecnico ?? "sin técnico"}</span>
                  {o.fecha && (
                    <button
                      type="button"
                      onClick={() => setFecha(o.fecha!)}
                      className="tap rounded-full border border-border-default bg-surface px-2 py-0.5 font-semibold text-text-secondary hover:bg-surface-2"
                      title="Ir a ese día"
                    >
                      {diaCorto(o.fecha)}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Lo que la búsqueda encontró pero ya está CERRADO (resuelto o anulado).
          Último recurso del servidor: sólo llega algo aquí cuando nada más
          coincidió con nada. Sin esto, buscar el código de una orden vieja era un
          silencio que se leía como "esto no existe" — y de 320.128 resueltas, 319.877
          nunca pasaron por la agenda, así que ni el panel de arriba las alcanza. */}
      {d.cerradas.length > 0 && (
        <div className="rounded-xl border border-border-subtle bg-surface-2 p-3">
          <p className="mb-2 text-[12px] font-semibold text-text-secondary">
            {d.cerradas.length === 1
              ? "1 orden de esta búsqueda ya está cerrada"
              : `${d.cerradas.length} órdenes de esta búsqueda ya están cerradas`}
          </p>
          <ul className="flex flex-col gap-1">
            {d.cerradas.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
                <Link href={`/soporte/${o.id}`} className="font-semibold text-brand hover:underline">
                  #{o.code}
                </Link>
                <span className="text-text-primary">{o.tipo}</span>
                <span className="text-text-secondary">
                  {o.cliente ?? "Sin cliente"}
                  {o.abonado != null ? ` · ${o.abonado}` : ""}
                </span>
                <span className="ml-auto flex items-center gap-2 text-[11.5px] text-text-tertiary">
                  <span className={o.estado === "ANULADA" ? "text-error-text" : ""}>
                    {o.estado === "ANULADA" ? "Anulada" : "Resuelta"}
                  </span>
                  {o.fecha && <span>{diaCorto(o.fecha)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {lista.length < d.sinAgendarTotal && (
        <p className="text-[11.5px] text-text-tertiary">
          Se muestran las {lista.length} más urgentes y antiguas de {d.sinAgendarTotal} sin agendar
          {filtrando ? " que coinciden con el filtro" : ""}. El resto aparece a medida que vayas repartiendo estas
          {filtrando ? ", o afinando la búsqueda" : ""}.
        </p>
      )}
    </div>
  );
}
