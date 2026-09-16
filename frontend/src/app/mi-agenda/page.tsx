"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";
import { VisitaAgendada, visitaLista, type MiAgenda } from "@/components/soporte/VisitaAgendada";
import { VisitaDeHoy } from "@/components/soporte/VisitaDeHoy";
import { LoQueViene } from "@/components/soporte/LoQueViene";
import { Segmented } from "@/components/ui/Segmented";
import { Button } from "@/components/ui/Button";
import { EventoModal } from "@/components/agenda/EventoModal";
import { esTecnico } from "@/lib/support";
import { can, PERM, type AuthUser } from "@/lib/auth";
import { MiCalendario, type VisitaCalendario } from "@/components/soporte/MiCalendario";
import { MiniCalendario } from "@/components/agenda/MiniCalendario";
import {
  diaISO, inicioDeDia, nombreDeMes, rejillaDeMes, semanaDe, sumarDias, sumarMeses, type Evento,
} from "@/components/agenda/calendario";

type Vista = "dia" | "semana" | "mes";

/** «Hoy» y no «Día»: la primera es la jornada de trabajo, no una casilla del calendario. */
const VISTAS: { value: Vista; label: string }[] = [
  { value: "dia", label: "Hoy" },
  { value: "semana", label: "Semana" },
  { value: "mes", label: "Mes" },
];

/**
 * Con qué vista abre la pantalla, y por qué se RECUERDA la última.
 *
 * Abre en el MES (2026-09-10, a pedido del usuario): entrar y ver el mes es lo que
 * hacía falta, porque la vista de «Hoy» es igual que la de siempre y el calendario
 * quedaba escondido detrás de un botón que nadie tenía por qué pulsar.
 *
 * Pero el técnico no entra aquí a mirar el mes: entra a trabajar, y su pantalla es
 * «Hoy». Por eso la elección se guarda: al que pulse «Hoy» le abrirá en «Hoy» a
 * partir de entonces, sin tener que volver a elegir cada mañana. Un solo toque
 * decide, y decide para siempre — que es lo contrario de imponerle una vista a cada
 * uno de los dos.
 *
 * Va con el id del usuario en la llave, como los filtros (`useFiltrosUrl`): en un
 * teléfono compartido en la sede, lo que eligió uno no le abre la pantalla al otro.
 */
const VISTA_POR_DEFECTO: Vista = "mes";

/**
 * Quién puede AGENDARSE cosas aquí.
 *
 * Las tareas de la agenda son `CalendarEvent`, las mismas de `/agenda`, y su API
 * (`/omni/events`) es de contabilidad, administración y caja. Enseñar el botón a
 * quien la API va a rechazar es peor que no enseñarlo: el fallo aparece con el
 * formulario ya lleno.
 */
const puedeAgendar = (u: Pick<AuthUser, "permissions"> | null | undefined) =>
  can(u, [PERM.AREA_CONTABILIDAD, PERM.AREA_ADMINISTRACION, PERM.AREA_CAJA]);
const LLAVE_VISTA = (uid: string) => `mi-agenda:vista:${uid}`;
const esVista = (v: string | null): v is Vista => v === "dia" || v === "semana" || v === "mes";

const diaLargo = (ymd: string) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long" });

