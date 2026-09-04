"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { toast } from "@/components/ui/Toast";
import { Select } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import { EtiquetaAtrasada } from "@/components/soporte/VisitaAgendada";
import { ModalRecorrido } from "./ModalRecorrido";
import { TICKET_PRIORITY_TONE } from "@/lib/support";
import {
  BarraFiltros, BotonExcel, TONO_BADGE, coincideTexto, diaCorto, diaLargo, hayFiltros, lunesDe, queryAgenda, sumarDias,
  type Filtros, type Sede, type Tarjeta, type TipoOrden, type YaAgendada,
} from "./comun";

/** Lo que hay en una casilla (un técnico, un día): sus visitas y su carga real. */
type Casilla = { ordenes: Tarjeta[]; total: number; pendientes: number; atrasadas: number };
type FilaTecnico = {
  staffId: string;
  nombre: string;
  /** Lo que tiene MÁS ALLÁ del tramo, con la primera fecha: es adonde salta. */
  despues: { cuantas: number; primera: string | null };
  dias: Record<string, Casilla>;
};
type Semana = {
  desde: string; hasta: string; dias: string[]; hoy: string; filtrando: boolean;
  /** Las sedes ofrecibles y la elegida. Mismo contrato que el tablero del día. */
  sedes: Sede[]; sede: string | null;
  /** El texto buscado. La rejilla NO viene recortada por él: aquí se usa para atenuar. */
  q: string;
  tipos: TipoOrden[];
  sinAgendar: Tarjeta[]; sinAgendarTotal: number; sinAgendarSinFiltro: number | null;
  /** Las que coinciden pero caen fuera del tramo: de quién son y para cuándo. */
  fuera: Tarjeta[];
  /** Las que coinciden pero ya están RESUELTAS/ANULADAS. `[]` casi siempre. */
  cerradas: YaAgendada[];
  columnas: FilaTecnico[];
};

export type PorTecnicoProps = {
  fecha: string | null;
  setFecha: (f: string) => void;
  filtros: Filtros;
  setFiltros: Dispatch<SetStateAction<Filtros>>;
};

/**
 * CÓMO QUEDÓ: la agenda de cada técnico, día por día y en el orden en que la va a
 * hacer (2026-09-02, a pedido del usuario).
 *
 * Es la otra mitad de repartir. En "Repartir" se decide quién y cuándo mirando la
 * orden; aquí se comprueba el resultado mirando a la PERSONA: qué le quedó, qué días,
 * y sobre todo **en qué orden** — que es lo que el técnico va a seguir y lo único que
 * no se ve mientras se reparte.
 *
 * Por eso el número de cada visita es lo primero de cada renglón y se puede subir y
 * bajar aquí mismo: corregir el recorrido ("la del barrio Centro primero, que le
 * queda de paso") es el trabajo propio de esta pantalla, y mandar a la cajera de
 * vuelta a la lista para eso sería no haberla enseñado.
 *
 * El puesto lo cuenta el SERVIDOR sobre la casilla entera: con un filtro puesto se
 * salta huecos —1, 4, 7— y eso es lo correcto, el técnico hará la 4 en cuarto lugar
 * aunque aquí sólo se estén mirando las urgentes.
 */
