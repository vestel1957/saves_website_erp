import { PrismaService } from '../prisma/prisma.service';
import { SubscribersService } from './subscribers.service';
import { MikrotikService } from '../network/mikrotik.service';
import { FacturasService } from '../billing/facturas.service';
import { SupportWriteService } from '../support/support-write.service';
import { CreateSubscriberDto } from './dto/update-subscriber.dto';
import type { AuthUser } from '../auth/current-user.decorator';
import { num } from '../common/money';
import { TECNOLOGIA_FTTH } from './conexion-alta';
import { type AfiliacionCatalogo, catalogoAfiliaciones, resolverAfiliacion } from './afiliacion';
import { Logger } from '../core/logger';
import { buscarOrdenInstalacion, completarOrdenAdoptada, ordenInstalacionEnLegacy } from './instalacion-existente';

/** Lo que devuelve cada paso del alta: hecho / no hecho, y por qué. */
type PasoAlta<T> = { hecho: boolean; motivo?: string; resultado?: T };

/** Lo que hace falta de una instalación en espera para abrir su orden. */
const PENDIENTE_SELECT = {
  id: true, subscriberId: true, context: true, assigned: true, scheduledFor: true,
  // `createdAt` y el tid de la factura son lo que permite reconocer una orden que ya
  // abrió el sistema anterior por su cuenta — ver `instalacion-existente.ts`.
  createdAt: true,
  invoice: { select: { tid: true } },
} as const;

/**
 * Alta completa de un cliente: la fila del abonado NO es el alta.
 *
 * Hasta ahora `SubscribersService.create` escribía el `Subscriber` y se acababa
 * ahí. El resultado era un cliente que existía en la pantalla y en ningún otro
 * sitio: sin secret en el Mikrotik (nunca se llamaba a `provision`), sin
 * `SubscriberService` —o sea invisible para la corrida de facturación mensual,
 * que factura por los servicios contratados— y sin orden de instalación, así que
 * ningún técnico se enteraba de que había que ir. El perfil/velocidad además era
 * un texto libre que no salía del catálogo de planes, con lo que ni siquiera
 * había de dónde sacar el precio.
 *
 * Este servicio encadena los cuatro pasos en el orden que importa:
 *
 *   1. abonado          — `SubscribersService.create` (guardas de sede y de secret duplicado)
 *   2. planes           — `changePlans(pushRouter: false)`: deja el `SubscriberService`
 *                         (lo que factura el cron cada mes) y el `pppProfile` en la ficha
 *   3. Mikrotik         — `provision`: crea el `/ppp/secret` YA con ese perfil
 *   4. factura          — la de AFILIACIÓN: el producto «Afiliación …» del catálogo
 *                         (70.000 el combo), NO la mensualidad. Ver `afiliacion.ts`.
 *   5. instalación      — NO se abre la orden: queda PROGRAMADA (`PendingInstall`) y nace
 *                         sola cuando esa factura se paga (ver `alPagarAfiliacion`)
 *
 * El paso 5 es la regla del negocio: primero paga la afiliación, después va el técnico.
 * Antes la orden nacía en el acto y un cliente que no pagaba nunca igualmente aparecía
 * en la cola de instalaciones. Contrapartida a tener presente: si el cliente no paga, no
 * hay visita — y esa espera no caduca sola, la orden nace el día que entre el dinero
 * (por caja o por el legacy, ver `barrerInstalacionesPagadas`).
 *
 * Por qué 2 antes que 3: `applyProfile` edita un secret que en el alta todavía
 * no existe. Fijando primero el perfil en la ficha, `provision` lo crea bien de
 * una sola vez.
 *
 * Ningún paso posterior tumba al anterior: si el router no responde, el cliente
 * y su factura quedan bien y el alta lo reporta como paso fallido para que se
 * reintente desde la ficha. Lo contrario —abortar— dejaría el abonado a medias
 * y con el consecutivo quemado.
 */
export class AltaClienteService {
  private readonly logger = new Logger('AltaClienteService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscribers: SubscribersService,
    private readonly mikrotik: MikrotikService,
    private readonly facturas: FacturasService,
    private readonly soporte: SupportWriteService,
  ) {}

