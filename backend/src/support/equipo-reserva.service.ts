import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';

/**
 * EquipoReservaService — la unidad que se aparta de la bodega AL ABRIR la orden.
 *
 * La regla la puso el usuario (2026-09-03): cuando nace una orden de instalación,
 * cambio de equipo, migración, agregar internet o traslado, el sistema mira si el
 * cliente tiene equipo y le deja uno de los disponibles de la bodega de su sede.
 * El objetivo es que, cuando el técnico vaya a autenticar la ONU, sea "el equipo
 * que el cliente tiene asignado" —la única regla del automático que no depende de
 * la hora ni del ruido del autofind (ver `OnuProvisionService.decidirAutomatico`).
 *
 * Lo que se decidió distinto de la petición literal, y por qué:
 *
 * - **El equipo viejo NO se quita al abrir la orden**, se quita al autenticar el
 *   nuevo. Físicamente sigue en casa del cliente hasta que el técnico va; si la
 *   orden se anula, el cliente aparecería sin equipo y su ONU seguiría dando
 *   servicio. Ver `conciliarTrasAutenticar`.
 * - **La reserva no es una verdad, es una apuesta**: el sistema elige una caja en
 *   el papel antes de que el técnico elija una en el estante. Si coincide, la
 *   autenticación es automática sin más. Si el técnico se lleva otra, la
 *   autenticación lo descubre (esa otra es la que se anuncia) y la reserva se
 *   devuelve a la bodega sola. Nunca se da por instalado lo que no se vio en la OLT.
 * - Se prefieren unidades **con serial real** (son las únicas que la OLT puede
 *   reconocer como "suyas"), pero se salta cualquiera cuyo serial ya esté
 *   autenticado en alguna OLT: el inventario tiene 439 unidades "en bodega" que
 *   en realidad están dando servicio en una casa, y reservarlas manda al técnico a
 *   buscar una caja que no está.
 *
 * Las órdenes que nacen en el legacy no pasan por aquí (no disparan el evento).
 */

/** Tipos de orden que apartan equipo al abrirse (fragmentos, como `modoDeOrden`). */
const TIPOS_CON_RESERVA = ['instalac', 'cambio de equipo', 'migraci', 'agregarinternet', 'agregar internet', 'traslado'];

/** Estado con el que la unidad queda a nombre del cliente mientras no se confirme. */
export const ESTADO_RESERVADO = 'Reservado';

/**
 * Estado con el que vuelve a bodega el equipo VIEJO de un cambio de equipo. No es
 * "Bueno" ni "Malo" a propósito: el sistema no sabe por qué se cambió, y con
 * "Bueno" la unidad volvería a repartirse esa misma tarde. Que la mire alguien.
 */
export const ESTADO_POR_REVISAR = 'Por revisar';

/** ¿Una orden de este tipo aparta equipo al abrirse? */
export function tipoConReserva(type: string | null | undefined): boolean {
  const t = (type ?? '').toLowerCase();
  return !!t.trim() && TIPOS_CON_RESERVA.some((k) => t.includes(k));
}

/**
 * Serial que la OLT podría reconocer como ONU.
 *
 * NO vale "16 hex": las etiquetas de los puentes EoC (`BA1305-1704003199`) también
 * dan 16 hex al quitarles el guion, y con eso un decodificador pasaría por ONU
 * vieja en un cambio de equipo. En un SN GPON los 4 primeros bytes son el
 * fabricante en ASCII (`HWTC`, `ZTEG`, `GPON`, `DC71`…): letra A-Z (0x41-0x5A) o
 * dígito (0x30-0x39). `BA 13 05 17` no lo es. La otra forma es la etiqueta ya en
 * texto: 4 letras + 8 hex. Misma regla en SQL, abajo.
 */