/**
 * Mi agenda: UNA visita, la que toca ahora.
 *
 * Historia corta de esta pantalla, porque explica lo que hay:
 *
 *  · Hasta el 2026-08-04 listaba el día numerado y el número era una sugerencia.
 *  · Del 04 al 28 de agosto fue "turno obligatorio": una sola visita, y el backend le
 *    negaba abrir cualquier otra.
 *  · Del 28 de agosto al 2026-09-02 volvió a verlo todo de una vez.
 *  · Desde el 2026-09-02, a pedido del usuario, **vuelve el turno**: ve una visita y
 *    hasta que no la cierra no aparece la siguiente.
 *  · Desde el 2026-09-10 el turno es FIJO para el técnico (ya no depende del
 *    interruptor general) y se le quitó el "No se pudo atender": la visita que no se
 *    puede hacer la reprograma quien agenda, no él. Ver `VisitaDeHoy`.
 *  · Ese mismo día, después de mirar el legacy, **el candado se redujo al del legacy**
 *    (`Tickets.php` → `update_status`): lo único que el backend bloquea es EMPEZAR una
 *    segunda orden teniendo una empezada. Ver, documentar y cerrar no se bloquean.
 *
 * **Esta pantalla sigue enseñando UNA visita**, y ya no porque la API rechace las
 * demás sino porque es el orden que puso quien agenda y el técnico lo sigue («no
 * podrán saltarse órdenes», 2026-09-10). Es la única discrepancia deliberada entre
 * pantalla y API, y va en el sentido seguro: la pantalla pide menos de lo que la API
 * permite. Al revés —ofrecer una visita que la API rechaza— es el fallo que esta
 * regla lleva evitando desde agosto.
 *
 * **Excepción nominal (2026-09-02):** el técnico con `Staff.agendaLibre` —hoy sólo
 * Oscar Rodríguez— ve su jornada completa; la manda el backend en `turnoLibre`.
 *
 * Enseñar las seis visitas invita a discutir el orden en vez de seguirlo. Lo que sí se
 * dice es cuántas lleva y cuántas le faltan, que es lo que necesita para organizarse.
 *
 * Las que ya cerró NO desaparecen: se recogen abajo, plegadas. Ver las tres hechas es
 * lo que le dice por dónde va, y esconderlas haría que un día completo se viera igual
 * que un día en blanco.
 *
 * Cuál es la orden que tiene EMPEZADA lo dice el backend en `enCurso` — esta pantalla
 * no lo recalcula, por lo mismo de siempre: dos cuentas de la misma regla acaban
 * discrepando.
 *
 * ── EL CALENDARIO (2026-09-10, a pedido del usuario) ─────────────────────────
 * A la pantalla de UN día se le añadieron dos vistas más, **Semana** y **Mes**, que
 * son la misma rejilla de `/agenda` pintando las visitas del técnico. No sustituyen a
 * nada: «Hoy» sigue siendo la vista de trabajo —con su turno, su tarjeta grande y su
 * candado— y las otras dos son de CONSULTA, para la pregunta que hasta ahora había
 * que hacer por teléfono: cómo viene la semana. De cualquier casilla se entra al día
 * (la vista «Hoy» de ESE día), y de cualquier visita, a su orden.
 *
 * Mirar otro día no relaja el candado: vive en el backend y sigue mirando la orden
 * que el técnico tenga empezada, se esté viendo el día que se esté viendo.
 */