export function VistaPorTecnico({ fecha, setFecha, filtros, setFiltros }: PorTecnicoProps) {
  const { loading: authLoading, authFetch } = useAuth();
  const [d, setD] = useState<Semana | null>(null);
  const [err, setErr] = useState(false);
  const [guardando, setGuardando] = useState(false);
  /** Cuántos días se miran de una vez. 7 es la semana; 14 es "y la que viene". */
  const [dias, setDias] = useState(7);
  /** Ver a uno solo. Con 12 técnicos, la respuesta a "¿qué le tocó a Brayan?". */
  const [soloTecnico, setSoloTecnico] = useState("");
  /** La jornada cuyo recorrido se está mirando: técnico + día. `null` = ninguna. */
  const [recorrido, setRecorrido] = useState<{ staffId: string; dia: string } | null>(null);

  const claveFiltros = useMemo(() => queryAgenda(filtros), [filtros]);
  const filtrosRef = useRef(filtros);
  useEffect(() => { filtrosRef.current = filtros; }, [filtros]);

  // El lunes del tramo que se mira (la semana laboral empieza ahí) se calcula ABAJO,
  // después de la guarda de carga: en el primer render no hay ni `fecha` —vale `null`
  // mientras no se navegue— ni tablero del que sacar "hoy", y `lunesDe("")` reventaba
  // la pantalla entera con `Invalid time value`.
  const desdeRef = useRef<string | null>(null);
  useEffect(() => { desdeRef.current = fecha ? lunesDe(fecha) : d?.desde ?? null; }, [fecha, d]);

  /** Solo la ÚLTIMA carga pedida puede pintar. Ver la nota en `VistaRepartir`. */
  const pedido = useRef(0);

  const cargar = useCallback(async (f?: string | null) => {
    const mio = ++pedido.current;
    setErr(false);
    try {
      const qs = queryAgenda(filtrosRef.current, { desde: f ? lunesDe(f) : null, dias });
      const r = await authFetch(`/support/agenda/semana${qs ? `?${qs}` : ""}`);
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      if (mio === pedido.current) setD(j);
    } catch {
      if (mio === pedido.current) setErr(true);
    }
  }, [authFetch, dias]);

  useEffect(() => {
    if (authLoading) return;
    const t = window.setTimeout(() => { void cargar(fecha); }, filtrosRef.current.q.trim() ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [authLoading, fecha, claveFiltros, dias, cargar]);

  /**
   * Mueve UNA visita: la reordena dentro del día, la pasa a otro técnico o a otro
   * día, o la devuelve a la cola sin repartir.
   *
   * El día viaja EXPLÍCITO y no se toma de "el día que se está viendo": aquí hay
   * siete a la vez, y ese es justamente el punto.
   *
   * `antesDe`/`despuesDe` mandan la tarjeta VECINA y no un número: la casilla de hoy
   * mezcla lo agendado para hoy con lo arrastrado de días anteriores, que conserva su
   * propia numeración, y un "puesto 2" no dice de cuál de las dos habla.
   */
  const mover = useCallback(async (
    ticketId: string,
    staffId: string | null,
    dia: string | null,
    vecina?: { antesDe?: string; despuesDe?: string },
  ) => {
    setGuardando(true);
    try {
      const r = await authFetch("/support/agenda/mover", {
        method: "POST",
        body: JSON.stringify({ ticketId, staffId, fecha: staffId ? dia : null, ...vecina }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.message || "No se pudo mover la orden");
      await cargar(desdeRef.current);
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally { setGuardando(false); }
  }, [authFetch, cargar]);

  if (authLoading || (!d && !err)) return <PageSkeleton />;
  if (err && !d) return <div className="p-6"><LoadError message="No se pudo cargar la agenda." onRetry={() => void cargar(fecha)} /></div>;
  if (!d) return <PageSkeleton />;

  const filtrando = hayFiltros(filtros);
  /** El lunes del tramo. Sale del tablero cargado, que es quien sabe qué día es hoy. */
  const desde = lunesDe(fecha ?? d.desde);
  // El técnico elegido, solo si sigue existiendo: al cambiar de sede, filtrar por uno
  // que ya no está dejaba la pantalla vacía con un desplegable que decía su nombre.
  const soloValido = d.columnas.some((c) => c.staffId === soloTecnico) ? soloTecnico : "";
  const tecnicos = soloValido ? d.columnas.filter((c) => c.staffId === soloValido) : d.columnas;
  const enTramo = (c: FilaTecnico) => d.dias.reduce((s, x) => s + (c.dias[x]?.pendientes ?? 0), 0);
  /** Los que no tienen NADA en el tramo van al final: la lista empieza por trabajo. */
  const ordenados = [...tecnicos].sort((a, b) => (enTramo(b) > 0 ? 1 : 0) - (enTramo(a) > 0 ? 1 : 0));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => setFecha(sumarDias(desde, -7))} aria-label="Semana anterior"
            className="tap rounded-lg border border-border-default px-2 py-1.5 text-text-secondary hover:bg-surface-2">
            <Icon name="chevron-left" size={15} />
          </button>
          <span className="text-[12.5px] font-semibold text-text-primary first-letter:uppercase">
            {diaCorto(d.desde)} — {diaCorto(d.hasta)}
          </span>
          <button type="button" onClick={() => setFecha(sumarDias(desde, 7))} aria-label="Semana siguiente"
            className="tap rounded-lg border border-border-default px-2 py-1.5 text-text-secondary hover:bg-surface-2">
            <Icon name="chevron-right" size={15} />
          </button>
          {(d.hoy < d.desde || d.hoy > d.hasta) && (
            <button type="button" onClick={() => setFecha(d.hoy)}
              className="rounded-lg border border-border-default px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2">
              Esta semana
            </button>
          )}
          <Select value={String(dias)} onChange={(e) => setDias(Number(e.target.value))} className="h-8 w-auto !py-0 text-[12px]" aria-label="Cuántos días se miran">
            <option value="7">7 días</option>
            <option value="14">14 días</option>
          </Select>
          {/* Igual que el de la tanda en "Repartir": se valida contra las columnas de
              AHORA, porque al cambiar de sede el técnico elegido puede no estar. */}
          <Select
            value={d.columnas.some((c) => c.staffId === soloTecnico) ? soloTecnico : ""}
            onChange={(e) => setSoloTecnico(e.target.value)}
            className="h-8 w-auto max-w-[13rem] !py-0 text-[12px]"
            aria-label="Ver un solo técnico"
          >
            <option value="">Todos los técnicos</option>
            {d.columnas.map((c) => <option key={c.staffId} value={c.staffId}>{c.nombre}</option>)}
          </Select>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {guardando && <Icon name="loader" size={15} className="animate-spin text-text-tertiary" />}
          <BotonExcel filtros={filtros} desde={d.desde} hasta={d.hasta} />
        </div>
      </div>

      <BarraFiltros filtros={filtros} setFiltros={setFiltros} tipos={d.tipos} sedes={d.sedes} />

      {/* Buscar una orden que está agendada para OTRA semana no puede devolver una
          pantalla vacía: se dice de quién es y para cuándo, con un salto a su día. */}
      {filtrando && d.fuera.length > 0 && (
        <div className="rounded-xl border border-info-border bg-info-soft/40 p-2.5">
          <div className="mb-1.5 text-[12px] font-bold text-text-primary">
            {d.fuera.length === 1 ? "1 orden coincide pero está fuera de este tramo" : `${d.fuera.length} órdenes coinciden pero están fuera de este tramo`}
          </div>
          <div className="flex flex-col gap-1">
            {d.fuera.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => t.agendadaPara && setFecha(t.agendadaPara.slice(0, 10))}
                className="tap flex items-center gap-2 rounded-lg border border-border-subtle bg-surface px-2 py-1.5 text-left text-[11.5px] hover:bg-surface-2"
              >
                <span className="font-mono font-semibold text-text-secondary">#{t.code ?? "—"}</span>
                <span className="min-w-0 flex-1 truncate text-text-primary">{t.type}{t.cliente ? ` · ${t.cliente}` : ""}</span>
                <span className="shrink-0 font-semibold text-text-secondary">{t.tecnico ?? "sin técnico"}</span>
                <span className="shrink-0 font-semibold text-brand">{t.agendadaPara ? diaCorto(t.agendadaPara.slice(0, 10)) : "—"}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Igual que arriba pero para lo que ya está CERRADO (resuelto o anulado).
          Último recurso: sólo llega algo aquí cuando nada más coincidió con nada
          —ni sin agendar, ni en la rejilla, ni fuera del tramo—. De 320.128 órdenes
          resueltas, 319.877 nunca pasaron por la agenda, así que sin esto buscar su
          código era un silencio que se leía como "esto no existe". */}
      {filtrando && d.cerradas.length > 0 && (
        <div className="rounded-xl border border-border-subtle bg-surface-2 p-2.5">
          <div className="mb-1.5 text-[12px] font-bold text-text-secondary">
            {d.cerradas.length === 1 ? "1 orden coincide pero ya está cerrada" : `${d.cerradas.length} órdenes coinciden pero ya están cerradas`}
          </div>
          <div className="flex flex-col gap-1">
            {d.cerradas.map((o) => (
              <Link
                key={o.id}
                href={`/soporte/${o.id}`}
                className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface px-2 py-1.5 text-[11.5px] hover:bg-surface-2"
              >
                <span className="font-mono font-semibold text-text-secondary">#{o.code ?? "—"}</span>
                <span className="min-w-0 flex-1 truncate text-text-primary">{o.tipo}{o.cliente ? ` · ${o.cliente}` : ""}</span>
                <span className={`shrink-0 font-semibold ${o.estado === "ANULADA" ? "text-error-text" : "text-text-secondary"}`}>
                  {o.estado === "ANULADA" ? "Anulada" : "Resuelta"}
                </span>
                {o.fecha && <span className="shrink-0 text-text-tertiary">{diaCorto(o.fecha)}</span>}
              </Link>
            ))}
          </div>
        </div>
      )}

      {ordenados.length === 0 && (
        <div className="rounded-xl border border-dashed border-border-default px-6 py-10 text-center text-[12px] text-text-tertiary">
          No hay técnicos de tu sede para agendar.
        </div>
      )}

      {ordenados.map((c) => {
        const pendientes = enTramo(c);
        const conTrabajo = d.dias.filter((x) => (c.dias[x]?.ordenes.length ?? 0) > 0 || (c.dias[x]?.total ?? 0) > 0);
        return (
          <div key={c.staffId} className="shrink-0 overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-sm">
            <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-surface-2 px-3 py-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                <Icon name="hard-hat" size={14} />
              </span>
              <span className="min-w-0 truncate text-[13px] font-bold text-text-primary">{c.nombre}</span>
              <span className="text-[11.5px] text-text-secondary">
                {pendientes === 0 ? "sin visitas pendientes en el tramo" : `${pendientes} ${pendientes === 1 ? "visita pendiente" : "visitas pendientes"}`}
              </span>
              {/* Lo que tiene MÁS ALLÁ del tramo. Sin decirlo, la fila de un técnico
                  con quince visitas en octubre se lee como una semana tranquila. */}
              {c.despues.cuantas > 0 && (
                <button
                  type="button"
                  onClick={() => c.despues.primera && setFecha(c.despues.primera)}
                  className="tap rounded-full border border-border-default bg-surface px-2 py-0.5 text-[11px] font-semibold text-text-secondary hover:bg-surface-2"
                  title={`Tiene ${c.despues.cuantas} más adelante. Ir a la primera.`}
                >
                  +{c.despues.cuantas} más adelante{c.despues.primera ? ` · ${diaCorto(c.despues.primera)}` : ""}
                </button>
              )}
            </div>

            {conTrabajo.length === 0 ? (
              <div className="px-3 py-5 text-center text-[11.5px] text-text-tertiary">
                {filtrando ? "Ninguna de sus visitas coincide con el filtro" : "No tiene nada agendado en este tramo"}
              </div>
            ) : (
              <div className="divide-y divide-border-subtle">
                {conTrabajo.map((x) => {
                  const casilla = c.dias[x];
                  const ordenes = casilla?.ordenes ?? [];
                  return (
                    <div key={x} className="px-3 py-2">
                      <div className="mb-1.5 flex items-center gap-2">
                        <span className={`text-[11.5px] font-bold first-letter:uppercase ${x === d.hoy ? "text-brand" : "text-text-secondary"}`}>
                          {diaLargo(x)}{x === d.hoy ? " · hoy" : ""}
                        </span>
                        <span className="text-[11px] text-text-tertiary">
                          {casilla.pendientes} {casilla.pendientes === 1 ? "pendiente" : "pendientes"}
                          {casilla.total > casilla.pendientes ? ` · ${casilla.total - casilla.pendientes} cerrada${casilla.total - casilla.pendientes === 1 ? "" : "s"}` : ""}
                          {casilla.atrasadas ? ` · ${casilla.atrasadas} arrastrada${casilla.atrasadas === 1 ? "" : "s"}` : ""}
                        </span>
                        {/* Con una sola visita pendiente no hay recorrido que ordenar:
                            el botón sólo aparece cuando hay una decisión que tomar. */}
                        {casilla.pendientes > 1 && (
                          <button
                            type="button"
                            onClick={() => setRecorrido({ staffId: c.staffId, dia: x })}
                            className="tap ml-auto flex items-center gap-1 rounded-full border border-border-default bg-surface px-2 py-0.5 text-[11px] font-semibold text-text-secondary hover:bg-surface-2"
                            title="Proponer en qué orden hacer estas visitas para no cruzar la ciudad dos veces"
                          >
                            <Icon name="navigation" size={11} />
                            Ordenar recorrido
                          </button>
                        )}
                      </div>

                      {ordenes.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border-subtle px-3 py-2 text-center text-[11px] text-text-tertiary">
                          Ninguna de las {casilla.total} de este día coincide con el filtro
                        </div>
                      ) : (
                        <ol className="flex flex-col gap-1">
                          {ordenes.map((t, i) => (
                            <RenglonVisita
                              key={t.id}
                              t={t}
                              dia={x}
                              staffId={c.staffId}
                              tecnicos={d.columnas}
                              /* El texto no recorta la rejilla: ATENÚA. Recortar dejaría
                                 huecos que se leen como jornada libre. */
                              atenuada={!!d.q && !coincideTexto(t, d.q)}
                              guardando={guardando}
                              onSubir={i > 0 ? () => void mover(t.id, c.staffId, x, { antesDe: ordenes[i - 1].id }) : undefined}
                              onBajar={i < ordenes.length - 1 ? () => void mover(t.id, c.staffId, x, { despuesDe: ordenes[i + 1].id }) : undefined}
                              onPasarA={(destino) => void mover(t.id, destino, x)}
                              onCambiarDia={(nuevo) => void mover(t.id, c.staffId, nuevo)}
                              onQuitar={() => void mover(t.id, null, null)}
                            />
                          ))}
                        </ol>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {d.sinAgendarTotal > 0 && (
        <p className="text-[11.5px] text-text-tertiary">
          Quedan <b className="text-text-secondary">{d.sinAgendarSinFiltro ?? d.sinAgendarTotal}</b> órdenes abiertas sin día.
          Se reparten en la pestaña «Repartir».
        </p>
      )}

      {recorrido && (
        <ModalRecorrido
          open
          staffId={recorrido.staffId}
          fecha={recorrido.dia}
          onClose={() => setRecorrido(null)}
          onAplicado={() => void cargar(desdeRef.current)}
        />
      )}
    </div>
  );
}

/**
 * Una visita dentro de la jornada de un técnico.
 *
 * El número va delante y grande porque es el dato de esta pantalla: no es un adorno
 * de la lista, es el orden en que el técnico va a salir a hacerlas. Los mandos van a
 * la derecha y siempre visibles —nada de aparecer al pasar el ratón—: esto se abre
 * también desde la tableta de la ventanilla, donde no hay ratón que pasar.
 */
function RenglonVisita({
  t, dia, staffId, tecnicos, atenuada, guardando, onSubir, onBajar, onPasarA, onCambiarDia, onQuitar,
}: {
  t: Tarjeta; dia: string; staffId: string;
  tecnicos: { staffId: string; nombre: string }[];
  atenuada: boolean; guardando: boolean;
  onSubir?: () => void; onBajar?: () => void;
  onPasarA: (staffId: string) => void;
  onCambiarDia: (dia: string) => void;
  onQuitar: () => void;
}) {
  const tono = TICKET_PRIORITY_TONE[t.priority ?? ""] ?? "default";
  const enCurso = t.status === "REALIZANDO";
  const cerrada = t.status === "RESUELTO" || t.status === "ANULADA";
  return (
    <li className={`flex flex-col gap-1.5 rounded-lg border px-2 py-1.5 sm:flex-row sm:items-center sm:gap-2 ${
      enCurso ? "border-warning-border bg-warning-soft/20" : "border-border-subtle bg-surface"
    } ${cerrada ? "opacity-60" : ""} ${atenuada ? "opacity-40" : ""}`}>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-on-brand">
        {t.puesto ?? t.seq ?? "—"}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <Link href={`/soporte/${t.id}`} className="font-mono text-[11px] font-semibold text-text-secondary hover:text-brand hover:underline">
            #{t.code ?? "—"}
          </Link>
          <span className="min-w-0 truncate text-[12.5px] font-semibold text-text-primary" title={t.type}>{t.type}</span>
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${TONO_BADGE[tono]}`}>{t.priority ?? "—"}</span>
          {t.atrasada && <EtiquetaAtrasada desde={t.agendadaPara} />}
          {enCurso && <span className="rounded bg-warning-soft px-1 py-0.5 text-[9px] font-bold uppercase text-warning-text">En curso</span>}
          {t.status === "RESUELTO" && <span className="rounded bg-success-soft px-1 py-0.5 text-[9px] font-bold uppercase text-success-text">Resuelta</span>}
          {t.status === "ANULADA" && <span className="rounded bg-surface-2 px-1 py-0.5 text-[9px] font-bold uppercase text-text-tertiary">Anulada</span>}
        </span>
        <span className="block truncate text-[11.5px] text-text-secondary">
          {t.cliente ?? "—"}{t.abonado ? ` · ${t.abonado}` : ""}
          {t.barrio ? ` · ${t.barrio}` : t.direccion ? ` · ${t.direccion}` : ""}
        </span>
      </span>

      {/* Una visita ya cerrada no se reordena ni se pasa a nadie: el trabajo está
          hecho y moverla sólo reescribiría un recorrido que ya ocurrió.

          En móvil los mandos son su propio bloque y el calendario BAJA a su
          renglón (`w-full` + `flex-wrap`): en una línea de 390 px, entre las dos
          flechas, la equis y una fecha completa, al desplegable le quedaban 55 px y
          "Pasar a…" se leía "Pasa". Desde sm van todos pegados a la derecha. */}
      {!cerrada && (
        <span className="flex w-full shrink-0 flex-wrap items-center gap-1 sm:w-auto sm:flex-nowrap">
          <button type="button" onClick={onSubir} disabled={!onSubir || guardando} title="Subir en la jornada" aria-label={`Subir la orden ${t.code ?? ""}`}
            className="tap rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary disabled:opacity-30">
            <Icon name="chevron-up" size={14} />
          </button>
          <button type="button" onClick={onBajar} disabled={!onBajar || guardando} title="Bajar en la jornada" aria-label={`Bajar la orden ${t.code ?? ""}`}
            className="tap rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary disabled:opacity-30">
            <Icon name="chevron-down" size={14} />
          </button>
          <Select
            value=""
            disabled={guardando}
            onChange={(e) => e.target.value && onPasarA(e.target.value)}
            className="h-7 min-w-0 flex-1 !py-0 text-[11px] sm:w-auto sm:max-w-[8.5rem] sm:flex-none"
            aria-label={`Pasar la orden ${t.code ?? ""} a otro técnico`}
          >
            <option value="">Pasar a…</option>
            {tecnicos.filter((c) => c.staffId !== staffId).map((c) => <option key={c.staffId} value={c.staffId}>{c.nombre}</option>)}
          </Select>
          <input
            type="date"
            value={dia}
            disabled={guardando}
            onChange={(e) => e.target.value && e.target.value !== dia && onCambiarDia(e.target.value)}
            aria-label={`Cambiar el día de la orden ${t.code ?? ""}`}
            className="order-last h-7 w-full shrink-0 rounded-lg border border-border-default bg-surface px-1.5 text-[11px] font-semibold text-text-secondary sm:order-none sm:w-auto"
          />
          <button type="button" onClick={onQuitar} disabled={guardando} title="Quitar de la agenda (vuelve a sin repartir)" aria-label={`Quitar de la agenda la orden ${t.code ?? ""}`}
            className="tap rounded p-1 text-text-tertiary hover:bg-error-soft hover:text-error-text disabled:opacity-30">
            <Icon name="x" size={14} />
          </button>
        </span>
      )}
    </li>
  );
}