  async alta(dto: CreateSubscriberDto, user: AuthUser) {
    // 1) El abonado. Si esto revienta (sede ajena, secret repetido) no se ha
    // hecho nada más y el error sube tal cual a la pantalla de alta.
    const creado = await this.subscribers.create(dto, user);

    // El usuario PPPoE ya no viene del formulario: lo deriva `create` del propio
    // cliente. Se lee de ahí y no del dto, que en el alta llega sin él.
    const pppUsername = creado.pppUsername ?? dto.pppUsername?.trim() ?? null;

    const planes = await this.aplicarPlanes(creado.id, dto, user);
    const router = await this.provisionar(creado.id, dto, pppUsername, user);
    const factura = await this.primeraFactura(creado.id, dto, planes.resultado ?? [], user);
    const orden = await this.programarInstalacion(creado.id, dto, pppUsername, factura.resultado?.id ?? null, user);

    return { id: creado.id, abonado: creado.abonado, pppUsername, planes, router, factura, orden };
  }

  // ── 2) Planes contratados ────────────────────────────────────────

  /** Deja el `SubscriberService` (base de la facturación mensual) y el perfil PPP. */
  private async aplicarPlanes(
    subscriberId: string,
    dto: CreateSubscriberDto,
    user: AuthUser,
  ): Promise<PasoAlta<{ id: string; name: string; price: number; kind: string; taxRate: number }[]>> {
    const bundleId = dto.bundleId?.trim() || null;
    const ids = (dto.planIds ?? []).filter(Boolean);
    if (!bundleId && !ids.length) {
      return { hecho: false, motivo: 'No se eligió ningún plan: el cliente queda sin servicio que facturar.' };
    }
    try {
      // pushRouter: false — el secret aún no existe; lo crea `provisionar()` con
      // el perfil que este paso acaba de escribir en la ficha.
      if (bundleId) {
        await this.subscribers.applyBundle(subscriberId, bundleId, user, { pushRouter: false });
      } else {
        await this.subscribers.changePlans(subscriberId, ids, user, { pushRouter: false });
      }
      // Se lee el snapshot recién escrito en el abonado, NO el catálogo: es lo
      // que de verdad se le va a facturar. En un combo los dos no coinciden
      // (ahí está el descuento) y leer el catálogo le cobraría precio de lista
      // en su primera factura.
      const servicios = await this.prisma.subscriberService.findMany({
        where: { subscriberId },
        select: { planId: true, planName: true, price: true, kind: true, taxRate: true },
      });
      return {
        hecho: true,
        resultado: servicios.map((s) => ({
          id: s.planId ?? '', name: s.planName ?? s.kind, kind: s.kind,
          price: num(s.price), taxRate: num(s.taxRate),
        })),
      };
    } catch (e) {
      return { hecho: false, motivo: (e as Error).message };
    }
  }

  // ── 3) Alta en el Mikrotik ───────────────────────────────────────

  private async provisionar(
    subscriberId: string,
    dto: CreateSubscriberDto,
    pppUsername: string | null,
    user: AuthUser,
  ): Promise<PasoAlta<Awaited<ReturnType<MikrotikService['provision']>>>> {
    if (dto.provision === false) return { hecho: false, motivo: 'Alta en el router omitida a petición.' };
    if (!pppUsername?.trim()) {
      return { hecho: false, motivo: 'Sin usuario PPPoE no hay secret que crear en el router.' };
    }
    try {
      const res = await this.mikrotik.provision(subscriberId, user);
      // `provision` no lanza cuando el router no contesta: devuelve ok:false con
      // el motivo. Se propaga tal cual para que la pantalla lo pinte.
      return { hecho: res.ok, motivo: res.ok ? undefined : (res.error ?? res.message), resultado: res };
    } catch (e) {
      return { hecho: false, motivo: (e as Error).message };
    }
  }

  // ── 4) Factura de afiliación ─────────────────────────────────────

