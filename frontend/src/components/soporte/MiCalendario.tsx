"use client";

import Link from "next/link";
import { Icon } from "@/components/Icon";
import {
  DIAS_CORTOS, colorDe, cruzaElDia, diaISO, esFinDeSemana, horaCorta, inicioDe, mismoDia, type Evento,
} from "@/components/agenda/calendario";

/** Una visita del técnico, tal y como la manda `/support/mi-agenda/calendario`. */
export type VisitaCalendario = {
  id: string;
  code: number | null;
  type: string | null;
  subject: string | null;
  status: string;
  priority: string | null;
  cliente: string | null;
  direccion: string | null;
  /** La casilla en la que se pinta ('YYYY-MM-DD'): la suya, o HOY si viene atrasada. */
  dia: string | null;
  /** El día para el que se agendó de verdad. */
  agendadaPara: string | null;
  atrasada: boolean;
  puesto: number | null;
  nota: string | null;
};

/**
 * El color de la visita ES SU ESTADO, y no su prioridad.
 *
 * En un mes de 42 casillas lo que se busca de un vistazo es qué queda por hacer, no
 * qué era urgente en su día: pendiente y en curso tienen que saltar, y lo cerrado
 * tiene que apagarse sin desaparecer (ver el mes entero en gris claro es justo lo que
 * dice "esta semana ya está").
 */
const TONO: Record<string, { punto: string; texto: string }> = {
  PENDIENTE: { punto: "bg-brand", texto: "text-text-primary" },
  REALIZANDO: { punto: "bg-warning", texto: "text-text-primary" },
  REALIZADO: { punto: "bg-success", texto: "text-text-tertiary" },
  CERRADO: { punto: "bg-success", texto: "text-text-tertiary" },
  ANULADO: { punto: "bg-error", texto: "text-text-tertiary line-through" },
};
const tonoDe = (s: string) => TONO[s] ?? { punto: "bg-text-tertiary", texto: "text-text-secondary" };

/** Cuántas visitas caben en una casilla del mes antes de plegar el resto en "+N". */
const CABEN_MES = 3;

/**
 * El calendario del TÉCNICO: sus visitas sobre la misma rejilla que la agenda.
 *
 * Es el mismo tablero que `/agenda` —seis semanas de lunes a domingo, o una sola en
 * la vista de semana— pero pintando otra cosa, y la diferencia manda en el diseño:
 *
 * **una visita no tiene hora, tiene DÍA Y PUESTO.** La cajera agenda "el jueves" y
 * dentro del jueves reparte el orden (`scheduledSeq`); nadie pone las 10:15. Por eso
 * aquí no hay rejilla de horas —la de `/agenda` sería una fila de 24 casillas vacías
 * con todo amontonado en la banda de arriba— y cada visita se lee "2 · #505628
 * Instalación", que es como el técnico la nombra.
 *
 * Lo ATRASADO se pinta en HOY y no en el día en que se puso (lo decide el backend con
 * `celdaDelDia`, la misma regla que ve la cajera): hoy es cuando hay que hacerlo. Que
 * viene rodando se dice con la flecha y la fecha original, no moviéndolo de sitio.
 */
