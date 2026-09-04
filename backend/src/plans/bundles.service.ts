import { BadRequestException, NotFoundException } from '../core/http/errores';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBundleDto, UpdateBundleDto } from './dto/bundle.dto';
import { num, round2 } from '../common/money';
import {
  PLAYHUB_CATALOG,
  esAppElegible,
  playhubAreaLabel,
  playhubProductName,
  playhubSelectableApps,
} from '../playhub/playhub.client';

/** Un combo tal como lo pinta la pantalla (con su total y su ahorro ya calculados). */
type BundleSalida = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  items: {
    planId: string;
    planName: string;
    kind: string;
    /** Precio dentro del combo. */
    price: number;
    /** Precio del plan suelto, para enseñar contra qué se compara. */
    listPrice: number;
    taxRate: number;
    megas: number | null;
    /** El plan que compone el combo está oculto del catálogo. */
    planActive: boolean;
  }[];
  /**
   * Apps que el cliente puede elegir con este combo. El código es lo que manda
   * (viaja a la API de PlayHub); el nombre y el área se resuelven al vuelo para
   * que la pantalla no tenga que cargar el catálogo entero.
   */
  apps: { code: string; name: string; area: string }[];
  total: number;
  listTotal: number;
  savings: number;
  /** Abonados que hoy tienen este combo. */
  subscribers: number;
  /** Combo que no se puede ofrecer porque alguno de sus planes está oculto. */
  blocked: boolean;
};

/**
 * Combos comerciales: paquetes de planes que se venden juntos a precio propio.
 *
 * El combo NO factura: al aplicarlo se copian sus precios a los servicios del
 * abonado (`SubscriberService`) y a partir de ahí la corrida mensual hace lo de
 * siempre, una línea por servicio con su IVA. Cambiar el precio de un combo no
 * reprecia a quien ya lo tiene, exactamente igual que con los planes sueltos.
 */
export class BundlesService {
  constructor(private readonly prisma: PrismaService) {}

  private static readonly INCLUDE = {
    items: { include: { plan: true } },
    _count: { select: { services: true } },
  } as const;

  /** Da forma de salida + calcula total y ahorro contra el precio de lista. */
  private presentar(b: Prisma.PlanBundleGetPayload<{ include: typeof BundlesService.INCLUDE }>): BundleSalida {
    const items = b.items.map((it) => ({
      planId: it.planId,
      planName: it.plan.name,
      kind: it.kind as string,
      price: num(it.price),
      listPrice: num(it.plan.price),
      taxRate: num(it.plan.taxRate),
      megas: it.plan.megas,
      planActive: it.plan.active,
    }));
    const total = round2(items.reduce((s, i) => s + i.price, 0));
    const listTotal = round2(items.reduce((s, i) => s + i.listPrice, 0));
    return {
      id: b.id,
      name: b.name,
      description: b.description,
      active: b.active,
      items,
      apps: b.allowedApps.map((code) => ({
        code,
        name: playhubProductName(code),
        area: playhubAreaLabel(code),
      })),
      total,
      listTotal,
      savings: round2(listTotal - total),
      // Cuenta servicios, no abonados: un combo de 2 planes deja 2 filas por
      // cliente, así que se divide entre las piezas para no inflar el número.
      subscribers: items.length ? Math.round(b._count.services / items.length) : 0,
      blocked: items.some((i) => !i.planActive),
    };
  }

  /**
   * Listado de combos. `activeOnly=true` para los desplegables de venta, que
   * además descartan los que arrastran un plan oculto: ofrecer un combo cuyo
   * plan ya no se vende termina en un error al aplicarlo.
   */
  async list(params: { activeOnly?: boolean } = {}): Promise<BundleSalida[]> {
    const rows = await this.prisma.planBundle.findMany({
      where: params.activeOnly ? { active: true } : {},
      orderBy: { name: 'asc' },
      include: BundlesService.INCLUDE,
    });
    const salida = rows.map((b) => this.presentar(b));
    return params.activeOnly ? salida.filter((b) => !b.blocked) : salida;
  }