  /**
   * La AFILIACIÓN del cliente + el cargo de instalación si se cobra aparte.
   *
   * Es la factura que se emite sola al crear el cliente y la que, al pagarse, dispara
   * la orden de instalación (ver `programarInstalacion`).
   *
   * **NO lleva la mensualidad** (2026-08-29). Antes sí, y era el error: se emitía una
   * RECURRENTE con los planes contratados —76.900 de un combo 100 MEGAS + TV— cuando lo
   * que la empresa cobra al entrar son los 70.000 de la afiliación. La cajera recibía
   * esos 70.000 contra la factura de 76.900 y el cliente entraba debiendo 6.900 el mismo
   * día. El legacy nunca facturó la mensualidad en el alta: emite una FIJA con el
   * producto «Afiliación …» y la mensualidad arranca el 1º del mes siguiente.
   *
   * Aquí pasa lo mismo sin hacer nada más: el cliente nace INSTALAR y la corrida mensual
   * sólo factura ACTIVO/COMPROMISO, así que el mes en curso no se le cobra y el siguiente
   * entra por la corrida como a cualquiera. Ver `afiliacion.ts`.
   *
   * Sin nada que cobrar (afiliación en 0 y sin instalación) no se emite factura: quien
   * decide qué pasa entonces es `programarInstalacion`, que abre la orden en el acto en
   * vez de dejar al cliente esperando un pago que nunca va a llegar.
   */
  private async primeraFactura(
    subscriberId: string,
    dto: CreateSubscriberDto,
    planes: { name: string; price: number; taxRate: number; kind: string }[],
    user: AuthUser,
  ): Promise<PasoAlta<{ id: string; tid: number; total: number; afiliacion: string }>> {
    if (dto.firstInvoice === false) return { hecho: false, motivo: 'Factura de afiliación omitida a petición.' };

    let afiliacion: AfiliacionCatalogo | null = null;
    try {
      afiliacion = await resolverAfiliacion(this.prisma, {
        materialId: dto.affiliationId,
        precio: dto.affiliationPrice,
        servicios: planes.map((p) => p.kind),
      });
    } catch (e) {
      return { hecho: false, motivo: (e as Error).message };
    }
    if (!afiliacion) {
      return {
        hecho: false,
        motivo: dto.affiliationId
          ? 'La afiliación elegida no está en el catálogo.'
          : 'No se pudo deducir la afiliación: elige una del catálogo (o un plan de internet/TV).',
      };
    }

    const items: { description: string; productName: string; qty: number; price: number; taxRate: number }[] = [];
    if (afiliacion.price > 0) {
      items.push({
        description: afiliacion.name, productName: afiliacion.name,
        qty: 1, price: afiliacion.price, taxRate: afiliacion.taxRate,
      });
    }

    const instalacion = Number(dto.installCharge ?? 0);
    if (instalacion > 0) {
      items.push({ description: 'Instalacion', productName: 'Instalacion', qty: 1, price: instalacion, taxRate: 0 });
    }
    if (!items.length) {
      return { hecho: false, motivo: `Afiliación sin cobro (${afiliacion.name} en 0): no hay factura que emitir.` };
    }

    try {
      // FIJA, no RECURRENTE: es un cargo puntual, no la mensualidad del servicio. De
      // eso dependen el recibo de caja (que rotula el mes sólo en las recurrentes) y
      // el informe del cierre, que cuenta las afiliaciones en su propio renglón.
      const inv = await this.facturas.createInvoice(
        { subscriberId, kind: 'FIJA', items, notes: 'Factura de afiliación (alta del cliente).' },
        user,
      );
      return { hecho: true, resultado: { id: inv.id, tid: inv.tid, total: inv.total, afiliacion: afiliacion.name } };
    } catch (e) {
      return { hecho: false, motivo: (e as Error).message };
    }
  }

  /** Catálogo de afiliaciones para el asistente de alta (`GET /subscribers/afiliaciones`). */
  async afiliaciones() {
    return { items: await catalogoAfiliaciones(this.prisma) };
  }

  // ── 5) Instalación: se programa ahora, nace al pagar ─────────────