const SN_UTIL = /^((4[1-9A-F]|5[0-9A]|3[0-9]){4}[0-9A-F]{8}|[A-Z]{4}[0-9A-F]{8})$/;
const SN_UTIL_SQL = '^((4[1-9A-F]|5[0-9A]|3[0-9]){4}[0-9A-F]{8}|[A-Z]{4}[0-9A-F]{8})$';
const norma = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export class EquipoReservaService {
  private readonly logger = new Logger(EquipoReservaService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aparta una unidad para la orden recién abierta. Idempotente: si la orden ya
   * tiene su reserva, no hace nada. Nunca lanza — se llama desde un evento y un
   * fallo aquí no puede estorbar a la creación de la orden.
   */
  async reservarParaOrden(ticketId: string): Promise<{ hecho: boolean; motivo: string; equipo?: { code: number; serial: string | null; bodega: string | null } }> {
    try {
      const t = await this.prisma.ticket.findUnique({
        where: { id: ticketId },
        select: {
          id: true, code: true, type: true, status: true, subscriberId: true,
          subscriber: { select: { id: true, branch: { select: { name: true, legacyId: true } } } },
        },
      });
      if (!t) return { hecho: false, motivo: 'La orden no existe.' };
      if (!tipoConReserva(t.type)) return { hecho: false, motivo: `Las órdenes de tipo "${t.type}" no apartan equipo.` };
      if (t.status !== 'PENDIENTE' && t.status !== 'REALIZANDO') return { hecho: false, motivo: 'La orden no está abierta.' };
      if (!t.subscriberId || !t.subscriber) return { hecho: false, motivo: 'La orden no tiene cliente.' };
      const sede = t.subscriber.branch?.legacyId ?? null;
      if (sede == null) return { hecho: false, motivo: 'El cliente no tiene sede: no se sabe de qué bodega apartar.' };

      const yaReservado = await this.prisma.equipment.findFirst({
        where: { reservedTicketId: t.id },
        select: { code: true, serial: true, warehouse: { select: { name: true } } },
      });
      if (yaReservado) {
        return { hecho: false, motivo: 'La orden ya tiene equipo reservado.', equipo: { code: yaReservado.code, serial: yaReservado.serial, bodega: yaReservado.warehouse?.name ?? null } };
      }

      const unidad = await this.elegirDeBodega(sede);
      if (!unidad) {
        await this.anotar(t.code, t.subscriberId,
          `No se pudo apartar equipo para esta orden: la bodega de ${t.subscriber.branch?.name ?? 'la sede'} no tiene unidades disponibles.`);
        return { hecho: false, motivo: 'Sin unidades disponibles en la bodega de la sede.' };
      }

      // Condicionado a que siga libre: dos órdenes abiertas a la vez en la misma
      // sede pueden elegir la misma unidad, y la segunda no se la quita a la primera.
      const { count } = await this.prisma.equipment.updateMany({
        where: { id: unidad.id, subscriberId: null, reservedTicketId: null },
        data: {
          subscriberId: t.subscriberId,
          reservedTicketId: t.id,
          status: ESTADO_RESERVADO,
          returnedAt: null,
          // Se queda en su bodega (`warehouseId`): físicamente sigue en el estante
          // hasta que el técnico pase por ella. Lo que la saca del stock repartible
          // es el `subscriberId`, que es lo que miran todos los filtros de "libre".
          editedAt: new Date(), // que la sincronización con el legacy no lo deshaga
        },
      });
      if (!count) {
        this.logger.warn(`Reserva para la orden ${t.code}: la unidad ${unidad.code} se la llevó otra orden a la vez; se reintenta.`);
        return this.reservarParaOrden(ticketId);
      }
      await this.anotar(t.code, t.subscriberId,
        `Equipo ${unidad.code} reservado para esta orden (bodega ${unidad.bodega ?? '—'}`
        + `${unidad.serial && SN_UTIL.test(norma(unidad.serial)) ? ` · S/N ${unidad.serial}` : ' · sin serial en el inventario'}). `
        + 'Es el que debe llevarse el técnico: si instala ese, la ONU se autentica sola.');
      return { hecho: true, motivo: '', equipo: { code: unidad.code, serial: unidad.serial, bodega: unidad.bodega } };
    } catch (e) {
      this.logger.error(`No se pudo reservar equipo para la orden ${ticketId}: ${(e as Error).message}`);
      return { hecho: false, motivo: (e as Error).message };
    }
  }

  /**
   * La unidad que se aparta: libre, en buen estado, de una bodega de la sede.
   *
   * Primero las que tienen serial real y que NINGUNA OLT tiene autenticado (esas
   * son las que la autenticación puede reconocer como "el equipo del cliente");
   * después las de serial sin poner ("solicitar"), que sirven para descontar stock
   * y reciben el serial de verdad al autenticar. Dentro de cada grupo, la de
   * código MÁS ALTO —la que entró más recientemente—: el inventario arrastra
   * unidades de hace años que figuran "disponibles" y ya no están en ningún
   * estante (código 1004 en Villanueva, por ejemplo). Rotar el stock estaría bien
   * si el stock fuera verdad; mientras no lo sea, la que llegó ayer es la que con
   * más seguridad puede llevarse el técnico.
   */
  private async elegirDeBodega(branchLegacy: number) {
    const filas = await this.prisma.$queryRaw<{ id: string; code: number; serial: string | null; bodega: string | null }[]>`
      SELECT e.id, e.code, e.serial, w.name AS bodega
        FROM "Equipment" e
        JOIN "EquipmentWarehouse" w ON w.id = e."warehouseId"
       WHERE e."subscriberId" IS NULL AND e."reservedTicketId" IS NULL
         AND w."branchLegacy" = ${branchLegacy}
         AND upper(coalesce(e.status, '')) IN ('BUENO', 'DISPONIBLE')
         AND (
           upper(regexp_replace(coalesce(e.serial, ''), '[^A-Za-z0-9]', '', 'g')) ~ ${SN_UTIL_SQL}
           OR e.serial ~* '(solicit|asignar|pendient)' OR coalesce(btrim(e.serial), '') = ''
         )
         AND NOT EXISTS (
           SELECT 1 FROM "OltOnu" o
            WHERE upper(o.sn) = upper(regexp_replace(coalesce(e.serial, ''), '[^A-Za-z0-9]', '', 'g'))
         )
       ORDER BY (CASE WHEN upper(regexp_replace(coalesce(e.serial, ''), '[^A-Za-z0-9]', '', 'g')) ~ ${SN_UTIL_SQL} THEN 0 ELSE 1 END),
                e.code DESC
       LIMIT 1`;
    return filas[0] ?? null;
  }

  /**
   * La orden se cerró o se anuló SIN que la autenticación confirmara el equipo:
   * la reserva vuelve a la bodega. Se prefiere soltar a dar por instalado —si el
   * técnico sí lo montó, que lo asigne desde la orden, que es un clic; lo que no
   * se puede es inventar a escala un equipo en cada casa.
   */
  async liberarPorCierre(ticketId: string, motivo: 'RESUELTO' | 'ANULADA'): Promise<number> {
    try {
      const reservados = await this.prisma.equipment.findMany({
        where: { reservedTicketId: ticketId, status: ESTADO_RESERVADO },
        select: { id: true, code: true, subscriberId: true },
      });
      if (!reservados.length) return 0;
      const t = await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { code: true, subscriberId: true } });
      const { count } = await this.prisma.equipment.updateMany({
        where: { id: { in: reservados.map((r) => r.id) } },
        data: { subscriberId: null, reservedTicketId: null, status: 'Disponible', editedAt: new Date() },
      });
      await this.anotar(t?.code ?? null, t?.subscriberId ?? null,
        `Reserva liberada: el equipo ${reservados.map((r) => r.code).join(', ')} vuelve a la bodega porque la orden se `
        + `${motivo === 'ANULADA' ? 'anuló' : 'cerró sin autenticar la ONU desde aquí'}. `
        + (motivo === 'RESUELTO' ? 'Si el técnico sí lo instaló, asígnelo desde la orden.' : ''));
      return count;
    } catch (e) {
      this.logger.error(`No se pudo liberar la reserva de la orden ${ticketId}: ${(e as Error).message}`);
      return 0;
    }
  }

  /**
   * La ONU se autenticó desde la orden: se cuadra el inventario con lo que la OLT
   * demostró. `instaladoId` es el equipo que quedó a nombre del cliente (puede ser
   * el reservado, uno que ya tenía, o uno tomado del stock; o null si no se
   * registró ninguno).
   *
   * - Reservas de esta orden que NO son el instalado → vuelven a la bodega (el
   *   técnico se llevó otra caja).
   * - En un CAMBIO DE EQUIPO, la ONU vieja → a la bodega como "Por revisar". Solo
   *   si se puede señalar sin dudar: el equipo con serial de ONU que el cliente
   *   tenía antes y que no es el nuevo. Con dos candidatos o ninguno, se anota y
   *   no se toca nada — un decodificador de TV no es una ONU vieja.
   */
  async conciliarTrasAutenticar(x: {
    ticketId: string; ticketCode: number | null; ticketType: string | null;
    subscriberId: string; instaladoId: string | null; sn: string;
  }): Promise<{ liberados: number[]; devuelto: number | null }> {
    const out = { liberados: [] as number[], devuelto: null as number | null };
    try {
      // 1. Reservas que no se usaron.
      const sobrantes = await this.prisma.equipment.findMany({
        where: { reservedTicketId: x.ticketId, status: ESTADO_RESERVADO, ...(x.instaladoId ? { id: { not: x.instaladoId } } : {}) },
        select: { id: true, code: true },
      });
      if (sobrantes.length) {
        await this.prisma.equipment.updateMany({
          where: { id: { in: sobrantes.map((s) => s.id) } },
          data: { subscriberId: null, reservedTicketId: null, status: 'Disponible', editedAt: new Date() },
        });
        out.liberados = sobrantes.map((s) => s.code);
        await this.anotar(x.ticketCode, x.subscriberId,
          `El técnico instaló otra ONU (S/N ${x.sn}): el equipo reservado ${out.liberados.join(', ')} vuelve a la bodega.`);
      }
      // El instalado deja de ser "reserva" si lo era.
      if (x.instaladoId) {
        await this.prisma.equipment.updateMany({ where: { id: x.instaladoId, reservedTicketId: { not: null } }, data: { reservedTicketId: null } });
      }

      // 2. La ONU vieja de un cambio de equipo.
      if (!/cambio de equipo/i.test(x.ticketType ?? '')) return out;
      const otros = await this.prisma.equipment.findMany({
        where: { subscriberId: x.subscriberId, reservedTicketId: null, ...(x.instaladoId ? { id: { not: x.instaladoId } } : {}) },
        select: { id: true, code: true, serial: true, warehouseLegacy: true, warehouse: { select: { branchLegacy: true } } },
      });
      const viejas = otros.filter((e) => SN_UTIL.test(norma(e.serial)) && norma(e.serial) !== norma(x.sn));
      if (viejas.length !== 1) {
        if (otros.length) {
          await this.anotar(x.ticketCode, x.subscriberId,
            viejas.length
              ? `Cambio de equipo: el cliente tiene ${viejas.length} ONUs anteriores (${viejas.map((v) => v.code).join(', ')}) y no se sabe cuál se retiró. Devuélvala desde su ficha.`
              : 'Cambio de equipo: no se reconoce cuál de sus equipos anteriores es la ONU retirada (ninguno tiene serial de ONU). Devuélvala desde su ficha.');
        }
        return out;
      }
      const vieja = viejas[0];
      const sub = await this.prisma.subscriber.findUnique({ where: { id: x.subscriberId }, select: { branch: { select: { legacyId: true } } } });
      const bodega = await this.bodegaDeSede(sub?.branch?.legacyId ?? null);
      await this.prisma.equipment.update({
        where: { id: vieja.id },
        data: {
          subscriberId: null, assignedRaw: null, installType: null, port: null, vlan: null, nat: null,
          status: ESTADO_POR_REVISAR,
          observation: `Retirada en cambio de equipo · orden #${x.ticketCode ?? '—'} · reemplazada por S/N ${x.sn}`,
          returnedAt: new Date(),
          warehouseId: bodega?.id ?? null, warehouseLegacy: bodega?.legacyId ?? vieja.warehouseLegacy,
          editedAt: new Date(),
        },
      });
      out.devuelto = vieja.code;
      await this.anotar(x.ticketCode, x.subscriberId,
        `ONU anterior ${vieja.code} (S/N ${vieja.serial}) devuelta a la bodega ${bodega?.name ?? '—'} como "${ESTADO_POR_REVISAR}".`);
      return out;
    } catch (e) {
      this.logger.warn(`Conciliación de equipo tras autenticar (orden ${x.ticketCode}): ${(e as Error).message}`);
      return out;
    }
  }

  /** Bodega principal de la sede: la que se llama como ella, o la primera que tenga. */
  private async bodegaDeSede(branchLegacy: number | null) {
    if (branchLegacy == null) return null;
    const branch = await this.prisma.branch.findUnique({ where: { legacyId: branchLegacy }, select: { name: true } });
    const todas = await this.prisma.equipmentWarehouse.findMany({
      where: { branchLegacy },
      select: { id: true, name: true, legacyId: true },
      orderBy: { name: 'asc' },
    });
    const n = (s: string) => s.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    return todas.find((w) => branch && n(w.name) === n(branch.name)) ?? todas[0] ?? null;
  }

  private async anotar(ticketCode: number | null, subscriberId: string | null, message: string) {
    if (ticketCode == null) return;
    await this.prisma.ticketThread
      .create({ data: { ticketCode, message, subscriberId, employeeId: 0, date: new Date() } })
      .catch(() => undefined);
  }
}
