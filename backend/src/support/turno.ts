import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hoyEnColombia } from '../common/fecha-colombia';
import { subName } from '../common/subscriber-name';
import { AuthUser } from '../auth/current-user.decorator';
import { esTecnicoDeCampo } from '../common/tecnico-scope';
import { DIAS_REZAGO, ORDEN_AGENDA } from './agenda-dia';

/**
 * Una orden a la vez — **la regla del legacy, tal cual** (2026-09-10).
 *
 * El legacy lleva años con esta regla escrita en una sola línea, en
 * `application/controllers/Tickets.php` (`update_status`, ~línea 843):
 *
 * ```php
 * if ($status == "Realizando") {
 *   $q = $this->db->query("select * from tickets
 *                          where asignado='".$ticket->asignado."' and status='Realizando'")->result();
 *   if (count($q) > 0 && $ticket->asignado != null && $ticket->asignado != "")
 *     $txt_error .= "<li>Ya tiene una orden abierta <a href='...'>".$q[0]->codigo."</a></li>";
 * }
 * ```
 *
 * Tres cosas se leen ahí, y las tres las copia este fichero a pedido del usuario
 * (2026-09-10, después de mirar juntos el legacy):
 *
 *  1. **"Abierta" quiere decir EMPEZADA (`Realizando`), y nada más.** Lo que sólo
 *     está `Pendiente` —asignado, agendado, en su cola del día— no ancla a nadie. Es
 *     la misma corrección que pidió el usuario el 2026-09-09 («hay órdenes asignadas
 *     mas no abiertas y no me deja hacer otras»), llevada hasta el final: ni siquiera
 *     la visita del día ancla ya. Contra la BD viva del legacy la diferencia es
 *     enorme: hay 341 órdenes `Pendiente` y sólo 11 `Realizando`, y los técnicos
 *     cargan de 8 a 18 abiertas cada uno.
 *  2. **Lo único que se bloquea es EMPEZAR la segunda.** Ver otra orden, consultarla,
 *     documentarla o cerrarla no se toca: el legacy sólo entra en esa rama cuando el
 *     estado que se pide es `Realizando`. Por eso este fichero ya no tiene puerta en
 *     `SupportService.ticketDetail` — se le quitó el mismo día que se puso.
 *  3. **No hay freno al ASIGNAR.** Quien agenda reparte el día que quiera; el candado
 *     es del momento de trabajar. (Con los datos de hoy, limitar la asignación habría
 *     parado el agendamiento en seco.)
 *
 * **A quién se le aplica** (`turnoAplicaA`): al técnico de campo SIEMPRE —para él no
 * es un interruptor, es su forma de trabajar— y al resto del personal sólo con el
 * gate `UNA_ORDEN_A_LA_VEZ`, hoy apagado. En el legacy la regla es de todo el mundo
 * porque allá el botón "Realizando" lo pulsa el técnico; aquí se conserva el gate
 * para poder extenderla sin tocar código.
 *
 * **Dos cosas que el legacy NO tiene y aquí sí**, porque allá son un problema real y
 * no una virtud:
 *
 *  · **El corte de rezago** (`DIAS_REZAGO`). El legacy tiene ahora mismo órdenes en
 *    `Realizando` desde 2025-04-23 que nadie va a cerrar: quien las tenga a su nombre
 *    queda bloqueado para siempre y sin salida. Aquí una empezada más vieja que el
 *    corte deja de anclar.
 *  · **El exento** (`Staff.agendaLibre`), que es además la válvula de escape cuando
 *    alguien queda anclado a una orden que no puede cerrar.
 *
 * **Vive aquí, suelto, y no dentro de un servicio, por una razón concreta:** la
 * pantalla (`AgendaService.miAgenda`) y la puerta que bloquea empezar la segunda
 * (`SupportWriteService.updateStatus`) tienen que responder EXACTAMENTE lo mismo. Si
 * cada una lo calculara por su cuenta acabarían discrepando, y el síntoma sería el
 * peor posible: una pantalla que ofrece empezar una orden y una API que la rechaza.
 * Meterlo en `AgendaService` habría creado además un ciclo de imports con
 * `SupportService`.
 */

/**
 * El candado PARA TODO EL PERSONAL — apagado desde el 2026-09-09, a pedido del usuario
 * («quite eso de solo dejar una orden a la vez por el momento, deje que pueda cerrar
 * otras así tenga asignadas o abiertas otras órdenes»).
 *
 * Sigue siendo un interruptor y no una demolición: encendido con
 * `UNA_ORDEN_A_LA_VEZ=true`, caja, sistemas, comercial y administración tampoco pueden
 * tener dos órdenes empezadas a la vez. Apagado —como hoy— sólo lo lleva el técnico de
 * campo, por `turnoAplicaA()`.
 */