export function MiCalendario({
  dias,
  mes,
  visitas,
  tareas = [],
  hoyISO,
  onVerDia,
  onAbrirTarea,
  onNuevaTarea,
}: {
  /** Los días a pintar: 42 (mes) o 7 (semana). */
  dias: Date[];
  /** El mes que se mira: los días de fuera se atenúan pero se siguen viendo. */
  mes: Date;
  visitas: VisitaCalendario[];
  /**
   * Lo que uno se agenda a sí mismo (`CalendarEvent`). Va POR ENCIMA de las visitas
   * en cada casilla y con su color: el trabajo repartido y lo que uno se apunta son
   * dos cosas distintas, y la reunión de las 10 no es la visita número 3.
   */
  tareas?: Evento[];
  hoyISO: string;
  /** Ir al día: la vista de "hoy" pero de ese día. */
  onVerDia: (dia: Date) => void;
  onAbrirTarea?: (tarea: Evento) => void;
  /** Agendar en ESE día. Sin esto la casilla no ofrece crear nada. */
  onNuevaTarea?: (dia: Date) => void;
}) {
  const semanas = Array.from({ length: Math.ceil(dias.length / 7) }, (_, i) => dias.slice(i * 7, i * 7 + 7));
  const hoy = new Date();
  // Una sola pasada: en un mes cargado son ~200 visitas y 42 casillas.
  const porDia = new Map<string, VisitaCalendario[]>();
  for (const v of visitas) {
    if (!v.dia) continue;
    const lista = porDia.get(v.dia) ?? [];
    lista.push(v);
    porDia.set(v.dia, lista);
  }
  // En la semana caben más renglones por casilla que en el mes: hay siete veces menos.
  const caben = dias.length <= 7 ? 8 : CABEN_MES;

  return (
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface">
      <div className="grid grid-cols-7 border-b border-border-subtle bg-surface-2">
        {DIAS_CORTOS.map((d) => (
          <div key={d} className="px-1 py-1.5 text-center text-[10px] font-bold uppercase tracking-wide text-text-tertiary">
            {d}
          </div>
        ))}
      </div>

      {semanas.map((semana, i) => (
        <div key={diaISO(semana[0])} className={`grid grid-cols-7 ${i < semanas.length - 1 ? "border-b border-border-subtle" : ""}`}>
          {semana.map((dia) => {
            const clave = diaISO(dia);
            const delDia = porDia.get(clave) ?? [];
            const esHoy = mismoDia(dia, hoy);
            const delMes = dia.getMonth() === mes.getMonth();
            const delDiaTareas = tareas.filter((t) => cruzaElDia(t, dia));
            const sitio = Math.max(1, caben - delDiaTareas.length);
            const visibles = delDia.length > sitio ? delDia.slice(0, sitio - 1) : delDia;
            const ocultas = delDia.length - visibles.length;
            const pendientes = delDia.filter((v) => v.status === "PENDIENTE" || v.status === "REALIZANDO").length;

            return (
              <div
                key={clave}
                className={`group/casilla flex min-h-[104px] flex-col gap-[3px] border-r border-border-subtle px-1 pb-1 pt-1 last:border-r-0 sm:min-h-[118px] ${
                  delMes ? (esFinDeSemana(dia) ? "bg-surface-2/40" : "bg-surface") : "bg-surface-2/70"
                }`}
              >
                {/* La cabecera de la casilla ES el botón de "llévame a ese día": el
                    técnico entra a un día a trabajarlo, no a mirarlo. */}
                <button
                  type="button"
                  onClick={() => onVerDia(dia)}
                  title={`Ver el ${clave}`}
                  // El contenido del botón es un número (y a veces un contador): sin
                  // esto, quien navega con lector de pantalla oye "8 3" y no puede
                  // saber que eso lleva a la jornada del día 8.
                  aria-label={`Ver el ${clave}`}
                  className="foco flex items-center justify-between rounded px-0.5 text-left hover:bg-surface-2"
                >
                  <span
                    className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[11.5px] font-bold tabular-nums ${
                      esHoy ? "bg-brand text-on-brand" : delMes ? "text-text-secondary" : "text-text-tertiary/70"
                    }`}
                  >
                    {dia.getDate()}
                  </span>
                  {pendientes > 0 && (
                    <span className="rounded-full bg-brand-soft px-1.5 text-[10px] font-bold text-brand" title={`${pendientes} por hacer`}>
                      {pendientes}
                    </span>
                  )}
                </button>

                {delDiaTareas.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    onClick={() => onAbrirTarea?.(t)}
                    title={`${t.allDay ? "Todo el día" : horaCorta(inicioDe(t))} · ${t.title ?? "(sin título)"}`}
                    className="foco flex items-center gap-1 rounded px-1 py-[1px] text-left text-[11px] leading-tight hover:bg-surface-2"
                  >
                    <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ backgroundColor: colorDe(t) }} />
                    {!t.allDay && (
                      <span className="shrink-0 font-semibold tabular-nums text-text-tertiary">{horaCorta(inicioDe(t))}</span>
                    )}
                    <span className="truncate font-medium text-text-primary">{t.title || "(sin título)"}</span>
                  </button>
                ))}

                {visibles.map((v) => {
                  const tono = tonoDe(v.status);
                  return (
                    <Link
                      key={v.id}
                      href={`/soporte/${v.id}`}
                      title={[
                        v.code ? `#${v.code}` : null,
                        v.type,
                        v.cliente,
                        v.direccion,
                        v.atrasada && v.agendadaPara ? `atrasada desde el ${v.agendadaPara}` : null,
                      ].filter(Boolean).join(" · ")}
                      className="foco flex items-center gap-1 rounded px-1 py-[1px] text-[11px] leading-tight hover:bg-surface-2"
                    >
                      <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${tono.punto}`} />
                      {v.atrasada && <Icon name="history" size={10} className="shrink-0 text-warning-text" />}
                      {v.puesto != null && (
                        <span className="shrink-0 font-mono text-[10px] font-bold tabular-nums text-text-tertiary">{v.puesto}</span>
                      )}
                      <span className={`truncate ${tono.texto}`}>{v.type || v.subject || `#${v.code ?? "—"}`}</span>
                    </Link>
                  );
                })}

                {ocultas > 0 && (
                  <button
                    type="button"
                    onClick={() => onVerDia(dia)}
                    className="foco rounded px-1 text-left text-[11px] font-semibold text-text-tertiary hover:text-brand hover:underline"
                  >
                    +{ocultas} más
                  </button>
                )}

                {/* Agendar EN ESE DÍA sin pasar por el botón de arriba. Aparece al
                    pasar por encima —y siempre en táctil, que no tiene "encima"— para
                    que no haya 42 signos de más compitiendo con el trabajo del día. */}
                {onNuevaTarea && (
                  <button
                    type="button"
                    onClick={() => onNuevaTarea(dia)}
                    aria-label={`Agendar una tarea el ${clave}`}
                    className="foco mt-auto rounded px-1 text-left text-[11px] font-semibold text-text-tertiary opacity-0 transition-opacity hover:text-brand focus-visible:opacity-100 group-hover/casilla:opacity-100 sm:opacity-0 [@media(hover:none)]:opacity-60"
                  >
                    + tarea
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
