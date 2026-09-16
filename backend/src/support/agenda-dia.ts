import { Prisma } from '@prisma/client';

/**
 * Qué órdenes componen el día de un técnico, y en qué orden se leen.
 *
 * Vive suelto y no dentro de un servicio porque lo preguntan varios: la pantalla del
 * técnico (`AgendaService.miAgenda`), la de la cajera y el calendario. Si cada una lo
 * calculara por su cuenta acabarían discrepando, y el síntoma sería el peor posible:
 * una visita que sale en un sitio y no en el otro. Meterlo en `AgendaService` habría
 * creado además un ciclo de imports con `SupportService`.
 *
 * **Aquí no hay candado, pero sí lo que el candado lee.** "Una orden a la vez" —para
 * todo el personal desde el 2026-09-09— vive en `turno.ts`, y calcula la orden que
 * ancla a cada quien con dos cosas de este fichero: `ORDEN_AGENDA` (para que "la
 * primera" sea la misma que ve la pantalla) y `DIAS_REZAGO` (para no anclar a nadie a
 * un fantasma de 2021). Lo que ya NO comparte es `whereDelDia`: el candado mira todas
 * sus órdenes abiertas, agendadas o no, y no sólo las del día.
 */

/**
 * A partir de aquí una orden abierta ya no es trabajo del día: es rezago.
 *
 * No es un capricho. De las 509 órdenes abiertas de la empresa, 164 llevan MÁS DE UN
 * AÑO sin cerrar y las más viejas son de 2021 — nadie las va a atender hoy. Metidas en
 * la misma lista y ordenadas por antigüedad (que es lo correcto para el trabajo real),
 * copaban las primeras pantallas y enterraban lo de esta semana.
 *
 * Vive aquí, y no dentro de `SupportService` como nació, porque desde el 2026-09-09 lo
 * lee también el candado de "una orden a la vez" (`turno.ts`): la orden que ancla a un
 * funcionario tiene que ser trabajo vivo, no un fantasma de 2021 que nadie va a cerrar.
 * Con dos constantes separadas, el panel diría "esto es rezago" y el candado seguiría
 * exigiendo cerrarlo.
 */
export const DIAS_REZAGO = 90;

/** Estados en los que una visita todavía cuenta como trabajo por hacer. */
export const ABIERTA = ['PENDIENTE', 'REALIZANDO'] as const;

/**
 * Qué órdenes cuentan como "las de este día" al LEER la agenda (2026-08-11).
 *
 * Para cualquier día que no sea hoy es lo obvio: las agendadas para ese día. Para
 * HOY se le suma lo ATRASADO —lo que quedó abierto de días anteriores—, y esa es la
 * corrección que trae esta función.
 *
 * El agujero que tapa: una visita agendada el 6 y que nadie cerró desaparecía de la
 * pantalla del técnico (que solo mira hoy) y también de la bandeja de la cajera (que
 * solo trae lo que NO tiene día). Seguía viva en la base y no la veía nadie.
 *
 * Dos detalles que no son adorno:
 *
 *  · Solo arrastra lo ABIERTO. Sin ese filtro, la columna de hoy se llenaría con
 *    todo lo que el técnico ya resolvió en semanas pasadas.
 *  · El arrastre es de LECTURA. Desde el 2026-09-01 hay además uno de ESCRITURA —la
 *    tarea `agenda-arrastre` mueve de verdad al día siguiente, cada madrugada, lo que
 *    quedó abierto (ver `agenda-arrastre.ts`)—, así que en régimen normal esta
 *    función ya casi nunca encuentra nada que arrastrar. Se queda de red de seguridad
 *    para las horas en que la tarea aún no ha corrido, o el día que no corra: sin
 *    ella, una visita sin cerrar volvería a desaparecer de todas las pantallas.
 *
 * Ojo al renumerar: ahí NO se usa esto. `scheduledSeq` es la posición dentro de un
 * día concreto, y renumerar "hoy" arrastrando el 6 de agosto le reescribiría el
 * orden a un día que ya pasó. Por eso las lecturas ordenan primero por
 * `scheduledFor`: lo atrasado va delante, y dentro de cada día manda su propia
 * secuencia.
 */
export function whereDelDia(dia: Date, hoy: Date): Prisma.TicketWhereInput {
  if (dia.getTime() !== hoy.getTime()) return { scheduledFor: dia };
  return {
    OR: [
      { scheduledFor: dia },
      { scheduledFor: { lt: dia }, status: { in: [...ABIERTA] } },
    ],
  };
}

/** Orden de lectura de una agenda: lo atrasado primero y, dentro de cada día, el que puso la cajera. */
export const ORDEN_AGENDA = [
  { scheduledFor: 'asc' },
  { scheduledSeq: 'asc' },
  { created: 'asc' },
] satisfies Prisma.TicketOrderByWithRelationInput[];