export const unaOrdenALaVezActiva = () =>
  process.env.UNA_ORDEN_A_LA_VEZ === 'true' || process.env.UNA_ORDEN_A_LA_VEZ === '1';

/**
 * ¿A esta persona le aplica el candado?
 *
 * Dos vías, y basta una:
 *
 *  · **Es técnico de campo** (2026-09-10). Para él la regla NO es un interruptor: es
 *    su forma de trabajar, la misma que ya tiene en el legacy.
 *  · **El interruptor general está encendido** — entonces le aplica a todo el mundo.
 *
 * Sin usuario (cron, sync, facturación, el chatbot) sólo cuenta el interruptor: son
 * procesos, no personas, y `esTecnicoDeCampo` ya devuelve `false` para ellos. Eso es
 * lo que deja que la reconexión automática mueva su orden aunque el técnico tenga una
 * empezada.
 */
export function turnoAplicaA(user?: AuthUser | null): boolean {
  return esTecnicoDeCampo(user) || unaOrdenALaVezActiva();
}

/** Lo que hay que saber de la orden que la persona ya tiene empezada para avisar con enlace. */
export type OrdenEnCurso = {
  id: string;
  code: number | null;
  type: string;
  cliente: string | null;
  /** 'YYYY-MM-DD' del día para el que está agendada, o `null` si no lo está. */
  agendadaPara: string | null;
};

type FichaTurno = { name: string; username: string | null; agendaLibre: boolean };

/**
 * Los datos de la ficha que necesita esta regla, en UNA consulta: cómo se escribe su
 * nombre en las órdenes y si está exento.
 */
async function fichaTurno(prisma: PrismaService, staffId: string): Promise<FichaTurno | null> {
  return prisma.staff.findUnique({
    where: { id: staffId },
    select: { name: true, username: true, agendaLibre: true },
  });
}

/**
 * ¿Este funcionario está exento? (2026-09-02, a pedido del usuario, para Oscar
 * Rodríguez Fonseca.)
 *
 * Es una bandera POR PERSONA en su ficha (`Staff.agendaLibre`) y no un nombre escrito
 * en el código: el día que la excepción se le quiera dar a otro —o quitársela a él—
 * se cambia un dato, no se toca esto.
 *
 * Es además la válvula de escape del candado, la que el legacy no tiene: si alguien
 * queda anclado a una orden empezada que no puede cerrar, se le pone la bandera
 * mientras se resuelve.
 */
export async function tieneAgendaLibre(
  prisma: PrismaService,
  staffId: string,
  user?: AuthUser | null,
): Promise<boolean> {
  // A quien no le aplica el candado trabaja como el exento. Es lo que hace que apagar
  // el interruptor no deje media pantalla hablando de un turno que ya no existe.
  if (!turnoAplicaA(user)) return true;
  const s = await fichaTurno(prisma, staffId);
  return s?.agendaLibre === true;
}

/**
 * Qué órdenes son SUYAS.
 *
 * Las dos formas cuentan y son la misma persona: la FK (`assignedStaffId`, las que se
 * asignan aquí) y el texto libre heredado del legacy (`assigned`, con su nombre
 * completo o su username) — que es justo el campo `asignado` con el que compara la
 * consulta del legacy. Mirar sólo la FK dejaría fuera la mitad de la cola de los
 * técnicos veteranos, y el candado se saltaría precisamente con las órdenes viejas.
 */
function suyas(staffId: string, ficha: FichaTurno): Prisma.TicketWhereInput {
  const claves = [ficha.name, ficha.username].filter((c): c is string => Boolean(c?.trim()));
  return { OR: [{ assignedStaffId: staffId }, ...(claves.length ? [{ assigned: { in: claves } }] : [])] };
}

/**
 * La orden que esta persona tiene EMPEZADA, o `null` si no tiene ninguna.
 *
 * Empezada quiere decir `REALIZANDO` — el botón "Empezar" de la orden, que es
 * exactamente el `status='Realizando'` que consulta el legacy. Ni lo asignado, ni lo
 * agendado para hoy, ni lo atrasado: eso es su cola de trabajo, no trabajo en curso.
 * Se le puede repartir el día entero y entrar a ver la que quiera; lo que no puede es
 * tener dos empezadas a la vez.
 *
 * **El rezago no cuenta, y esto no es un adorno.** Es la única diferencia deliberada
 * con el legacy, y viene de mirar sus datos: allá hay órdenes en `Realizando` desde
 * 2025-04-23 —y abiertas sin empezar desde 2021—, y una empezada que nadie va a
 * cerrar deja a su técnico bloqueado para siempre, sin más salida que un UPDATE a
 * mano. Con el corte (`DIAS_REZAGO`, el mismo que separa agenda de rezago en el panel)
 * "trabajo vivo" quiere decir lo mismo en las dos pantallas y en el candado.
 */
