import { PromotionsService } from './promotions.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { AuthUser } from '../auth/current-user.decorator';
import {
  ApplyPromotionDto,
  CreatePromotionDto,
  PromotionAudienceDto,
  UpdatePromotionDto,
} from './dto/promotions.dto';

/**
 * Administración de promociones: crear campañas y definir A QUÉ CLIENTES alcanzan.
 * Exclusivo del superusuario (system.admin), tal como lo pidió el negocio.
 */
export class PromotionsController {
  constructor(private readonly promos: PromotionsService) {}

  list() {
    return this.promos.list();
  }

  /** Catálogos para armar el público: planes, sedes y barrios. */
  catalogs() {
    return this.promos.catalogs();
  }

  /** Bitácora del público (qué destinatario entró o salió, por quién y cuándo). */
  history(promotionId?: string) {
    return this.promos.targetHistory(promotionId);
  }

  /** Plantillas guardadas: la forma de una campaña que se repite. */
  templates() {
    return this.promos.listTemplates();
  }

  /**
   * Borra una plantilla. Va ANTES que `@Delete(':id')`: Nest resuelve las rutas en
   * orden de declaración y si no, «templates» entraría como si fuera un id.
   */
  removeTemplate(id: string) {
    return this.promos.removeTemplate(id);
  }

  /**
   * Cuántos clientes alcanza un público, con una muestra. Se consulta en vivo
   * mientras se arma la promo, para ver a quién se le va a descontar ANTES de
   * guardarla.
   */
  audience(dto: PromotionAudienceDto) {
    return this.promos.audience(dto);
  }

  /**
   * Facturas pendientes de UN cliente, para elegir a mano a cuáles llega la promoción
   * cuando el público es ese cliente.
   */
  pendingInvoices(subscriberId?: string) {
    return this.promos.facturasPendientes(subscriberId);
  }

  /** Facturas a las que ya se les aplicó esta promoción. */
  applications(id: string) {
    return this.promos.applications(id);
  }

  create(dto: CreatePromotionDto, u?: AuthUser) {
    return this.promos.create(dto, u?.name ?? u?.email);
  }

  update(
    id: string,
    dto: UpdatePromotionDto,
    u?: AuthUser,
  ) {
    return this.promos.update(id, dto, u?.name ?? u?.email);
  }

  remove(id: string) {
    return this.promos.remove(id);
  }
}

/**
 * Uso en facturación: qué promociones vigentes alcanzan al cliente de una factura
 * y aplicarlas.
 *
 * El control real es el PÚBLICO de la promoción: el cliente de la factura tiene que
 * estar dentro (lo valida el servicio en cada aplicación). El área solo acota quién
 * trabaja con facturas —contabilidad y caja—: la cajera conserva las promociones a
 * propósito (decisión 2026-08-03), y ya no puede descontarle a quien no debía porque
 * la promo no aparece fuera de su público.
 */
export class MyPromotionsController {
  constructor(private readonly promos: PromotionsService) {}

  /** Promociones vigentes aplicables a esta factura (según su cliente). */
  available(invoiceId?: string) {
    return this.promos.available(invoiceId);
  }

  /** Aplica la promoción a una factura (genera nota crédito). */
  apply(
    id: string,
    dto: ApplyPromotionDto,
    u: AuthUser,
  ) {
    return this.promos.apply(id, dto, u);
  }
}
