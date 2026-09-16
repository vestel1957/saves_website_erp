"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type DragEvent, type SetStateAction } from "react";
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
import { ChipServicio } from "@/components/soporte/ChipServicio";
import { AvisoEquipo } from "@/components/soporte/AvisoEquipo";
import {
  BarraFiltros, BotonExcel, TONO_BADGE, coincideTexto, diaCorto, diaLargo, hayFiltros, lunesDe, queryAgenda, sumarDias,
  type Filtros, type Sede, type Tarjeta, type TipoOrden, type Vecina, type YaAgendada,
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

/** Una casilla concreta: de quién es y de qué día. El destino de cualquier movimiento. */
type Destino = { staffId: string; dia: string };
/** Dónde va a caer lo que se está arrastrando: la casilla y el hueco (índice) dentro de ella. */
type Hueco = Destino & { i: number };

export type PorTecnicoProps = {
  fecha: string | null;
  setFecha: (f: string) => void;
  filtros: Filtros;
  setFiltros: Dispatch<SetStateAction<Filtros>>;
};

/** Qué técnicos dejó plegados quien mira. Se recuerda entre visitas a la pantalla. */
const CLAVE_PLEGADOS = "agenda:tecnicos-plegados";
const leerPlegados = (): string[] => {
  try { return JSON.parse(window.localStorage.getItem(CLAVE_PLEGADOS) ?? "[]") as string[]; } catch { return []; }
};
const guardarPlegados = (ids: string[]) => {
  try { window.localStorage.setItem(CLAVE_PLEGADOS, JSON.stringify(ids)); } catch { /* modo privado */ }
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
 * Por eso el número de cada visita es lo primero de cada renglón y la visita se
 * ARRASTRA para cambiarla de sitio: corregir el recorrido ("la del barrio Centro
 * primero, que le queda de paso") es el trabajo propio de esta pantalla, y mandar a
 * la cajera de vuelta a la lista para eso sería no haberla enseñado. Las flechas
 * siguen ahí porque arrastrar no existe con el dedo: en la tableta de la ventanilla
 * son el único modo de reordenar (ver `RenglonVisita`).
 *
 * El puesto lo cuenta el SERVIDOR sobre la casilla entera: con un filtro puesto se
 * salta huecos —1, 4, 7— y eso es lo correcto, el técnico hará la 4 en cuarto lugar
 * aunque aquí sólo se estén mirando las urgentes.
 */
export function VistaPorTecnico({ fecha, setFecha, filtros, setFiltros }: PorTecnicoProps) {
  const { loading: authLoading, authFetch } = useAuth();
  const [d, setD] = useState<Semana | null>(null);
  const [err, setErr] = useState(false);
  /** Cuántos movimientos van camino del servidor. Sólo pinta el reloj: no bloquea nada. */
  const [enVuelo, setEnVuelo] = useState(0);
  /** Cuántos días se miran de una vez. 7 es la semana; 14 es "y la que viene". */
  const [dias, setDias] = useState(7);
  /** Ver a uno solo. Con 12 técnicos, la respuesta a "¿qué le tocó a Brayan?". */
  const [soloTecnico, setSoloTecnico] = useState("");
  /** La jornada cuyo recorrido se está mirando: técnico + día. `null` = ninguna. */
  const [recorrido, setRecorrido] = useState<{ staffId: string; dia: string } | null>(null);
  /** Los técnicos plegados. En el servidor no hay `localStorage`, y leerlo ya en el
   *  primer render del navegador no descuadra la hidratación porque mientras no hay
   *  datos las dos partes pintan el mismo esqueleto. */
  const [plegados, setPlegados] = useState<string[]>(() => (typeof window === "undefined" ? [] : leerPlegados()));
  const alternarPlegado = useCallback((staffId: string) => {
    setPlegados((p) => {
      const siguiente = p.includes(staffId) ? p.filter((x) => x !== staffId) : [...p, staffId];
      guardarPlegados(siguiente);
      return siguiente;
    });
  }, []);

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

  /** Movimientos que aún no han contestado, y si al vaciarse hay que releer del servidor. */
  const pendientes = useRef(0);
  const debeRecargar = useRef(false);
  /** Los `mover` viajan EN FILA: el servidor traduce "detrás de esta" contra lo que ya
   *  tiene guardado, así que dos arrastres seguidos adelantándose se pisarían. */
  const cola = useRef<Promise<unknown>>(Promise.resolve());

  /**
   * Mueve UNA visita: la reordena dentro del día, la pasa a otro técnico o a otro
   * día, o la devuelve a la cola sin repartir.
   *
   * **Se pinta primero y se guarda después.** Antes se esperaba al servidor y se
   * recargaba la semana entera en cada movimiento: la pantalla se quedaba muerta un
   * segundo, los mandos se apagaban y la lista daba un salto — reordenar cinco
   * visitas eran cinco esperas. Ahora la lista se reordena en el sitio y la petición
   * va detrás; si el servidor la rechaza, se avisa y se relee (que es lo único que
   * puede devolver la verdad).
   *
   * El día viaja EXPLÍCITO y no se toma de "el día que se está viendo": aquí hay
   * siete a la vez, y ese es justamente el punto.
   *
   * `antesDe`/`despuesDe` mandan la tarjeta VECINA y no un número: la casilla de hoy
   * mezcla lo agendado para hoy con lo arrastrado de días anteriores, que conserva su
   * propia numeración, y un "puesto 2" no dice de cuál de las dos habla.
   */
  const mover = useCallback((
    ticketId: string,
    destino: Destino | null,
    vecina?: Vecina,
    /** `true` cuando el movimiento saca la visita de lo que se ve (otro tramo): ahí
     *  no hay nada que pintar en su sitio y hace falta releer las cuentas. */
    fueraDeLaVista?: boolean,
  ) => {
    setD((prev) => (prev ? moverEnMemoria(prev, ticketId, destino, vecina) : prev));
    pendientes.current += 1;
    setEnVuelo((n) => n + 1);
    if (fueraDeLaVista) debeRecargar.current = true;
    cola.current = cola.current
      .then(async () => {
        const r = await authFetch("/support/agenda/mover", {
          method: "POST",
          body: JSON.stringify({ ticketId, staffId: destino?.staffId ?? null, fecha: destino?.dia ?? null, ...vecina }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.message || "No se pudo mover la orden");
      })
      .catch((e) => {
        toast(mensajeDeError(e), "alert-triangle");
        debeRecargar.current = true;
      })
      .then(async () => {
        pendientes.current -= 1;
        setEnVuelo((n) => n - 1);
        // Sólo cuando la fila se vacía: releer con movimientos aún en camino borraría
        // de la pantalla lo que todavía no ha llegado al servidor.
        if (pendientes.current === 0 && debeRecargar.current) {
          debeRecargar.current = false;
          await cargar(desdeRef.current);
        }
      });
  }, [authFetch, cargar]);

  /** La visita que se está arrastrando y de dónde salió. `null` = no se arrastra nada. */
  const [arrastrando, setArrastrando] = useState<{ id: string; staffId: string; dia: string } | null>(null);
  /** El hueco sobre el que está el puntero ahora mismo: es la raya que se ve. */
  const [hueco, setHueco] = useState<Hueco | null>(null);
  const marcar = useCallback((h: Hueco) => {
    setHueco((v) => (v && v.staffId === h.staffId && v.dia === h.dia && v.i === h.i ? v : h));
  }, []);
  const soltarEn = useCallback((h: Hueco) => {
    const a = arrastrando;
    setArrastrando(null);
    setHueco(null);
    if (!a || !d) return;
    const lista = d.columnas.find((c) => c.staffId === h.staffId)?.dias[h.dia]?.ordenes ?? [];
    const desdeI = lista.findIndex((o) => o.id === a.id);
    const misma = a.staffId === h.staffId && a.dia === h.dia;
    // El índice viene contado sobre la lista TAL CUAL se ve, con la tarjeta arrastrada
    // todavía dentro: para saber dónde cae hay que descontar el hueco que ella deja.
    const i = misma && desdeI >= 0 && h.i > desdeI ? h.i - 1 : h.i;
    if (misma && desdeI === i) return; // se soltó donde ya estaba
    const resto = lista.filter((o) => o.id !== a.id);
    const vecina: Vecina | undefined =
      resto.length === 0 ? undefined
        : i <= 0 ? { antesDe: resto[0].id }
          : { despuesDe: resto[Math.min(i, resto.length) - 1].id };
    mover(a.id, { staffId: h.staffId, dia: h.dia }, vecina);
  }, [arrastrando, d, mover]);

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
  const algunoAbierto = ordenados.some((c) => !plegados.includes(c.staffId));

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
          {/* Con 12 técnicos por delante, poder cerrarlos todos de una es la diferencia
              entre mirar una agenda y bajar por doce. */}
          {ordenados.length > 1 && (
            <button
              type="button"
              onClick={() => {
                const siguiente = algunoAbierto ? ordenados.map((c) => c.staffId) : [];
                setPlegados(siguiente);
                guardarPlegados(siguiente);
              }}
              className="tap inline-flex items-center gap-1 rounded-lg border border-border-default px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2"
            >
              <Icon name={algunoAbierto ? "chevron-up" : "chevron-down"} size={13} />
              {algunoAbierto ? "Contraer todo" : "Expandir todo"}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {enVuelo > 0 && <Icon name="loader" size={15} className="animate-spin text-text-tertiary" />}
          <button
            type="button"
            onClick={() => void cargar(desdeRef.current ?? fecha)}
            title="Volver a leer la agenda del servidor"
            aria-label="Actualizar la agenda"
            className="tap rounded-lg border border-border-default px-2 py-1.5 text-text-secondary hover:bg-surface-2"
          >
            <Icon name="refresh-cw" size={14} />
          </button>
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
        const pendientesTramo = enTramo(c);
        const conTrabajo = d.dias.filter((x) => (c.dias[x]?.ordenes.length ?? 0) > 0 || (c.dias[x]?.total ?? 0) > 0);
        // Plegado se queda a medias mientras se busca: si a este técnico le coincide
        // algo, se abre solo. Un resultado escondido detrás de una cabecera cerrada
        // se lee igual que no haber encontrado nada.
        const coincide = !!d.q && conTrabajo.some((x) => (c.dias[x]?.ordenes ?? []).some((t) => coincideTexto(t, d.q)));
        const plegado = plegados.includes(c.staffId) && !coincide;
        return (
          <div key={c.staffId} className="shrink-0 overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-sm">
            <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-surface-2 px-3 py-2">
              {/* La cabecera entera abre y cierra. Al arrastrar por encima de un técnico
                  plegado se abre sola: si no, soltarle trabajo exigiría abrirlo antes
                  y el arrastre ya estaría empezado. */}
              <button
                type="button"
                onClick={() => alternarPlegado(c.staffId)}
                onDragOver={() => { if (plegado) alternarPlegado(c.staffId); }}
                aria-expanded={!plegado}
                title={plegado ? "Ver su agenda" : "Plegar su agenda"}
                className="tap flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <Icon name={plegado ? "chevron-right" : "chevron-down"} size={15} className="shrink-0 text-text-tertiary" />
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                  <Icon name="hard-hat" size={14} />
                </span>
                <span className="min-w-0 truncate text-[13px] font-bold text-text-primary">{c.nombre}</span>
                <span className="shrink-0 text-[11.5px] text-text-secondary">
                  {pendientesTramo === 0 ? "sin visitas pendientes en el tramo" : `${pendientesTramo} ${pendientesTramo === 1 ? "visita pendiente" : "visitas pendientes"}`}
                </span>
              </button>
              {/* Lo que tiene MÁS ALLÁ del tramo. Sin decirlo, la fila de un técnico
                  con quince visitas en octubre se lee como una semana tranquila. */}
              {c.despues.cuantas > 0 && (
                <button
                  type="button"
                  onClick={() => c.despues.primera && setFecha(c.despues.primera)}
                  className="tap shrink-0 rounded-full border border-border-default bg-surface px-2 py-0.5 text-[11px] font-semibold text-text-secondary hover:bg-surface-2"
                  title={`Tiene ${c.despues.cuantas} más adelante. Ir a la primera.`}
                >
                  +{c.despues.cuantas} más adelante{c.despues.primera ? ` · ${diaCorto(c.despues.primera)}` : ""}
                </button>
              )}
            </div>

            {plegado ? null : conTrabajo.length === 0 ? (
              <div className="px-3 py-5 text-center text-[11.5px] text-text-tertiary">
                {filtrando ? "Ninguna de sus visitas coincide con el filtro" : "No tiene nada agendado en este tramo"}
              </div>
            ) : (
              <div className="divide-y divide-border-subtle">
                {conTrabajo.map((x) => {
                  const casilla = c.dias[x];
                  const ordenes = casilla?.ordenes ?? [];
                  const marcaEn = hueco && hueco.staffId === c.staffId && hueco.dia === x ? hueco.i : null;
                  return (
                    <div
                      key={x}
                      className="px-3 py-2"
                      // Soltar en el hueco de abajo (o en un día sin nada que se vea)
                      // deja la visita al final de esa jornada.
                      onDragOver={(e) => {
                        if (!arrastrando) return;
                        e.preventDefault();
                        if (e.target === e.currentTarget) marcar({ staffId: c.staffId, dia: x, i: ordenes.length });
                      }}
                      onDrop={(e) => {
                        if (!arrastrando) return;
                        e.preventDefault();
                        soltarEn(hueco ?? { staffId: c.staffId, dia: x, i: ordenes.length });
                      }}
                    >
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
                        <div
                          onDragOver={(e) => { if (arrastrando) { e.preventDefault(); marcar({ staffId: c.staffId, dia: x, i: 0 }); } }}
                          onDrop={(e) => { if (arrastrando) { e.preventDefault(); soltarEn({ staffId: c.staffId, dia: x, i: 0 }); } }}
                          className={`rounded-lg border border-dashed px-3 py-2 text-center text-[11px] ${
                            marcaEn != null ? "border-brand bg-brand/5 text-brand" : "border-border-subtle text-text-tertiary"
                          }`}
                        >
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
                              arrastrada={arrastrando?.id === t.id}
                              marcaArriba={marcaEn === i}
                              marcaAbajo={marcaEn === ordenes.length && i === ordenes.length - 1}
                              onEmpezarArrastre={() => setArrastrando({ id: t.id, staffId: c.staffId, dia: x })}
                              onTerminarArrastre={() => { setArrastrando(null); setHueco(null); }}
                              arrastrandoAlgo={!!arrastrando}
                              onSobre={(abajo) => marcar({ staffId: c.staffId, dia: x, i: i + (abajo ? 1 : 0) })}
                              onSoltar={(abajo) => soltarEn({ staffId: c.staffId, dia: x, i: i + (abajo ? 1 : 0) })}
                              onSubir={i > 0 ? () => mover(t.id, { staffId: c.staffId, dia: x }, { antesDe: ordenes[i - 1].id }) : undefined}
                              onBajar={i < ordenes.length - 1 ? () => mover(t.id, { staffId: c.staffId, dia: x }, { despuesDe: ordenes[i + 1].id }) : undefined}
                              onPasarA={(destino) => mover(t.id, { staffId: destino, dia: x })}
                              onCambiarDia={(nuevo) => mover(t.id, { staffId: c.staffId, dia: nuevo }, undefined, !d.dias.includes(nuevo))}
                              onQuitar={() => mover(t.id, null)}
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
 * de la lista, es el orden en que el técnico va a salir a hacerlas. Y es también por
 * donde se COGE la tarjeta para arrastrarla: el sitio que dice el puesto es el sitio
 * que lo cambia.
 *
 * Las flechas se quedan al lado a propósito, aunque se pueda arrastrar: el arrastre
 * del navegador no existe con el dedo, y esta pantalla se abre en la tableta de la
 * ventanilla. Los mandos van a la derecha y siempre visibles —nada de aparecer al
 * pasar el ratón—, por lo mismo.
 */
function RenglonVisita({
  t, dia, staffId, tecnicos, atenuada, arrastrada, arrastrandoAlgo, marcaArriba, marcaAbajo,
  onEmpezarArrastre, onTerminarArrastre, onSobre, onSoltar,
  onSubir, onBajar, onPasarA, onCambiarDia, onQuitar,
}: {
  t: Tarjeta; dia: string; staffId: string;
  tecnicos: { staffId: string; nombre: string }[];
  atenuada: boolean;
  /** Esta misma tarjeta es la que va en la mano. */
  arrastrada: boolean;
  /** Hay algo arrastrándose (de esta jornada o de otra): hay que aceptar el soltar. */
  arrastrandoAlgo: boolean;
  /** La raya de "aquí cae" va encima / debajo de este renglón. */
  marcaArriba: boolean; marcaAbajo: boolean;
  onEmpezarArrastre: () => void; onTerminarArrastre: () => void;
  /** `abajo` = el puntero va por la mitad de abajo del renglón, o sea detrás de él. */
  onSobre: (abajo: boolean) => void;
  onSoltar: (abajo: boolean) => void;
  onSubir?: () => void; onBajar?: () => void;
  onPasarA: (staffId: string) => void;
  onCambiarDia: (dia: string) => void;
  onQuitar: () => void;
}) {
  const tono = TICKET_PRIORITY_TONE[t.priority ?? ""] ?? "default";
  const enCurso = t.status === "REALIZANDO";
  const cerrada = t.status === "RESUELTO" || t.status === "ANULADA";
  /**
   * SE COGE EL RENGLÓN ENTERO, no un asa escondida (2026-09-04: «no veo el drag &
   * drop»). La primera versión sólo se dejaba arrastrar por el número —para no
   * pelearse con el enlace de dentro— y nadie lo encontró: un arrastre que hay que
   * adivinar es un arrastre que no existe. Ahora el renglón va `draggable` siempre,
   * lleva el asa dibujada (⠿) y la manita sale en toda la tarjeta.
   *
   * Lo de dentro se protege al empezar y no al marcar: si el gesto arranca sobre un
   * mando —el enlace #código, los desplegables, el calendario, los botones— se
   * cancela el arrastre y ese control hace lo suyo.
   */
  const mitadDeAbajo = (e: DragEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };
  return (
    <li
      draggable={!cerrada}
      onDragStart={(e) => {
        if ((e.target as HTMLElement).closest?.("a,button,select,input,label")) {
          e.preventDefault();
          return;
        }
        // Firefox no empieza el arrastre sin datos dentro.
        e.dataTransfer.setData("text/plain", t.id);
        e.dataTransfer.effectAllowed = "move";
        onEmpezarArrastre();
      }}
      onDragEnd={() => onTerminarArrastre()}
      onDragOver={(e) => { if (arrastrandoAlgo) { e.preventDefault(); onSobre(mitadDeAbajo(e)); } }}
      onDrop={(e) => { if (arrastrandoAlgo) { e.preventDefault(); e.stopPropagation(); onSoltar(mitadDeAbajo(e)); } }}
      title={cerrada ? undefined : "Arrastra la visita para cambiarla de orden, de día o de técnico"}
      className={`relative flex flex-col gap-1.5 rounded-lg border px-2 py-1.5 sm:flex-row sm:items-center sm:gap-2 ${
        cerrada ? "" : "cursor-grab active:cursor-grabbing"
      } ${
        enCurso ? "border-warning-border bg-warning-soft/20" : "border-border-subtle bg-surface"
      } ${cerrada ? "opacity-60" : ""} ${atenuada ? "opacity-40" : ""} ${arrastrada ? "opacity-30" : ""} ${
        marcaArriba ? "before:absolute before:-top-[3px] before:left-0 before:right-0 before:h-[2px] before:rounded-full before:bg-brand before:content-['']" : ""
      } ${marcaAbajo ? "after:absolute after:-bottom-[3px] after:left-0 after:right-0 after:h-[2px] after:rounded-full after:bg-brand after:content-['']" : ""}`}
    >
      {/* El asa DIBUJADA. No hace falta para arrastrar —vale el renglón entero— pero
          es lo que dice que se puede: sin ella el arrastre había que adivinarlo.
          Una visita cerrada no se mueve —el trabajo está hecho— y no la lleva. */}
      {/* En móvil no se pinta: ahí el renglón se apila y el asa se llevaría una línea
          entera para un gesto que con el dedo no existe (ahí se reordena con ↑↓). */}
      <span className={`hidden shrink-0 sm:inline-flex ${cerrada ? "invisible" : "text-text-tertiary"}`} aria-hidden="true">
        <Icon name="grip-vertical" size={14} />
      </span>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-on-brand">
        {t.puesto ?? t.seq ?? "—"}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <Link href={`/soporte/${t.id}`} draggable={false} className="font-mono text-[11px] font-semibold text-text-secondary hover:text-brand hover:underline">
            #{t.code ?? "—"}
          </Link>
          <span className="min-w-0 truncate text-[12.5px] font-semibold text-text-primary" title={t.type}>{t.type}</span>
          <ChipServicio servicio={t.servicio} />
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${TONO_BADGE[tono]}`}>{t.priority ?? "—"}</span>
          {t.atrasada && <EtiquetaAtrasada desde={t.agendadaPara} />}
          {enCurso && <span className="rounded bg-warning-soft px-1 py-0.5 text-[9px] font-bold uppercase text-warning-text">En curso</span>}
          {t.status === "RESUELTO" && <span className="rounded bg-success-soft px-1 py-0.5 text-[9px] font-bold uppercase text-success-text">Resuelta</span>}
          {t.status === "ANULADA" && <span className="rounded bg-surface-2 px-1 py-0.5 text-[9px] font-bold uppercase text-text-tertiary">Anulada</span>}
          {/* Va en la primera línea, junto al tipo de orden: es lo que hay que saber
              ANTES de mandar al técnico, no un detalle que se lee al final. */}
          <AvisoEquipo equipo={t.equipo} />
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
          <button type="button" onClick={onSubir} disabled={!onSubir} title="Subir en la jornada" aria-label={`Subir la orden ${t.code ?? ""}`}
            className="tap rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary disabled:opacity-30">
            <Icon name="chevron-up" size={14} />
          </button>
          <button type="button" onClick={onBajar} disabled={!onBajar} title="Bajar en la jornada" aria-label={`Bajar la orden ${t.code ?? ""}`}
            className="tap rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary disabled:opacity-30">
            <Icon name="chevron-down" size={14} />
          </button>
          <Select
            value=""
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
            onChange={(e) => e.target.value && e.target.value !== dia && onCambiarDia(e.target.value)}
            aria-label={`Cambiar el día de la orden ${t.code ?? ""}`}
            className="order-last h-7 w-full shrink-0 rounded-lg border border-border-default bg-surface px-1.5 text-[11px] font-semibold text-text-secondary sm:order-none sm:w-auto"
          />
          <button type="button" onClick={onQuitar} title="Quitar de la agenda (vuelve a sin repartir)" aria-label={`Quitar de la agenda la orden ${t.code ?? ""}`}
            className="tap rounded p-1 text-text-tertiary hover:bg-error-soft hover:text-error-text disabled:opacity-30">
            <Icon name="x" size={14} />
          </button>
        </span>
      )}
    </li>
  );
}

/**
 * El mismo movimiento que hace el servidor, hecho aquí para pintarlo ya.
 *
 * Es lo que quita la espera: la visita cambia de sitio en el acto y la petición viaja
 * detrás. No es una copia del servidor —allí se renumera la columna entera dentro de
 * una transacción—, es lo que se puede saber con lo que hay en pantalla:
 *
 *  · Las CUENTAS del día (total, pendientes, arrastradas) se corrigen a mano en las
 *    dos casillas, la de origen y la de destino: no se pueden recalcular desde la
 *    lista porque con un filtro puesto la lista no las trae todas.
 *  · El PUESTO se reescribe 1..N sólo cuando en pantalla está la jornada completa.
 *    Con un filtro puesto se reparten los números que ya había entre las que se ven
 *    (1, 4, 7 siguen siendo 1, 4, 7 en el nuevo orden): el número real lo decide el
 *    servidor contando también las que el filtro escondió, y llega en la siguiente
 *    lectura.
 *  · La etiqueta de ARRASTRADA se cae, igual que allí: en cuanto una persona la
 *    mueve hay una decisión nueva detrás y deja de ser un arrastre del cron.
 */
function moverEnMemoria(d: Semana, ticketId: string, destino: Destino | null, vecina?: Vecina): Semana {
  let visita: Tarjeta | null = null;
  let origen: Destino | null = null;
  for (const c of d.columnas) {
    for (const [dia, casilla] of Object.entries(c.dias)) {
      const encontrada = casilla.ordenes.find((o) => o.id === ticketId);
      if (encontrada) { visita = encontrada; origen = { staffId: c.staffId, dia }; }
    }
  }
  if (!visita || !origen) return d;
  const salidaOrigen = origen;
  const movida: Tarjeta = destino
    ? {
      ...visita,
      staffId: destino.staffId,
      tecnico: d.columnas.find((c) => c.staffId === destino.staffId)?.nombre ?? visita.tecnico,
      agendadaPara: destino.dia,
      atrasada: false,
    }
    : visita;
  const eraAtrasada = visita.atrasada;

  const columnas = d.columnas.map((c) => {
    if (c.staffId !== salidaOrigen.staffId && c.staffId !== destino?.staffId) return c;
    const dias = { ...c.dias };
    if (c.staffId === salidaOrigen.staffId && dias[salidaOrigen.dia]) {
      const casilla = dias[salidaOrigen.dia];
      dias[salidaOrigen.dia] = renumerada({
        ...casilla,
        ordenes: casilla.ordenes.filter((o) => o.id !== ticketId),
        total: Math.max(0, casilla.total - 1),
        pendientes: Math.max(0, casilla.pendientes - 1),
        atrasadas: Math.max(0, casilla.atrasadas - (eraAtrasada ? 1 : 0)),
      });
    }
    if (destino && c.staffId === destino.staffId) {
      // Ojo al orden: si origen y destino son la misma casilla, esto lee la de arriba
      // (ya sin la visita y con las cuentas bajadas) y las vuelve a subir. Neto: cero.
      const casilla = dias[destino.dia] ?? { ordenes: [], total: 0, pendientes: 0, atrasadas: 0 };
      const resto = casilla.ordenes.filter((o) => o.id !== ticketId);
      const i = puestoDeVecina(resto, vecina);
      dias[destino.dia] = renumerada({
        ...casilla,
        ordenes: [...resto.slice(0, i), movida, ...resto.slice(i)],
        total: casilla.total + 1,
        pendientes: casilla.pendientes + 1,
      });
    }
    return { ...c, dias };
  });

  return {
    ...d,
    columnas,
    // Quitarla de la agenda la devuelve a la bandeja de "sin día", que aquí sólo se
    // ve como cifra al pie.
    sinAgendarTotal: destino ? d.sinAgendarTotal : d.sinAgendarTotal + 1,
    sinAgendarSinFiltro: destino || d.sinAgendarSinFiltro == null ? d.sinAgendarSinFiltro : d.sinAgendarSinFiltro + 1,
  };
}

/** En qué hueco de la lista cae, según la tarjeta vecina. Sin vecina, al final. */
function puestoDeVecina(lista: Tarjeta[], vecina?: Vecina): number {
  if (vecina?.antesDe) {
    const i = lista.findIndex((o) => o.id === vecina.antesDe);
    if (i >= 0) return i;
  }
  if (vecina?.despuesDe) {
    const i = lista.findIndex((o) => o.id === vecina.despuesDe);
    if (i >= 0) return i + 1;
  }
  return lista.length;
}

/** Los números de la jornada, en el orden nuevo. Ver la nota de `moverEnMemoria`. */
function renumerada(casilla: Casilla): Casilla {
  const completa = casilla.ordenes.length >= casilla.total;
  if (completa) {
    return { ...casilla, ordenes: casilla.ordenes.map((o, i) => ({ ...o, puesto: i + 1, seq: i + 1 })) };
  }
  const numeros = casilla.ordenes.map((o) => o.puesto).filter((n): n is number => n != null).sort((a, b) => a - b);
  return { ...casilla, ordenes: casilla.ordenes.map((o, i) => ({ ...o, puesto: numeros[i] ?? null })) };
}