export async function ordenEnCurso(
  prisma: PrismaService,
  staffId: string,
  user?: AuthUser | null,
): Promise<OrdenEnCurso | null> {
  if (!turnoAplicaA(user)) return null; // Sin candado: nada ancla a nadie.
  const ficha = await fichaTurno(prisma, staffId);
  if (!ficha) return null;
  return ordenEnCursoDe(prisma, staffId, ficha);
}

async function ordenEnCursoDe(
  prisma: PrismaService,
  staffId: string,
  ficha: FichaTurno,
): Promise<OrdenEnCurso | null> {
  // `created` y `scheduledFor` son columnas `date`: los cortes se comparan contra la
  // fecha de Colombia a medianoche UTC, que es como Prisma lee y escribe esas columnas.
  const hoy = hoyEnColombia();
  const corteRezago = new Date(hoy.getTime() - DIAS_REZAGO * 86400_000);
  // Se piden las empezadas y se toma la primera por el orden de la agenda —y no un
  // `findFirst` a secas— porque tener dos empezadas no debería pasar, pero pasa: el
  // legacy las creó antes de tener el candado y el sync las trae tal cual. Ante dos,
  // ancla la que la agenda pone primero, que es la misma que enseña la pantalla.
  const t = await prisma.ticket.findFirst({
    where: {
      AND: [suyas(staffId, ficha), { status: 'REALIZANDO' }, { created: { gte: corteRezago } }],
    },
    select: {
      id: true,
      code: true,
      type: true,
      scheduledFor: true,
      subscriber: {
        select: {
          fullName: true, firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true,
        },
      },
    },
    orderBy: ORDEN_AGENDA,
  });
  if (!t) return null;
  return {
    id: t.id,
    code: t.code ?? null,
    type: t.type,
    cliente: subName(t.subscriber),
    agendadaPara: t.scheduledFor ? t.scheduledFor.toISOString().slice(0, 10) : null,
  };
}

export type VeredictoTurno =
  | { permitido: true }
  | { permitido: false; motivo: string; enCurso: OrdenEnCurso };

/**
 * El aviso que ve quien intenta empezar una segunda orden. Uno solo, en un sitio.
 *
 * Dice lo mismo que el legacy («Ya tiene una orden abierta CÓDIGO») y por el mismo
 * motivo lleva el código: en el legacy es un enlace a la orden que hay que cerrar, y
 * aquí el id viaja aparte en `enCurso` para que la pantalla pinte ese mismo enlace.
 */
export function motivoDeOrdenAbierta(o: OrdenEnCurso): string {
  const quien = o.cliente ? ` de ${o.cliente}` : '';
  return `Ya tienes una orden abierta: ${o.code ? `#${o.code} · ` : ''}${o.type}${quien}. Ciérrala y podrás empezar otra.`;
}

/**
 * ¿Puede esta persona EMPEZAR esta orden (pasarla a `REALIZANDO`)?
 *
 * Es la única puerta del candado, y se llama sólo cuando el estado que se pide es
 * `REALIZANDO` — igual que el `if ($status=="Realizando")` del legacy. Todo lo demás
 * queda fuera a propósito:
 *
 *  · **Ver, documentar, adjuntar y CERRAR** cualquier orden, empezada o no, suya o
 *    ajena. El candado obliga a terminar lo empezado, no impide trabajar; y si además
 *    tapara el cierre, la orden que ancla no habría forma de quitarla de en medio.
 *  · **Volver a pulsar "Empezar" en la que ya tiene empezada** — es la misma, no una
 *    segunda. (El legacy sí se bloquea a sí mismo aquí: su consulta encuentra la
 *    propia orden. Es un fallo suyo, no una regla que copiar.)
 *  · **Quien no tiene ninguna empezada**, quien no tiene ficha de empleado (no hay
 *    forma de saber qué órdenes son suyas, y el lado seguro es dejar trabajar) y el
 *    exento (`Staff.agendaLibre`).
 *
 * Lo que NO es una puerta: que la otra orden empezada sea de otro día o de otra sede.
 * Con una empezada encima no se empieza ninguna otra.
 */
export async function puedeEmpezarOrden(
  prisma: PrismaService,
  staffId: string,
  ticket: { id: string },
  user?: AuthUser | null,
): Promise<VeredictoTurno> {
  if (!turnoAplicaA(user)) return { permitido: true }; // Sin candado: se empieza lo que sea.

  const ficha = await fichaTurno(prisma, staffId);
  if (!ficha) return { permitido: true };
  if (ficha.agendaLibre) return { permitido: true };

  const enCurso = await ordenEnCursoDe(prisma, staffId, ficha);
  if (!enCurso) return { permitido: true };
  if (enCurso.id === ticket.id) return { permitido: true };

  return { permitido: false, motivo: motivoDeOrdenAbierta(enCurso), enCurso };
}
