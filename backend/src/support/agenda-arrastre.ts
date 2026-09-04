/**
 * El trabajo que no se resolvió pasa SOLO al día siguiente (2026-09-01).
 *
 * Hasta hoy el arrastre era de LECTURA: la visita que nadie cerró conservaba su día
 * y las pantallas la pintaban en hoy (`agenda-dia.ts`). Eso resolvía lo urgente —que
 * no desapareciera de la vista de nadie— pero dejaba la agenda diciendo una cosa y
 * la realidad otra: la orden seguía "agendada para el 27" cuando el 27 ya pasó, no
 * tenía puesto en la columna de hoy (la numeración es por día) y cualquier consulta
 * que no pasara por `whereDelDia` —un informe, el legacy, una pantalla nueva— la
 * volvía a perder de vista.
 *
 * Así que ahora se mueve de verdad: cada madrugada, lo que quedó ABIERTO en un día
 * ya pasado se reagenda para hoy y se numera al principio de la jornada de su
 * técnico. Tres decisiones que conviene tener a mano:
 *
 * 1. **Lo arrastrado va DELANTE.** Es lo más viejo: si lo de ayer entrara detrás de
 *    lo de hoy, el técnico haría antes lo que se puso esta mañana que lo que lleva
 *    tres días esperando, y el rezago no bajaría nunca. Es también el orden que ya
 *    tenían las pantallas (`ORDEN_AGENDA` lee lo atrasado primero), así que a la
 *    cajera no le cambia el tablero de sitio: le cambia a verdad.
 * 2. **El día original no se pierde**: viaja a `carriedFrom`, que es de donde sale la
 *    etiqueta "atrasada desde el 27". Sin eso, mover la fecha sería borrar la única
 *    prueba de que una visita lleva cinco días rodando.
 * 3. **No toca lo que no está agendado.** La que el técnico apartó ("llegué y no se
 *    pudo") se queda sin día a propósito: volvió a la bandeja de la cajera para que
 *    ella decida cuándo repetirla. Arrastrarla sería devolvérsela al técnico sin que
 *    nadie lo haya decidido.
 *
 * El arrastre de lectura NO se retira: sigue de red de seguridad para las horas en
 * que la tarea aún no ha corrido (o el día que no corra).
 */
import { Prisma } from '@prisma/client';
import { ABIERTA } from './agenda-dia';

/** Lo que hace falta saber de una orden para colocarla en la jornada. */
export type FilaArrastre = {
  id: string;
  scheduledFor: Date | null;
  carriedFrom: Date | null;
  scheduledSeq: number | null;
  created: Date | null;
};

/** Qué órdenes hay que mover: agendadas para un día ya pasado y todavía sin resolver. */
export function whereArrastrables(hoy: Date): Prisma.TicketWhereInput {
  return { scheduledFor: { lt: hoy }, status: { in: [...ABIERTA] } };
}

/**
 * En qué orden queda la columna de un técnico DESPUÉS de arrastrar: primero lo
 * arrastrado (lo más viejo delante) y detrás lo que ya estaba puesto para hoy, sin
 * alterarle su orden.
 *
 * Va aparte y es pura para poder probarla: es la única parte del arrastre donde hay
 * una decisión —quién va primero—, y equivocarse aquí no rompe nada visible hasta
 * que un técnico hace las visitas en el orden equivocado.
 *
 * El desempate es el mismo de siempre (`scheduledSeq`, y `created` cuando no hay):
 * dentro de un día que se arrastra entero se respeta el recorrido que armó la cajera.
 */
export function ordenDeLaJornada(filas: FilaArrastre[], hoy: Date): string[] {
  const origen = (f: FilaArrastre) => (f.carriedFrom ?? f.scheduledFor ?? hoy).getTime();
  return [...filas]
    .sort(
      (a, b) =>
        origen(a) - origen(b) ||
        (a.scheduledSeq ?? Number.MAX_SAFE_INTEGER) - (b.scheduledSeq ?? Number.MAX_SAFE_INTEGER) ||
        (a.created?.getTime() ?? 0) - (b.created?.getTime() ?? 0),
    )
    .map((f) => f.id);
}

