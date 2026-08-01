import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { hoyEnColombia } from '../common/fecha-colombia';
import { CARGO_TECNICO } from '../staff/cargos-legacy';
import { esTecnicoDeCampo } from '../common/tecnico-scope';
import { TICKET_ASIGNADO_EVENT, type TicketAsignadoEvent } from './support.events';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { rangoPrioridad } from './support.service';

/**
 * Agendamiento de órdenes de trabajo (2026-07-31).
 *
 * Quien agenda es la CAJERA: reparte el trabajo del día entre los técnicos y decide
 * en qué ORDEN va cada visita. El técnico no arma su agenda, la sigue. Eso es lo que
 * este servicio modela, y por qué las dos piezas nuevas del `Ticket` son una fecha
 * (`scheduledFor`, sin hora — se agenda el día) y una posición (`scheduledSeq`).
 *
 * Tres reglas que conviene tener claras antes de tocar esto:
 *
 * 1. **La posición se renumera entera, siempre.** No se insertan decimales ni se
 *    dejan huecos: cada movimiento reescribe 1..N la columna del técnico ese día. Es
 *    más escritura, pero hace imposible el estado que arruina estas pantallas —dos
 *    órdenes en la posición 3, o una agenda que empieza en 7—.
 * 2. **Agendar ASIGNA.** Poner una orden en la columna de un técnico es asignársela:
 *    no tendría sentido agendarle a alguien trabajo que no es suyo. Por eso se
 *    escriben también `assigned`/`assignedStaffId`/`assignedAt` y se emite el mismo
 *    evento que `assign()`, que es lo que dispara el aviso al cliente.
 * 3. **Desagendar NO desasigna.** Sacar una orden del día la devuelve a "sin
 *    agendar", pero sigue siendo del técnico: quitarle el trabajo de encima por
 *    mover una tarjeta sería una sorpresa desagradable.
 */