/**
 * Lo mismo que `whereDelDia`, pero para un RANGO de días — la semana y el mes del
 * calendario (2026-08-26).
 *
 * Se escribe aquí, al lado de su hermana, porque la regla que hay que respetar es la
 * misma y es la que se olvida: lo ATRASADO —agendado antes de hoy y todavía abierto—
 * sigue siendo trabajo de hoy. Si el rango contiene hoy, entra también; si el rango
 * es todo futuro (la semana que viene), no hay nada que arrastrar y la condición no
 * se añade, o el calendario de septiembre traería medio 2021 dentro.
 */
export function whereDelRango(desde: Date, hasta: Date, hoy: Date): Prisma.TicketWhereInput {
  const enRango = hoy.getTime() >= desde.getTime() && hoy.getTime() <= hasta.getTime();
  const delRango: Prisma.TicketWhereInput = { scheduledFor: { gte: desde, lte: hasta } };
  if (!enRango) return delRango;
  return { OR: [delRango, { scheduledFor: { lt: hoy }, status: { in: [...ABIERTA] } }] };
}

/**
 * El día para el que se agendó DE VERDAD: el suyo, o aquel del que viene arrastrada.
 *
 * Es lo que hay que comparar contra la casilla en la que se pinta para saber si una
 * visita va atrasada. Antes bastaba `scheduledFor` —el arrastre era de lectura y la
 * fecha no se movía—, pero desde que `agenda-arrastre` la reescribe, mirar sólo
 * `scheduledFor` daría cero atrasadas: todas serían "de hoy".
 */
export function origenDelDia(t: { scheduledFor: Date | null; carriedFrom?: Date | null }): string | null {
  const d = t.carriedFrom ?? t.scheduledFor;
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * En qué casilla del calendario se pinta una visita: la suya, salvo que venga
 * atrasada — entonces se pinta en HOY, que es el día en que de verdad hay que hacerla.
 *
 * Devuelve 'YYYY-MM-DD' y no un `Date` a propósito: es una clave para agrupar, y
 * comparar fechas por texto ISO no tiene el problema de zona que sí tienen los
 * `Date`. El día original no se pierde: la tarjeta lo lleva en `agendadaPara`.
 */
export function celdaDelDia(scheduledFor: Date, status: string, hoy: Date): string {
  const atrasada =
    scheduledFor.getTime() < hoy.getTime() && (ABIERTA as readonly string[]).includes(status);
  return (atrasada ? hoy : scheduledFor).toISOString().slice(0, 10);
}

/**
 * El TRABAJO DE HOY de una persona: lo que se le enseña al técnico de campo en
 * `/soporte` (2026-09-10, a pedido del usuario: «mostrar únicamente las órdenes
 * asignadas al técnico para el día actual; no deben visualizar el historial completo
 * de órdenes realizadas»).
 *
 * Hasta hoy su bandeja traía TODAS sus órdenes desde siempre —966 en el caso de
 * Miguel Ángel, con las de 2021 dentro—. Su día es lo que tiene que ver.
 *
 * Qué cuenta como "hoy", y por qué cada renglón:
 *
 *  · **Lo agendado para hoy y lo atrasado que sigue abierto** — exactamente lo que
 *    `whereDelDia` le pinta en `/mi-agenda`. Las dos pantallas tienen que decir lo
 *    mismo o el técnico creerá que perdió una visita.
 *  · **Lo EMPEZADO** (`REALIZANDO`), esté agendado o no: si lo tiene a medias es
 *    trabajo de hoy por definición — y es además lo que le ancla el turno
 *    (`turno.ts`), así que esconderlo lo dejaría bloqueado sin ver por qué.
 *  · **Lo asignado hoy sin agendar y todavía abierto.** No es un adorno: de 416
 *    órdenes cerradas en dos semanas, 112 nunca se agendaron —las abre la cajera y
 *    las cierra el técnico el mismo día—. Sin este renglón ese trabajo desaparecía
 *    de su pantalla en el momento en que se le asigna. Lo de días anteriores sin
 *    agendar no entra: eso es cola, y para eso está el agendamiento.
 *  · **Lo que cerró o apartó HOY**, para que vea lo que lleva hecho. Sin esto, cerrar
 *    una orden la borraba de la pantalla y el día terminado se veía como uno en
 *    blanco.
 *
 * Lo de días anteriores ya cerrado NO entra: para eso está su historial
 * (`/mi-agenda/historial`), que lo enseña por día de trabajo.
 */
export function whereTrabajoDelDia(hoy: Date): Prisma.TicketWhereInput {
  // `skippedAt` y `resolvedAt` son instantes; `created`, `scheduledFor` y `finalDate`
  // son columnas `date` que se comparan contra la medianoche de Colombia.
  const finDelDia = new Date(hoy.getTime() + 86_400_000 - 1);
  return {
    OR: [
      whereDelDia(hoy, hoy),
      { status: 'REALIZANDO' },
      { scheduledFor: null, status: { in: [...ABIERTA] }, created: hoy },
      { finalDate: hoy },
      { resolvedAt: { gte: hoy, lte: finDelDia } },
      { skippedAt: { gte: hoy, lte: finDelDia } },
    ],
  };
}