/** Lo mínimo de Prisma que necesita el arrastre (así el cron no arrastra el servicio entero). */
type PrismaArrastre = {
  ticket: {
    findMany: (args: any) => Promise<any[]>;
    update: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  $transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

export type ResultadoArrastre = {
  /** Órdenes que cambiaron de día. */
  movidas: number;
  /** Cuántas jornadas (técnico) hubo que renumerar. */
  tecnicos: number;
  /** La visita más vieja que se arrastró, 'YYYY-MM-DD'. Es el termómetro del rezago. */
  masVieja: string | null;
};

/**
 * Mueve a `hoy` todo lo que quedó abierto en días anteriores.
 *
 * El movimiento va por DÍA de origen y fuera de transacción (dos sentencias por día,
 * no una transacción larga que bloquee la tabla de órdenes en plena madrugada de
 * facturación); la renumeración va después, una transacción por técnico. Si el
 * proceso se cae en medio, lo peor que queda es alguna columna sin `scheduledSeq`, y
 * ahí la lectura cae en su respaldo de siempre (el orden por `created`). Perder el
 * día, que es lo grave, ya no puede pasar.
 */
export async function arrastrarAlDiaDeHoy(
  prisma: PrismaArrastre,
  hoy: Date,
): Promise<ResultadoArrastre> {
  const pendientes: { id: string; scheduledFor: Date | null; assignedStaffId: string | null }[] =
    await prisma.ticket.findMany({
      where: whereArrastrables(hoy),
      select: { id: true, scheduledFor: true, assignedStaffId: true },
      orderBy: { scheduledFor: 'asc' },
    });
  if (!pendientes.length) return { movidas: 0, tecnicos: 0, masVieja: null };

  const ids = pendientes.map((p) => p.id);
  const masVieja = pendientes[0].scheduledFor?.toISOString().slice(0, 10) ?? null;

  // Se agrupan por su día de origen para poder sellar `carriedFrom` sin SQL crudo: el
  // día que hay que guardar es la clave del grupo. Y sólo se sella donde está vacío
  // (`carriedFrom: null`), porque lo que lleva tres días rodando tiene que seguir
  // diciendo que viene del lunes y no del martes.
  const porDia = new Map<number, string[]>();
  for (const p of pendientes) {
    if (!p.scheduledFor) continue;
    const k = p.scheduledFor.getTime();
    porDia.set(k, [...(porDia.get(k) ?? []), p.id]);
  }
  for (const [ms, delDia] of porDia) {
    await prisma.ticket.updateMany({
      where: { id: { in: delDia }, carriedFrom: null },
      data: { carriedFrom: new Date(ms) },
    });
    await prisma.ticket.updateMany({
      where: { id: { in: delDia } },
      data: { scheduledFor: hoy, scheduledSeq: null },
    });
  }

  // Las jornadas que hay que rehacer: la de hoy de cada técnico que recibió algo. Las
  // órdenes agendadas sin técnico (llegan así del legacy) se mueven igual, pero no
  // entran en ninguna columna y por tanto no se numeran.
  const staffs = [...new Set(pendientes.map((p) => p.assignedStaffId).filter((s): s is string => !!s))];
  for (const staffId of staffs) {
    await prisma.$transaction(async (tx) => {
      const filas: FilaArrastre[] = await tx.ticket.findMany({
        where: { scheduledFor: hoy, assignedStaffId: staffId },
        select: { id: true, scheduledFor: true, carriedFrom: true, scheduledSeq: true, created: true },
      });
      const orden = ordenDeLaJornada(filas, hoy);
      for (let i = 0; i < orden.length; i++) {
        await tx.ticket.update({ where: { id: orden[i] }, data: { scheduledSeq: i + 1 } });
      }
    });
  }

  return { movidas: ids.length, tecnicos: staffs.length, masVieja };
}