  /** Observación de la orden: lo que el técnico necesita saber para ir. */
  private contextoDeVisita(dto: CreateSubscriberDto, pppUsername: string | null): string {
    const direccion = [dto.addressLine, dto.neighborhood].map((s) => s?.trim()).filter(Boolean).join(' · ');
    return [
      direccion ? `Dirección: ${direccion}` : null,
      `Tecnología: ${dto.installTech || TECNOLOGIA_FTTH}`,
      pppUsername?.trim() ? `Usuario PPPoE: ${pppUsername.trim()}` : null,
      dto.phone1 ? `Celular: ${dto.phone1}` : null,
    ].filter(Boolean).join('\n');
  }

  /**
   * Deja la instalación EN ESPERA del pago de la factura de afiliación.
   *
   * No se abre ninguna orden aquí: se guarda `PendingInstall` con el contexto de la
   * visita, porque el día que entre el pago —puede ser semanas después, y por caja o
   * por el legacy— ya no habrá ninguna petición que traiga la dirección, la tecnología
   * ni el usuario PPPoE.
   *
   * Excepción deliberada: si NO hay factura de afiliación que pagar (se pidió omitirla,
   * o no había nada que cobrar), esperar un pago que nunca va a llegar dejaría al cliente
   * sin visita para siempre. En ese caso la orden se abre en el acto, como antes.
   */
  private async programarInstalacion(
    subscriberId: string,
    dto: CreateSubscriberDto,
    pppUsername: string | null,
    invoiceId: string | null,
    user: AuthUser,
  ): Promise<PasoAlta<{ id?: string; code?: number | null; esperandoPago: boolean; invoiceId?: string }>> {
    if (dto.installOrder === false) return { hecho: false, motivo: 'Orden de instalación omitida a petición.' };

    const contexto = this.contextoDeVisita(dto, pppUsername);
    const asignado = dto.installAssigned?.trim() || null;
    const agendada = dto.installScheduledFor || null;

    if (!invoiceId) {
      try {
        const t = await this.crearOrden({
          subscriberId, context: contexto, assigned: asignado, scheduledFor: agendada,
        }, user);
        return {
          hecho: true,
          motivo: 'Sin factura de afiliación que cobrar: la orden se abrió de una vez.',
          resultado: { id: t.id, code: t.code, esperandoPago: false },
        };
      } catch (e) {
        return { hecho: false, motivo: (e as Error).message };
      }
    }

    try {
      await this.prisma.pendingInstall.create({
        data: {
          subscriberId, invoiceId, context: contexto || null, assigned: asignado,
          scheduledFor: agendada ? new Date(agendada) : null,
        },
      });
      return { hecho: true, resultado: { esperandoPago: true, invoiceId } };
    } catch (e) {
      return { hecho: false, motivo: (e as Error).message };
    }
  }

  /**
   * Abre la orden de instalación propiamente dicha.
   *
   * Clase `servicio`, detalle `Instalacion` — el mismo par que usa el legacy y el que
   * reconoce la cascada de cierre (`applyCloseCascade`), que al resolverla reconecta en
   * el Mikrotik y deja al cliente ACTIVO.
   */
  private async crearOrden(
    pend: { subscriberId: string; context: string | null; assigned: string | null; scheduledFor: string | Date | null },
    user: AuthUser,
    invoiceTid?: number | null,
  ) {
    const t = await this.soporte.createTicket(
      {
        subscriberId: pend.subscriberId,
        subject: 'servicio',
        type: 'Instalacion',
        problem: 'Instalación de servicio nuevo',
        section: pend.context || undefined,
        assigned: pend.assigned || undefined,
        // Agendar exige técnico: una fecha sin dueño la rechaza `createTicket`, y aquí
        // eso tumbaría la creación entera de una orden que ya está pagada.
        scheduledFor: pend.assigned && pend.scheduledFor
          ? (typeof pend.scheduledFor === 'string' ? pend.scheduledFor : pend.scheduledFor.toISOString().slice(0, 10))
          : undefined,
      },
      user,
    );
    // Se ata a la factura de afiliación (`tickets.id_invoice` allá). No es adorno: es
    // la marca con la que el legacy comprueba que la instalación ya tiene orden, así
    // que sin ella volvería a abrir la suya en cuanto le entre un pago de este cliente.
    if (invoiceTid) {
      await this.prisma.ticket.update({ where: { id: t.id }, data: { invoiceLegacy: invoiceTid } });
    }
    return t;
  }