export default function MiAgendaPage() {
  const { loading: authLoading, authFetch, user } = useAuth();
  const [d, setD] = useState<MiAgenda | null>(null);
  const [err, setErr] = useState(false);
  const [verHechas, setVerHechas] = useState(false);

  const [vistaElegida, setVista] = useState<Vista>(VISTA_POR_DEFECTO);
  /** El día que se está mirando. Manda en las tres vistas: es el ancla. */
  const [ancla, setAncla] = useState<Date>(() => inicioDeDia(new Date()));
  /** El mes del mini-calendario, que puede ojearse sin mover el día elegido. */
  const [mesDelMini, setMesDelMini] = useState<Date>(() => new Date());
  const [visitas, setVisitas] = useState<VisitaCalendario[]>([]);
  const [cargandoCal, setCargandoCal] = useState(false);

  // La vista guardada se lee DESPUÉS de montar y no en el `useState`: leer
  // `localStorage` durante el render le da al servidor y al navegador dos HTML
  // distintos, y React tira el árbol entero al hidratar.
  const uid = user?.id ?? null;
  /** Hasta que no se sabe qué vista tenía elegida, no se pide nada al servidor. */
  const [vistaResuelta, setVistaResuelta] = useState(false);
  useEffect(() => {
    if (authLoading) return;
    try {
      const guardada = uid ? window.localStorage.getItem(LLAVE_VISTA(uid)) : null;
      if (esVista(guardada)) setVista(guardada);
    } catch { /* modo privado: se queda con la de por defecto */ }
    setVistaResuelta(true);
  }, [authLoading, uid]);

  const elegirVista = (v: Vista) => {
    setVista(v);
    if (!uid) return;
    try { window.localStorage.setItem(LLAVE_VISTA(uid), v); } catch { /* modo privado */ }
  };

  /*
    EL TÉCNICO DE CAMPO SE QUEDA CON SU PANTALLA DE SIEMPRE (2026-09-10, a pedido del
    usuario). Nada de vistas ni de calendario: entra, ve la visita que le toca y la
    trabaja. La rejilla resolvía una pregunta de oficina —cómo viene la semana— que él
    no se hace estando en la calle, y cada control de más en esta pantalla es uno que
    se puede pulsar sin querer con el teléfono en una mano y la escalera en la otra.

    Se decide con el MISMO predicado que el resto del sistema (`esTecnico`), no con una
    lista de roles aparte: técnico puro, sin área de mando por encima.
  */
  const tecnico = esTecnico(user);
  const vista: Vista = tecnico ? "dia" : vistaElegida;
  const agendable = !tecnico && puedeAgendar(user);

  const hoyISO = diaISO(new Date());
  const fecha = diaISO(ancla);
  const esHoy = fecha === hoyISO;

  const cargar = useCallback(async () => {
    setErr(false);
    try {
      // El día viaja en la query: el backend ya sabía servir cualquier día (`fecha`),
      // sólo que esta pantalla nunca se lo pedía.
      const r = await authFetch(`/support/mi-agenda${esHoy ? "" : `?fecha=${fecha}`}`);
      if (!r.ok) throw new Error(String(r.status));
      setD((await r.json()) as MiAgenda);
    } catch {
      setErr(true);
    }
  }, [authFetch, esHoy, fecha]);

  useEffect(() => {
    if (!authLoading) void cargar();
  }, [authLoading, cargar]);

  /** Los días que pinta la rejilla: seis semanas (mes) o siete días (semana). */
  const dias = useMemo(() => (vista === "mes" ? rejillaDeMes(ancla) : semanaDe(ancla)), [vista, ancla]);

  // Las visitas del tramo visible. Se piden por la ventana que se está pintando, así
  // que cambiar de semana pide una vez y moverse dentro de ella no pide nada.
  const desde = vista === "dia" || !vistaResuelta ? null : diaISO(dias[0]);
  const hasta = vista === "dia" || !vistaResuelta ? null : diaISO(dias[dias.length - 1]);
  useEffect(() => {
    if (authLoading || !desde || !hasta) return;
    let vivo = true;
    setCargandoCal(true);
    void authFetch(`/support/mi-agenda/calendario?desde=${desde}&hasta=${hasta}`)
      .then((r) => (r.ok ? r.json() : { visitas: [] }))
      .then((j) => { if (vivo) setVisitas(j?.visitas ?? []); })
      .catch(() => { if (vivo) setVisitas([]); })
      .finally(() => { if (vivo) setCargandoCal(false); });
    return () => { vivo = false; };
  }, [authLoading, authFetch, desde, hasta]);

  /*
    LAS TAREAS QUE UNO SE PONE (2026-09-10, a pedido del usuario).

    Son `CalendarEvent` —lo mismo que gestiona `/agenda`— y no un tipo nuevo: la
    empresa ya tiene UNA agenda, y una tarea puesta aquí tiene que poder consultarse
    allá y al revés. Se piden las MÍAS (`assignedBy` = mi nombre, que es lo que el
    backend escribe al crearlas) y no todas: en la ventana de un mes hay miles del
    legacy, y esta pantalla es "mi agenda".

    Al técnico no se le piden: su API de eventos es de otras áreas y su pantalla no
    tiene dónde pintarlas.
  */
  const [tareas, setTareas] = useState<Evento[]>([]);
  const [recargaTareas, setRecargaTareas] = useState(0);
  const [modalAbierto, setModalAbierto] = useState(false);
  const [enEdicion, setEnEdicion] = useState<Evento | null>(null);

  useEffect(() => {
    if (authLoading || !agendable || !desde || !hasta || !user?.name) return;
    let vivo = true;
    const qs = new URLSearchParams({ from: desde, to: hasta, assignedBy: user.name });
    void authFetch(`/omni/events/calendar?${qs}`)
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((j) => { if (vivo) setTareas(j?.items ?? []); })
      .catch(() => { if (vivo) setTareas([]); });
    return () => { vivo = false; };
  }, [authLoading, authFetch, agendable, desde, hasta, user?.name, recargaTareas]);

  const abrirTarea = (e: Evento | null, dia?: Date) => {
    setEnEdicion(e);
    setFechaSugerida(dia ?? (e ? null : new Date(ancla.getFullYear(), ancla.getMonth(), ancla.getDate(), 9, 0)));
    setModalAbierto(true);
  };
  const [fechaSugerida, setFechaSugerida] = useState<Date | null>(null);

  /** Puntos del mini-calendario: le basta con saber qué días traen algo. */
  const puntos: Evento[] = useMemo(
    () => [...tareas, ...visitas.filter((v) => v.dia).map((v) => ({
      id: v.id, orderNo: v.code, title: v.type, description: null, color: null,
      start: `${v.dia}T00:00:00`, end: `${v.dia}T23:59:59`, allDay: true,
      priority: v.priority, assignedBy: null,
    }))],
    [visitas, tareas],
  );

  const irA = (dia: Date) => {
    setAncla(inicioDeDia(dia));
    setMesDelMini(new Date(dia.getFullYear(), dia.getMonth(), 1));
  };
  const verDia = (dia: Date) => { irA(dia); elegirVista("dia"); };
  const paso = (signo: 1 | -1) => {
    const siguiente = vista === "mes" ? sumarMeses(ancla, signo) : sumarDias(ancla, signo * (vista === "semana" ? 7 : 1));
    irA(siguiente);
  };

  const { turno, siguientes, hechas, restantes } = useMemo(() => {
    const o = d?.ordenes ?? [];
    const pendientes = o.filter((v) => !visitaLista(v));
    // Exento del turno (`turnoLibre`): la primera sigue arriba como tarjeta grande
    // —es lo que necesita para arrancar— y detrás van TODAS las demás, abribles. Para
    // el resto del equipo `siguientes` va vacío y la pantalla es la de siempre.
    const libre = d?.turnoLibre === true;
    return {
      // La que manda el backend. El respaldo a la primera pendiente es para el caso en
      // que no venga ninguna en turno: ahí el backend tampoco bloquea nada, así que
      // pantalla y API siguen diciendo lo mismo.
      // La que manda el backend. Desde el 2026-09-09 el candado mira TODAS sus órdenes
      // abiertas y no sólo las del día, así que la que lo ancla puede no estar en esta
      // lista (una sin agendar, o la de mañana): en ese caso aquí no se destaca
      // ninguna y arriba sale el aviso con el enlace a ella. El respaldo a la primera
      // pendiente es sólo para cuando no hay nada que lo bloquee — ahí el backend
      // tampoco bloquea, así que pantalla y API siguen diciendo lo mismo.
      turno: libre
        ? pendientes[0] ?? null
        : d?.enCurso
          ? pendientes.find((v) => v.id === d.enCurso!.id) ?? null
          : pendientes.find((v) => v.id === d?.enTurno) ?? (d?.enTurno ? null : pendientes[0] ?? null),
      siguientes: libre ? pendientes.slice(1) : [],
      hechas: o.filter(visitaLista),
      restantes: pendientes.length,
    };
  }, [d]);

  if (authLoading || (!d && !err)) return <PageSkeleton />;
  if (err && !d)
    return (
      <div className="p-6">
        <LoadError message="No se pudo cargar tu agenda." onRetry={() => void cargar()} />
      </div>
    );
  if (!d) return <PageSkeleton />;

  const total = d.ordenes.length;

  return (
    <div className="flex flex-col gap-3">
      {/* El día de hoy manda, pero desde aquí se llega a lo de ayer: «lo que hice
          hace tres días, con sus fotos» era una pregunta sin pantalla y acababa en
          la lista general, ordenada por fecha de creación. Ver `historial/page.tsx`. */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHeading
          icon="calendar-clock"
          title={vista === "dia" ? (esHoy ? "Mi trabajo de hoy" : "Mi trabajo de ese día") : "Mi agenda"}
          subtitle={
            vista === "dia"
              ? diaLargo(d.fecha).replace(/^./, (c) => c.toUpperCase())
              : "Lo que tienes puesto, día por día"
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          {!tecnico && (
            <Segmented value={vista} onChange={elegirVista} options={VISTAS} ariaLabel="Vista de mi agenda" />
          )}
          {agendable && (
            <Button size="sm" onClick={() => abrirTarea(null)}>
              <Icon name="plus" size={14} /> Nueva tarea
            </Button>
          )}
          <Link
            href="/mi-agenda/historial"
            className="tap inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-2"
          >
            <Icon name="history" size={14} /> Lo que ya hice
          </Link>
        </div>
      </div>

      {/* Mover el periodo. Sólo en las vistas de rejilla: en «Hoy» el día lo cambia el
          calendario, y un par de flechas sueltas ahí invitarían a pasear por los días
          en vez de trabajar el que toca. */}
      {vista !== "dia" && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => irA(new Date())}
            // Se llama igual que la pestaña «Hoy» y no hacen lo mismo: ésta trae la
            // rejilla al día de hoy, aquélla cambia de vista. Quien navega a oído
            // tenía dos botones «Hoy» seguidos sin forma de distinguirlos.
            aria-label="Traer el calendario a hoy"
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
          <h2 className="truncate text-[15px] font-bold capitalize text-text-primary">
            {vista === "mes"
              ? nombreDeMes(ancla)
              : `${dias[0].toLocaleDateString("es-CO", { day: "numeric", month: "short" })} – ${dias[6].toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric" })}`}
          </h2>
          {cargandoCal && <Icon name="loader" size={14} className="animate-spin text-text-tertiary" />}
        </div>
      )}

      {/* Cuando se está mirando un día que no es hoy, la pantalla tiene que DECIRLO:
          es la misma tarjeta grande de siempre y sin esto se trabaja el día
          equivocado. */}
      {vista === "dia" && !esHoy && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand/40 bg-brand-soft/30 px-3.5 py-2.5">
          <p className="text-[12.5px] text-text-secondary">
            Estás viendo el <b className="text-text-primary">{diaLargo(fecha)}</b>, no el día de hoy.
          </p>
          <button
            type="button"
            onClick={() => irA(new Date())}
            className="foco tap rounded-lg bg-brand px-3 text-[12px] font-semibold text-on-brand hover:opacity-90"
          >
            Volver a hoy
          </button>
        </div>
      )}

      {vista === "dia" ? (
       <>
      {/* La orden que tiene EMPEZADA, cuando NO es de este día: una que dejó a medias
          ayer, o una sin agendar. Sin este cartel la pantalla enseñaría la jornada sin
          poder empezar nada y el bloqueo se descubriría chocando con él. Ver
          `support/turno.ts`. */}
      {d.enCurso && !d.ordenes.some((o) => o.id === d.enCurso!.id) && (
        <div className="flex flex-col gap-2 rounded-xl border border-brand/40 bg-brand-soft/30 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2">
            <Icon name="info" size={16} className="mt-0.5 shrink-0 text-brand" />
            <p className="text-[12.5px] text-text-secondary">
              Tienes una orden empezada que no es de hoy:{" "}
              <b className="text-text-primary">
                {d.enCurso.code ? `#${d.enCurso.code} · ` : ""}
                {d.enCurso.type}
              </b>
              {d.enCurso.cliente ? ` · ${d.enCurso.cliente}` : ""}. Ciérrala y podrás empezar
              las de hoy.
            </p>
          </div>
          <Link
            href={`/soporte/${d.enCurso.id}`}
            className="tap inline-flex min-h-[36px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 text-[12px] font-semibold text-on-brand transition-opacity hover:opacity-90"
          >
            <Icon name="arrow-right" size={14} /> Ver la orden abierta
          </Link>
        </div>
      )}

      {/* Sin ficha de empleado no hay forma de saber qué visitas son suyas. Se dice
          qué pasa y a quién pedírselo, en vez de una pantalla vacía que parece un día
          libre. Mismo criterio que el panel de rendimiento. */}
      {!d.resolved ? (
        <div className="rounded-xl border border-warning-border bg-warning-soft p-4">
          <div className="flex items-start gap-2.5">
            <Icon name="alert-triangle" size={18} className="mt-0.5 shrink-0 text-warning-text" />
            <div className="text-[13px] text-text-primary">
              <div className="font-bold">Tu usuario no está ligado a una ficha de empleado</div>
              <p className="mt-1 text-text-secondary">
                Por eso no podemos saber qué visitas son tuyas. Pídele a administración que revise
                que tu correo sea el mismo en <span className="font-semibold">Empleados</span>.
              </p>
            </div>
          </div>
        </div>
      ) : total > 0 ? (
        <>
          {/* Cuántas lleva y cuántas le faltan. Con una sola tarjeta delante, esto es
              lo que distingue "vas por la 2 de 6" de "esto es todo lo que hay". */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-subtle bg-surface px-3.5 py-2.5">
            <p className="text-[13px] text-text-secondary">
              <b className="text-text-primary">
                {restantes} {restantes === 1 ? "visita" : "visitas"} por hacer
              </b>
              {hechas.length > 0 ? ` · ${hechas.length} ${hechas.length === 1 ? "hecha" : "hechas"}` : ""} de {total}
            </p>
            <p className="text-[11.5px] text-text-tertiary">
              {d.turnoLibre
                ? "Este es el orden que puso la persona de caja; puedes abrir la que necesites."
                : "En el orden que puso la persona de caja."}
            </p>
          </div>

          {turno ? (
            <>
              <VisitaDeHoy
                o={turno}
                posicion={turno.puesto ?? hechas.length + 1}
                total={total}
                libre={d.turnoLibre === true}
              />
              {restantes > 1 && !d.turnoLibre && (
                <p className="text-center text-[12px] text-text-tertiary">
                  Cuando cierres esta te aparece la siguiente. Te quedan {restantes} de {total}.
                </p>
              )}
              {/* Sólo para el técnico exento del turno: el resto de su jornada, entera
                  y abrible. Va DEBAJO de la tarjeta grande y no en su lugar para que
                  siga viéndose por dónde empezar. */}
              {siguientes.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-[12px] font-semibold text-text-secondary">
                    Las demás de tu día ({siguientes.length})
                  </p>
                  {siguientes.map((o) => (
                    <VisitaAgendada key={o.id} o={o} />
                  ))}
                </div>
              )}
            </>
          ) : d.enCurso ? (
            // No es que haya terminado: su día está esperando a que cierre la orden
            // que dejó empezada y que no es de hoy. El qué y el enlace ya están en el
            // cartel de arriba; aquí sólo se dice por qué la lista está quieta —y NO
            // se le felicita por un día que no ha hecho.
            <div className="rounded-xl border border-border-subtle bg-surface p-6 text-center">
              <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-text-tertiary">
                <Icon name="lock" size={20} />
              </span>
              <h2 className="text-[14px] font-bold text-text-primary">Primero cierra la orden que tienes empezada</h2>
              <p className="mx-auto mt-1 max-w-md text-[12.5px] text-text-secondary">
                Tus {total} de hoy siguen ahí. En cuanto la cierres podrás empezar la primera.
              </p>
            </div>
          ) : (
            // Terminó el día. Es la única pantalla del sistema que da una
            // felicitación, y se la ha ganado: cerró todo lo que le pusieron.
            <div className="rounded-xl border border-success-border bg-success-soft p-6 text-center">
              <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-surface text-success-text">
                <Icon name="check" size={22} />
              </span>
              <h2 className="text-[15px] font-bold text-text-primary">Terminaste tus visitas de hoy</h2>
              <p className="mx-auto mt-1 max-w-md text-[12.5px] text-text-secondary">
                Cerraste las {total} que tenías agendadas. Si aparece algo nuevo, lo verás aquí.
              </p>
            </div>
          )}

          {hechas.length > 0 && (
            <div className="rounded-xl border border-border-subtle bg-surface">
              <button
                type="button"
                onClick={() => setVerHechas((v) => !v)}
                className="tap flex w-full items-center justify-between gap-2 px-3.5 py-3 text-left"
              >
                <span className="flex items-center gap-2 text-[13px] font-semibold text-text-secondary">
                  <Icon name="check" size={15} className="text-success-text" />
                  Ya hechas ({hechas.length})
                </span>
                <Icon name={verHechas ? "chevron-up" : "chevron-down"} size={16} className="text-text-tertiary" />
              </button>
              {verHechas && (
                <div className="flex flex-col gap-2 border-t border-border-subtle p-3">
                  {hechas.map((o) => (
                    <VisitaAgendada key={o.id} o={o} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="rounded-xl border border-border-subtle bg-surface p-6 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-text-tertiary">
            <Icon name="calendar-clock" size={20} />
          </span>
          <h2 className="text-[14px] font-bold text-text-primary">No tienes visitas agendadas para hoy</h2>
          <p className="mx-auto mt-1 max-w-md text-[12.5px] text-text-secondary">
            Quien reparte el día es la persona de caja. Si crees que es un error, háblale antes de
            salir.
          </p>
          <Link
            href="/soporte"
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3.5 py-2 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-2"
          >
            <Icon name="clipboard-check" size={14} /> Ver mis órdenes
          </Link>
        </div>
      )}

      {/* Lo que le viene, en solo lectura y plegado (2026-08-26). Es un resumen para
          que pueda organizarse —llevar material, saber que mañana le toca al otro lado
          del pueblo—; lo de hoy ya lo tiene entero arriba. */}
      <LoQueViene cuantas={d.proximas} />
       </>
      ) : (
        <div className="flex gap-4">
          {/* El riel se esconde por debajo de `lg`: en el móvil del técnico —que es
              donde se usa esta pantalla— la rejilla necesita el ancho entero. */}
          <aside className="hidden w-[212px] shrink-0 flex-col gap-3 lg:flex">
            <MiniCalendario
              mes={mesDelMini}
              seleccionado={ancla}
              eventos={puntos}
              onMes={setMesDelMini}
              onDia={irA}
            />
            <div className="flex flex-col gap-1.5 rounded-xl border border-border-subtle bg-surface p-2.5 text-[11.5px] text-text-secondary">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Cómo se lee</p>
              <span className="flex items-center gap-1.5"><i className="h-[7px] w-[7px] rounded-full bg-brand" /> Por hacer</span>
              <span className="flex items-center gap-1.5"><i className="h-[7px] w-[7px] rounded-full bg-warning" /> En curso</span>
              <span className="flex items-center gap-1.5"><i className="h-[7px] w-[7px] rounded-full bg-success" /> Cerrada</span>
              <span className="flex items-center gap-1.5"><Icon name="history" size={11} className="text-warning-text" /> Viene atrasada</span>
              <span className="mt-1 text-text-tertiary">El número es el puesto que le puso caja dentro del día.</span>
              {agendable && (
                <span className="mt-1 border-t border-border-subtle pt-1.5 text-text-tertiary">
                  Tus tareas van arriba de cada día, con su hora y el color que les pongas.
                </span>
              )}
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <MiCalendario
              dias={dias}
              mes={ancla}
              visitas={visitas}
              tareas={tareas}
              hoyISO={hoyISO}
              onVerDia={verDia}
              onAbrirTarea={agendable ? (t) => abrirTarea(t) : undefined}
              onNuevaTarea={agendable ? (dia) => abrirTarea(null, new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), 9, 0)) : undefined}
            />

            {/* Una rejilla vacía no dice por qué está vacía. Aquí sólo puede ser una
                cosa —no le han puesto nada en estos días— y decirlo evita la llamada
                a la oficina preguntando si la pantalla falla. */}
            {!cargandoCal && visitas.length === 0 && tareas.length === 0 && (
              <p className="flex items-center gap-2 rounded-xl border border-dashed border-border-subtle bg-surface px-3 py-2.5 text-[12.5px] text-text-tertiary">
                <Icon name="calendar-clock" size={14} className="shrink-0" />
                {vista === "mes" ? "No tienes nada agendado en este mes." : "No tienes nada agendado en esta semana."}
              </p>
            )}
          </div>
        </div>
      )}

      {/* El mismo formulario de `/agenda`: una tarea agendada aquí es un evento de la
          agenda de la empresa, no una cosa aparte que sólo viva en esta pantalla. */}
      {agendable && (
        <EventoModal
          abierto={modalAbierto}
          evento={enEdicion}
          fechaSugerida={fechaSugerida}
          onCerrar={() => setModalAbierto(false)}
          onGuardado={() => setRecargaTareas((n) => n + 1)}
        />
      )}
    </div>
  );
}