@Injectable()
export class AgendaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Convierte 'YYYY-MM-DD' al `Date` que Prisma escribe en una columna `date`.
   *
   * Se construye en UTC a mano y NO con `new Date(texto)`: la sesión de Postgres
   * corre en Europe/Berlin y atar un `Date` local contra una columna `date` corre el
   * rango un día entero (el mismo tropiezo documentado en `sql-crudo-fechas-date`).
   */
  private diaDe(fecha?: string): Date {
    if (!fecha?.trim()) return hoyEnColombia();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha.trim());
    if (!m) throw new BadRequestException('La fecha debe venir como YYYY-MM-DD.');
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }

  /**
   * Sedes (`Branch.legacyId`) del usuario; `[]` = sin límite (gerencia/admin).
   *
   * La caja también dice de qué sede es quien agenda: hay cajeras activas SIN
   * `sedesAccede` cargado pero con caja asignada, y sin esta segunda vía se les
   * abrían los técnicos de TODAS las sedes — porque aquí la lista vacía significa
   * "sin límite". Es el mismo rescate que hace `network/bodega-scope.ts` con el
   * inventario, por la misma razón y contra los mismos datos a medio migrar.
   */
  private async sedesDelUsuario(user: AuthUser): Promise<number[]> {
    const u = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { sedesAccede: true, cajaLegacyId: true },
    });
    const sedes = new Set<number>((u?.sedesAccede ?? []).filter((n) => Number.isFinite(n) && n > 0));
    if (!sedes.size && u?.cajaLegacyId != null) {
      const caja = await this.prisma.cashAccount.findUnique({
        where: { legacyId: u.cajaLegacyId },
        select: { branchLegacy: true },
      });
      // `branchLegacy = 0` es un banco, no una sede: no aporta.
      if (caja?.branchLegacy != null && caja.branchLegacy > 0) sedes.add(caja.branchLegacy);
    }
    return [...sedes];
  }

  /** `Staff.sedeAccede` es el CSV del legacy ('-3-,-4-'); vacío = todas. */
  private static parseSedes(csv: string | null | undefined): number[] {
    if (!csv) return [];
    const ids = csv.split(',').map((p) => Number(p.replace(/-/g, '').trim())).filter((n) => Number.isFinite(n) && n > 0);
    return [...new Set(ids)];
  }

  /**
   * Técnicos que se pintan como columna.
   *
   * Son los del cargo TÉCNICO activos (12 hoy), acotados a la sede de quien agenda:
   * una cajera de Villanueva no reparte el día de los técnicos de Yopal. Se añaden
   * siempre los que YA tengan algo agendado ese día aunque no cumplan el filtro, o
   * una agenda hecha por otra persona desaparecería de la pantalla sin avisar.
   */
  private async columnas(mias: number[], dia: Date) {
    const [tecnicos, yaAgendados] = await Promise.all([
      this.prisma.staff.findMany({
        where: { banned: false, role: CARGO_TECNICO },
        select: { id: true, name: true, username: true, sedeAccede: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.ticket.findMany({
        where: { scheduledFor: dia, assignedStaffId: { not: null } },
        select: { assignedStaff: { select: { id: true, name: true, username: true, sedeAccede: true } } },
        distinct: ['assignedStaffId'],
      }),
    ]);

    const deMiSede = (csv: string | null | undefined) => {
      if (!mias.length) return true; // sin límite
      const suyas = AgendaService.parseSedes(csv);
      return suyas.length === 0 || suyas.some((s) => mias.includes(s));
    };

    const porId = new Map<string, { id: string; name: string; username: string | null }>();
    for (const t of tecnicos) if (deMiSede(t.sedeAccede)) porId.set(t.id, t);
    for (const r of yaAgendados) if (r.assignedStaff) porId.set(r.assignedStaff.id, r.assignedStaff);
    return [...porId.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  private static readonly TARJETA = {
    id: true, code: true, subject: true, type: true, priority: true, status: true,
    created: true, problem: true, scheduledSeq: true, scheduledByName: true,
    assignedStaffId: true, assigned: true,
    subscriber: {
      select: {
        id: true, abonado: true, firstName: true, lastName1: true, companyName: true, fullName: true,
        addressLine: true, phone1: true, neighborhood: true, branch: { select: { name: true } },
      },
    },
  } satisfies Prisma.TicketSelect;

  private static nombreAbonado(s: { firstName: string | null; lastName1: string | null; companyName: string | null; fullName: string | null } | null): string | null {
    if (!s) return null;
    if (s.fullName?.trim()) return s.fullName.trim();
    const p = [s.firstName, s.lastName1].map((x) => (x || '').trim()).filter(Boolean).join(' ');
    return p || (s.companyName || '').trim() || null;
  }

  private async tarjeta(t: any, barrios: Map<number, string>) {
    const nb = Number(t.subscriber?.neighborhood);
    return {
      id: t.id, code: t.code, subject: t.subject, type: t.type, priority: t.priority,
      status: t.status, created: t.created, problema: t.problem,
      seq: t.scheduledSeq, agendadaPor: t.scheduledByName,
      staffId: t.assignedStaffId, tecnico: t.assigned,
      cliente: AgendaService.nombreAbonado(t.subscriber), abonado: t.subscriber?.abonado ?? null,
      subscriberId: t.subscriber?.id ?? null,
      direccion: t.subscriber?.addressLine ?? null,
      telefono: t.subscriber?.phone1 ?? null,
      sede: t.subscriber?.branch?.name ?? null,
      barrio: Number.isFinite(nb) ? barrios.get(nb) ?? null : null,
    };
  }

  /** Resuelve los nombres de barrio de un lote de tarjetas (el ticket guarda el id legacy). */
  private async barriosDe(filas: { subscriber: { neighborhood: string | null } | null }[]) {
    const ids = [...new Set(filas.map((f) => Number(f.subscriber?.neighborhood)).filter((n) => Number.isFinite(n)))];
    if (!ids.length) return new Map<number, string>();
    const rows = await this.prisma.neighborhood.findMany({ where: { legacyId: { in: ids } }, select: { legacyId: true, name: true } });
    return new Map(rows.flatMap((n) => (n.legacyId == null ? [] : [[n.legacyId, n.name] as [number, string]])));
  }

  /**
   * El tablero de un día: la bandeja de "sin agendar" y una columna por técnico.
   *
   * "Sin agendar" son las órdenes ABIERTAS sin fecha, no todas las abiertas: las que
   * ya están puestas en otro día no vuelven a la bandeja, o la cajera las volvería a
   * repartir cada mañana sin saber que ya tenían dueño y día.
   */
  async tablero(user: AuthUser, fecha?: string) {
    const dia = this.diaDe(fecha);
    const mias = await this.sedesDelUsuario(user);
    const tecnicos = await this.columnas(mias, dia);
    const abiertas: Prisma.TicketWhereInput = { status: { in: ['PENDIENTE', 'REALIZANDO'] } };

    // La bandeja también respeta la sede: una cajera de Villanueva no reparte (ni
    // ve) las órdenes de Yopal. Las órdenes sin abonado no tienen sede: se muestran
    // a todos antes que dejarlas huérfanas de toda bandeja.
    const sinAgendarWhere: Prisma.TicketWhereInput = {
      ...abiertas,
      scheduledFor: null,
      ...(mias.length
        ? { OR: [{ subscriber: { branch: { legacyId: { in: mias } } } }, { subscriber: { is: null } }] }
        : {}),
    };

    // "Lo urgente y lo más viejo primero" DE VERDAD: `priority` es texto libre y
    // ordenarla en SQL da orden alfabético (Alta, Baja, Media, Urgente) — con el
    // tope de 200 eso llegaba a dejar las urgentes FUERA de la bandeja. Se traen
    // livianas todas, se ordenan por rango y solo entonces se corta.
    const candidatas = await this.prisma.ticket.findMany({
      where: sinAgendarWhere,
      select: { id: true, priority: true, created: true },
    });
    candidatas.sort(
      (a, b) =>
        rangoPrioridad(a.priority) - rangoPrioridad(b.priority) ||
        (a.created?.getTime() ?? 0) - (b.created?.getTime() ?? 0),
    );
    const idsBandeja = candidatas.slice(0, 200).map((c) => c.id);

    const [filasBandeja, agendadas] = await Promise.all([
      idsBandeja.length
        ? this.prisma.ticket.findMany({ where: { id: { in: idsBandeja } }, select: AgendaService.TARJETA })
        : [],
      this.prisma.ticket.findMany({
        where: { scheduledFor: dia },
        select: AgendaService.TARJETA,
        orderBy: [{ scheduledSeq: 'asc' }],
      }),
    ]);
    // `id IN (...)` no garantiza orden: se recompone el del rango.
    const bandejaPorId = new Map(filasBandeja.map((f) => [f.id, f]));
    const sinAgendar = idsBandeja.flatMap((id) => bandejaPorId.get(id) ?? []);

    const barrios = await this.barriosDe([...sinAgendar, ...agendadas]);
    const mapear = (fs: any[]) => Promise.all(fs.map((f) => this.tarjeta(f, barrios)));

    const porTecnico = new Map<string, any[]>();
    for (const t of agendadas) {
      if (!t.assignedStaffId) continue;
      const lista = porTecnico.get(t.assignedStaffId) ?? [];
      lista.push(t);
      porTecnico.set(t.assignedStaffId, lista);
    }

    return {
      fecha: dia.toISOString().slice(0, 10),
      hoy: hoyEnColombia().toISOString().slice(0, 10),
      sinAgendar: await mapear(sinAgendar),
      // Cuántas quedaron fuera del tope de 200: sin decirlo, la bandeja parece
      // completa y la cajera daría por repartido lo que no ha visto.
      sinAgendarTotal: candidatas.length,
      columnas: await Promise.all(
        tecnicos.map(async (t) => ({
          staffId: t.id,
          nombre: t.name,
          ordenes: await mapear(porTecnico.get(t.id) ?? []),
        })),
      ),
    };
  }

  /**
   * Mueve una orden dentro de la agenda: a la columna de un técnico en una posición,
   * o de vuelta a "sin agendar".
   *
   * Es UNA sola operación para todos los arrastres posibles (de la bandeja a un
   * técnico, entre técnicos, dentro de la misma columna, de vuelta a la bandeja)
   * porque el destino lo describe entero: quién, qué día y en qué puesto. Va en
   * transacción y renumera las columnas afectadas, que es lo que garantiza que dos
   * personas agendando a la vez no dejen la agenda con posiciones repetidas.
   */
  async mover(
    user: AuthUser,
    dto: { ticketId: string; staffId?: string | null; fecha?: string | null; posicion?: number },
  ) {
    if (esTecnicoDeCampo(user)) {
      throw new ForbiddenException('No puedes agendar órdenes: tú atiendes las que te agendan.');
    }
    const t = await this.prisma.ticket.findUnique({
      where: { id: dto.ticketId },
      select: { id: true, code: true, type: true, subscriberId: true, col: true, assignedStaffId: true, scheduledFor: true },
    });
    if (!t) throw new NotFoundException('Orden no encontrada');

    const desagendar = !dto.staffId || !dto.fecha;
    const destinoDia = desagendar ? null : this.diaDe(dto.fecha!);
    const staff = desagendar
      ? null
      : await this.prisma.staff.findUnique({ where: { id: dto.staffId! }, select: { id: true, name: true, username: true, banned: true } });
    if (!desagendar && (!staff || staff.banned)) {
      throw new BadRequestException('Ese técnico no existe o ya no trabaja aquí.');
    }

    // Columnas que hay que renumerar: la de origen (si estaba agendada) y la de
    // destino. Se guardan ANTES de tocar nada, porque el update las cambia.
    const origen = t.scheduledFor && t.assignedStaffId ? { dia: t.scheduledFor, staffId: t.assignedStaffId } : null;

    await this.prisma.$transaction(async (tx) => {
      if (desagendar) {
        await tx.ticket.update({
          where: { id: t.id },
          data: { scheduledFor: null, scheduledSeq: null, scheduledById: null, scheduledByName: null, scheduledAt: null },
        });
      } else {
        // Agendar ASIGNA (ver la cabecera). `assignedAt` sólo se sella si cambia de
        // técnico: reordenar su propia agenda no le reinicia el reloj.
        const cambiaDeTecnico = t.assignedStaffId !== staff!.id;
        await tx.ticket.update({
          where: { id: t.id },
          data: {
            scheduledFor: destinoDia,
            scheduledById: user.id,
            scheduledByName: user.name,
            scheduledAt: new Date(),
            assignedStaffId: staff!.id,
            assigned: staff!.name,
            ...(cambiaDeTecnico ? { assignedAt: new Date() } : {}),
            // Sin posición todavía: la pone `renumerar` de abajo insertándola donde
            // toca. Un número provisional aquí sería adivinar contra qué escala se
            // va a comparar, y ahí es donde se rompió la primera versión: "posición
            // 1" se escribía como 5 y la orden acababa tercera.
            scheduledSeq: null,
          },
        });
      }

      /**
       * Reescribe 1..N la columna (día + técnico). Si se pasa `meter`, la saca de la
       * lista y la vuelve a insertar en `enPos` — así "ponla de primera" es una
       * inserción de verdad y no una carrera entre números.
       */
      const renumerar = async (dia: Date, staffId: string, meter?: string, enPos?: number) => {
        const filas = await tx.ticket.findMany({
          where: { scheduledFor: dia, assignedStaffId: staffId, ...(meter ? { id: { not: meter } } : {}) },
          select: { id: true },
          orderBy: [{ scheduledSeq: 'asc' }, { created: 'asc' }],
        });
        const ids = filas.map((f) => f.id);
        if (meter) {
          const pos = Math.min(Math.max(1, enPos ?? ids.length + 1), ids.length + 1);
          ids.splice(pos - 1, 0, meter);
        }
        for (let i = 0; i < ids.length; i++) {
          await tx.ticket.update({ where: { id: ids[i] }, data: { scheduledSeq: i + 1 } });
        }
      };

      if (destinoDia && staff) await renumerar(destinoDia, staff.id, t.id, dto.posicion);
      if (origen && !(destinoDia && staff && origen.staffId === staff.id && origen.dia.getTime() === destinoDia.getTime())) {
        await renumerar(origen.dia, origen.staffId);
      }
    });

    // El aviso al cliente ("tu caso ya tiene técnico") sólo cuando de verdad cambia
    // de manos, y fuera de la transacción: notificar no puede tumbar el agendamiento.
    if (staff && t.assignedStaffId !== staff.id) {
      this.events.emit(TICKET_ASIGNADO_EVENT, {
        ticketId: t.id, code: t.code, type: t.type, subscriberId: t.subscriberId,
        tecnico: staff.name, abiertaPor: t.col,
      } satisfies TicketAsignadoEvent);
    }

    return { id: t.id, agendada: !desagendar, fecha: destinoDia?.toISOString().slice(0, 10) ?? null };
  }

  /**
   * La agenda del técnico logueado para un día: sus órdenes en el orden que le puso
   * la cajera. Sin parámetros de alcance a propósito — quién es lo dice la sesión.
   */
  async miAgenda(user: AuthUser, fecha?: string) {
    const dia = this.diaDe(fecha);
    const staff = await this.prisma.staff.findFirst({
      where: { banned: false, OR: [{ email: { equals: user.email, mode: 'insensitive' } }, { name: { equals: user.name, mode: 'insensitive' } }] },
      select: { id: true, name: true },
    });
    const vacia = { resolved: false, fecha: dia.toISOString().slice(0, 10), hoy: hoyEnColombia().toISOString().slice(0, 10), ordenes: [] as any[], proximas: 0 };
    if (!staff) return vacia;

    const [filas, proximas] = await Promise.all([
      this.prisma.ticket.findMany({
        where: { scheduledFor: dia, assignedStaffId: staff.id },
        select: AgendaService.TARJETA,
        orderBy: [{ scheduledSeq: 'asc' }],
      }),
      // Lo que ya le agendaron para días siguientes: se cuenta, no se lista. Saber
      // que mañana hay trabajo puesto es útil; adelantarlo hoy, no.
      this.prisma.ticket.count({ where: { assignedStaffId: staff.id, scheduledFor: { gt: dia }, status: { in: ['PENDIENTE', 'REALIZANDO'] } } }),
    ]);
    const barrios = await this.barriosDe(filas);
    return {
      resolved: true,
      fecha: dia.toISOString().slice(0, 10),
      hoy: hoyEnColombia().toISOString().slice(0, 10),
      tecnico: staff.name,
      ordenes: await Promise.all(filas.map((f) => this.tarjeta(f, barrios))),
      proximas,
    };
  }
}