  // ── El disparo: se pagó la afiliación ────────────────────────────

  /**
   * Usuario con el que se firma una orden que abre el sistema, no una persona.
   *
   * `createTicket` necesita un `AuthUser` (escribe quién la creó en `Ticket.col` y
   * comprueba que quien la abre no sea un técnico de campo). El pago puede llegar por
   * caja, por el cargue de Excel o por el legacy: el denominador común es que la orden
   * no la pidió nadie a mano, la disparó el pago.
   */
  private usuarioSistema(): AuthUser {
    return { id: 'system', email: 'cron@vestel', name: 'Sistema (pago de afiliación)', roles: [], permissions: ['system.admin'] };
  }

  /**
   * Se registró un pago de este cliente: si con él quedó PAGADA su factura de
   * afiliación, se abre la orden de instalación.
   *
   * Lo llama la suscripción a `treasury.pago.aplicado` (ver `core/suscripciones.ts`),
   * así el técnico tiene la orden en el acto y no en la siguiente pasada del barrido.
   * Best-effort: nunca puede tumbar un recaudo que ya está hecho y contabilizado.
   */
  async alPagarAfiliacion(subscriberId: string): Promise<{ creadas: number; adoptadas: number }> {
    const pendientes = await this.prisma.pendingInstall.findMany({
      where: { subscriberId, fulfilledAt: null, invoice: { status: 'PAID' } },
      select: PENDIENTE_SELECT,
    });
    return this.abrirOrdenes(pendientes);
  }

