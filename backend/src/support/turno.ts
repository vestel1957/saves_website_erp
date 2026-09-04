import { PrismaService } from '../prisma/prisma.service';
import { hoyEnColombia } from '../common/fecha-colombia';
import { ABIERTA, ORDEN_AGENDA, whereDelDia } from './agenda-dia';

/**
 * Turno obligatorio del técnico (decisión del usuario, 2026-08-04; retirado el
 * 2026-08-28 y **restituido el 2026-09-02** a pedido del usuario).
 *
 * El técnico no elige qué orden hace: atiende la primera de su día que siga abierta,
 * y hasta que no la cierre —o la aparte con un motivo— no ve la siguiente. La cajera
 * sigue siendo quien decide el orden; esto es lo que hace que ese orden se cumpla en
 * vez de ser una sugerencia.
 *
 * **Vive aquí, suelto, y no dentro de un servicio, por una razón concreta:** la
 * pantalla (`AgendaService.miAgenda`) y las dos puertas que bloquean tocar otra orden
 * (`SupportService.ticketDetail` y `SupportWriteService.updateStatus`) tienen que
 * responder EXACTAMENTE lo mismo. Si cada una lo calculara por su cuenta acabarían
 * discrepando, y el síntoma sería el peor posible: una pantalla que le ofrece una
 * visita y una API que se la rechaza. Meterlo en `AgendaService` habría creado además
 * un ciclo de imports con `SupportService`.
 *
 * Lo que cambia respecto de la primera versión: el día ya no es `scheduledFor = hoy`
 * a secas, sino el que define `agenda-dia.ts` —hoy MÁS lo atrasado que sigue abierto—
 * y se lee en su mismo orden (`ORDEN_AGENDA`). Con el `where` viejo, una visita
 * arrastrada del martes no era nunca "la del turno", así que el técnico se quedaba
 * mirando la primera de hoy mientras la atrasada no la podía abrir nadie.
 */

/**
 * La visita en turno de un técnico para un día, o `null` si no le queda nada abierto.
 *
 * El desempate por `created` importa: `scheduledSeq` se renumera 1..N en cada
 * movimiento, pero una fila a medio migrar puede llegar sin posición, y sin segundo
 * criterio el "turno" de ese día dependería del orden físico de la tabla.
 */
export async function visitaEnTurno(
  prisma: PrismaService,
  staffId: string,
  dia: Date,
): Promise<string | null> {
  const t = await prisma.ticket.findFirst({
    where: {
      ...whereDelDia(dia, hoyEnColombia()),
      assignedStaffId: staffId,
      status: { in: [...ABIERTA] },
    },
    select: { id: true },
    orderBy: ORDEN_AGENDA,
  });
  return t?.id ?? null;
}

/**
 * ¿Este técnico está exento del turno? (2026-09-02, a pedido del usuario, para Oscar
 * Rodríguez Fonseca.)
 *
 * Es una bandera POR PERSONA en su ficha (`Staff.agendaLibre`) y no un nombre escrito
 * en el código: el día que la excepción se le quiera dar a otro —o quitársela a él—
 * se cambia un dato, no se toca esto. Exento quiere decir que ve su jornada entera y
 * puede abrir cualquiera de sus visitas; el orden de la cajera le sigue llegando como
 * orden de la lista, pero deja de ser un candado.
 *
 * Para el resto del equipo no cambia nada: siguen con una visita a la vez.
 */
export async function tieneAgendaLibre(prisma: PrismaService, staffId: string): Promise<boolean> {
  const s = await prisma.staff.findUnique({
    where: { id: staffId },
    select: { agendaLibre: true },
  });
  return s?.agendaLibre === true;
}

export type VeredictoTurno = { permitido: true } | { permitido: false; motivo: string };

/** El mensaje que ve el técnico cuando intenta adelantarse. Uno solo, en un sitio. */
export const MOTIVO_FUERA_DE_TURNO =
  'Tienes una visita en turno: termínala (o márcala como no atendida) y el sistema te abre la siguiente. Las visitas se atienden en el orden que puso la persona de caja.';

/**
 * ¿Puede este técnico abrir esta orden?
 *
 * Cuatro puertas abiertas a propósito, porque cerrarlas rompería trabajo real:
 *
 *  1. **Las órdenes ya cerradas se pueden abrir siempre.** Son su historial: el panel
 *     de rendimiento enlaza a ellas ("las órdenes donde el cliente volvió a llamar"),
 *     y consultar lo que uno mismo hizo la semana pasada no es elegir trabajo.
 *  2. **Si hoy no tiene NADA agendado, no se bloquea nada.** Un día que la cajera no
 *     alcanzó a repartir dejaría al técnico sin poder tocar una sola orden. El turno
 *     obliga a seguir un orden; no puede convertirse en un candado que impide trabajar.
 *  3. **La orden en turno, obviamente.** Es la única pendiente que puede abrir.
 *  4. **El técnico exento** (`Staff.agendaLibre`), que no tiene turno que respetar.
 *
 * El día es SIEMPRE hoy en Colombia, no el de la orden: lo que se está decidiendo es
 * qué puede hacer el técnico ahora mismo.
 */
export async function puedeAbrirOrden(
  prisma: PrismaService,
  staffId: string,
  ticket: { id: string; status: string },
): Promise<VeredictoTurno> {
  if (!(ABIERTA as readonly string[]).includes(ticket.status)) return { permitido: true };
  // Cuarta puerta, ésta con nombre y apellido: el técnico exento abre lo que quiera
  // de lo suyo (ver `tieneAgendaLibre`).
  if (await tieneAgendaLibre(prisma, staffId)) return { permitido: true };

  const turno = await visitaEnTurno(prisma, staffId, hoyEnColombia());
  if (!turno) return { permitido: true };
  if (turno === ticket.id) return { permitido: true };

  return { permitido: false, motivo: MOTIVO_FUERA_DE_TURNO };
}