  /**
   * Valida las piezas del combo y las deja listas para guardar.
   * Se comprueba contra el catálogo: los precios no se aceptan a ciegas.
   */
  private async prepararItems(items: { planId: string; price: number }[]) {
    const ids = items.map((i) => i.planId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('El combo trae el mismo plan dos veces.');
    }
    const planes = await this.prisma.plan.findMany({
      where: { id: { in: ids } },
      select: { id: true, kind: true, name: true, active: true },
    });
    if (planes.length !== ids.length) throw new NotFoundException('Uno o más planes no existen.');

    const porKind = new Map<string, string>();
    for (const p of planes) {
      if (porKind.has(p.kind)) {
        throw new BadRequestException(
          `El combo lleva dos planes de ${p.kind}: solo puede llevar uno de cada tipo de servicio.`,
        );
      }
      porKind.set(p.kind, p.name);
    }
    const oculto = planes.find((p) => !p.active);
    if (oculto) {
      throw new BadRequestException(`El plan “${oculto.name}” está oculto; muéstralo antes de meterlo en un combo.`);
    }

    const byId = new Map(planes.map((p) => [p.id, p]));
    return items.map((i) => ({
      planId: i.planId,
      kind: byId.get(i.planId)!.kind,
      price: round2(i.price),
    }));
  }

  /**
   * Catálogo de apps que se pueden ofrecer en un combo, para el selector.
   *
   * Sale del catálogo de PlayHub y no de una tabla propia a propósito: el código
   * que se guarde aquí es el mismo que después viaja a su API, así que no puede
   * haber una lista paralela que se desincronice.
   */
  appsCatalogo() {
    return playhubSelectableApps();
  }

  /**
   * Deja la lista de apps lista para guardar: sin repetidos, en el orden del
   * catálogo, y comprobando que cada código exista y sea una app de verdad.
   */
  private prepararApps(codes: string[]): string[] {
    const limpios = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
    const desconocido = limpios.find((c) => !PLAYHUB_CATALOG[c]);
    if (desconocido) {
      throw new BadRequestException(`La aplicación “${desconocido}” no está en el catálogo de PlayHub.`);
    }
    // Un Q0x/P0x/S0x/U0x no es una app sino el CUPO para elegirlas: si se cuela
    // aquí, la pantalla ofrecería "02 Servicios a elegir" como si fuera un app.
    const cupo = limpios.find((c) => !esAppElegible(c));
    if (cupo) {
      throw new BadRequestException(
        `“${playhubProductName(cupo)}” es un cupo de servicios a elegir, no una aplicación.`,
      );
    }
    const orden = playhubSelectableApps().map((a) => a.code);
    return limpios.sort((a, b) => orden.indexOf(a) - orden.indexOf(b));
  }

  async create(dto: CreateBundleDto) {
    const items = await this.prepararItems(dto.items);
    const b = await this.prisma.planBundle.create({
      data: {
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        active: dto.active ?? true,
        allowedApps: this.prepararApps(dto.allowedApps ?? []),
        items: { create: items },
      },
      select: { id: true },
    });
    return { id: b.id };
  }

  async update(id: string, dto: UpdateBundleDto) {
    const actual = await this.prisma.planBundle.findUnique({ where: { id }, select: { id: true } });
    if (!actual) throw new NotFoundException('Combo no encontrado');

    const data: Prisma.PlanBundleUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description.trim() || null;
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.allowedApps !== undefined) data.allowedApps = this.prepararApps(dto.allowedApps);

    // Las piezas se reemplazan enteras: el formulario manda el combo completo y
    // casar altas/bajas/cambios pieza a pieza no compra nada aquí.
    if (dto.items !== undefined) {
      const items = await this.prepararItems(dto.items);
      data.items = { deleteMany: {}, create: items };
    }

    await this.prisma.planBundle.update({ where: { id }, data });
    return { id, updated: true };
  }

  /**
   * Borra el combo; si hay abonados que lo tienen, lo oculta en vez de borrarlo
   * (mismo criterio que un plan en uso). El vínculo del abonado no se rompe:
   * su precio ya está copiado en el servicio y se le sigue facturando igual.
   */
  async remove(id: string) {
    const usado = await this.prisma.subscriberService.count({ where: { bundleId: id } });
    if (usado > 0) {
      await this.prisma.planBundle.update({ where: { id }, data: { active: false } });
      return {
        id, deleted: false, deactivated: true,
        reason: 'Hay abonados con este combo; se ocultó en vez de borrarlo.',
      };
    }
    await this.prisma.planBundle.delete({ where: { id } }).catch(() => {
      throw new BadRequestException('No se pudo eliminar el combo.');
    });
    return { id, deleted: true };
  }
}