  /**
   * Barrido de red de seguridad: TODAS las instalaciones cuya factura de afiliación ya
   * está pagada y siguen sin orden.
   *
   * Hace falta porque el evento sólo cubre lo que se recauda AQUÍ. Mientras los dos
   * sistemas convivan, buena parte de los pagos se registran en el legacy y llegan por
   * el sync (`legacy-sync-caja`, cada 20 s), que actualiza la factura sin pasar por
   * `CobranzasService.collect` y por tanto sin emitir ningún evento. Sin este barrido,
   * el cliente que paga en la ventanilla del legacy no tendría nunca su orden.
   *
   * También recoge los intentos que fallaron (`lastError`): se reintentan solos.
   */
  async barrerInstalacionesPagadas(): Promise<{ creadas: number; adoptadas: number }> {
    const pendientes = await this.prisma.pendingInstall.findMany({
      where: { fulfilledAt: null, invoice: { status: 'PAID' } },
      select: PENDIENTE_SELECT,
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return this.abrirOrdenes(pendientes);
  }

  /**
   * Abre la orden de cada instalación pendiente y la sella.
   *
   * Dos candados, contra dos duplicados distintos:
   *
   * 1. **contra nosotros mismos**: el `updateMany` condicionado a `fulfilledAt: null`
   *    ANTES de tocar nada. El evento del recaudo y el barrido pueden mirar el mismo
   *    pago a la vez, y sólo uno de los dos se lleva la fila.
   * 2. **contra el sistema anterior**: allá la orden la abre él solo al pagarse la
   *    afiliación —y por el PORTAL (PSE) se paga siempre allá—, así que antes de crear
   *    se mira si ya existe. Si existe se ADOPTA: se le añade el contexto de la visita
   *    y la instalación queda sellada apuntando a ESA orden. Ver `instalacion-existente.ts`.
   *
   * Si la creación falla, se suelta el sello y se guarda el motivo para reintentarlo.
   */
  private async abrirOrdenes(
    pendientes: {
      id: string; subscriberId: string; context: string | null; assigned: string | null;
      scheduledFor: Date | null; createdAt: Date; invoice?: { tid: number | null } | null;
    }[],
  ): Promise<{ creadas: number; adoptadas: number }> {
    let creadas = 0;
    let adoptadas = 0;
    for (const p of pendientes) {
      const tomada = await this.prisma.pendingInstall.updateMany({
        where: { id: p.id, fulfilledAt: null },
        data: { fulfilledAt: new Date(), lastError: null },
      });
      if (!tomada.count) continue; // se la llevó el otro camino

      const invoiceTid = p.invoice?.tid ?? null;
      try {
        // ¿La orden ya existe aquí? (nacida allá y traída por el sync, o abierta a mano)
        const existente = await buscarOrdenInstalacion(this.prisma, {
          subscriberId: p.subscriberId, invoiceTid, desde: p.createdAt,
        });
        if (existente) {
          await this.adoptarOrden(p, existente);
          adoptadas++;
          continue;
        }

        // ¿Y allá, aunque el sync todavía no la haya traído? El legacy abre la suya en
        // el instante del pago y la ida tarda hasta 15 minutos: sin esta pregunta, un
        // barrido que caiga en medio abre igual la segunda.
        if (invoiceTid) {
          const enLegacy = await ordenInstalacionEnLegacy(invoiceTid, this.logger);
          if (enLegacy.codigo) {
            // No se crea NI se da por hecha: se suelta el sello para que el próximo
            // barrido la adopte en cuanto el sync la traiga.
            await this.prisma.pendingInstall.update({
              where: { id: p.id },
              data: {
                fulfilledAt: null,
                lastError: `El sistema anterior ya abrió la orden #${enLegacy.codigo} para esta afiliación; se adopta cuando entre por el sync.`,
              },
            });
            this.logger.log(`[instalacion] la orden #${enLegacy.codigo} ya existe en el sistema anterior (cliente ${p.subscriberId}): no se abre otra`);
            continue;
          }
        }

        const t = await this.crearOrden(p, this.usuarioSistema(), invoiceTid);
        await this.prisma.pendingInstall.update({
          where: { id: p.id },
          data: { ticketId: t.id, ticketCode: t.code },
        });
        creadas++;
        this.logger.log(`[instalacion] orden #${t.code} abierta al pagarse la afiliación (cliente ${p.subscriberId})`);
      } catch (e) {
        // Se suelta el sello: la instalación vuelve a la cola del barrido.
        await this.prisma.pendingInstall.update({
          where: { id: p.id },
          data: { fulfilledAt: null, lastError: (e as Error).message.slice(0, 500) },
        });
        this.logger.error(`[instalacion] no se pudo abrir la orden del cliente ${p.subscriberId}: ${(e as Error).message}`);
      }
    }
    return { creadas, adoptadas };
  }

  /**
   * Da por buena la orden que ya existe y le pone lo que le falta.
   *
   * La instalación pendiente queda sellada apuntando a ESA orden —así la ficha del
   * cliente enseña la de verdad y el barrido no vuelve sobre ella— y a la orden se le
   * añade el contexto de la visita (dirección, tecnología, PPPoE, celular), que la que
   * abre el legacy no trae. `editedAt` es lo que hace que ese añadido sobreviva a la
   * ida y viaje de vuelta allá.
   */
  private async adoptarOrden(
    pend: { id: string; subscriberId: string; context: string | null; assigned: string | null },
    orden: { id: string; code: number | null; section: string | null; problem: string | null },
  ): Promise<void> {
    const cambios = completarOrdenAdoptada(orden, pend.context);
    if (Object.keys(cambios).length) {
      await this.prisma.ticket.update({
        where: { id: orden.id },
        data: { ...cambios, editedAt: new Date() },
      });
    }
    await this.prisma.pendingInstall.update({
      where: { id: pend.id },
      data: { ticketId: orden.id, ticketCode: orden.code },
    });
    const conTecnico = pend.assigned ? ` (ojo: el alta pedía técnico ${pend.assigned}, la orden adoptada no lo lleva)` : '';
    this.logger.log(`[instalacion] la orden #${orden.code} ya existía: se adopta en vez de abrir otra (cliente ${pend.subscriberId})${conTecnico}`);
  }
}
