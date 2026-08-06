import { PrismaService } from '../prisma/prisma.service';
import { hoyEnColombia } from '../common/fecha-colombia';

/**
 * Turno obligatorio del técnico (decisión del usuario, 2026-08-04).
 *
 * El técnico ya no elige qué orden hace: atiende la primera de su día que siga
 * abierta, y hasta que no la cierre —o la aparte con un motivo— no ve la siguiente.
 * La cajera sigue siendo quien decide el orden; esto es lo que hace que ese orden se
 * cumpla en vez de ser una sugerencia.
 *
 * **Vive aquí, suelto, y no dentro de un servicio, por una razón concreta:** la
 * pantalla (`AgendaService.miTurno`) y la puerta que bloquea abrir otra orden
 * (`SupportService.ticketDetail`) tienen que responder EXACTAMENTE lo mismo. Si cada
 * una lo calculara por su cuenta acabarían discrepando, y el síntoma sería el peor
 * posible: una pantalla que le ofrece una visita y una API que se la rechaza. Meterlo
 * en `AgendaService` habría creado además un ciclo de imports con `SupportService`.
 */

/** Estados en los que una visita todavía cuenta como trabajo por hacer. */
const ABIERTA = ['PENDIENTE', 'REALIZANDO'] as const;

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
    where: { scheduledFor: dia, assignedStaffId: staffId, status: { in: [...ABIERTA] } },
    select: { id: true },
    orderBy: [{ scheduledSeq: 'asc' }, { created: 'asc' }],
  });
  return t?.id ?? null;
}

export type VeredictoTurno = { permitido: true } | { permitido: false; motivo: string };

/**
 * ¿Puede este técnico abrir esta orden?
 *
 * Tres puertas abiertas a propósito, porque cerrarlas rompería trabajo real:
 *
 *  1. **Las órdenes ya cerradas se pueden abrir siempre.** Son su historial: el panel
 *     de rendimiento enlaza a ellas ("las órdenes donde el cliente volvió a llamar"),
 *     y consultar lo que uno mismo hizo la semana pasada no es elegir trabajo.
 *  2. **Si hoy no tiene NADA agendado, no se bloquea nada.** Un día que la cajera no
 *     alcanzó a repartir dejaría al técnico sin poder tocar una sola orden. El turno
 *     obliga a seguir un orden; no puede convertirse en un candado que impide trabajar.
 *  3. **La orden en turno, obviamente.** Es la única pendiente que puede abrir.
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

  const turno = await visitaEnTurno(prisma, staffId, hoyEnColombia());
  if (!turno) return { permitido: true };
  if (turno === ticket.id) return { permitido: true };

  return {
    permitido: false,
    motivo:
      'Tienes una visita en turno: termínala (o márcala como no atendida) y el sistema te abre la siguiente. Las visitas se atienden en el orden que puso la persona de caja.',
  };
}
