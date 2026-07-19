import { Injectable } from '@nestjs/common';
import { InventoryAlertType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Alertas de stock para la campana del TopNav.
 *
 * El motor recorre los materiales con umbral de alerta configurado (`alert > 0`)
 * y levanta una notificación por material y día. La idempotencia la da
 * `dedupeKey`: el frontend dispara `run` una vez por sesión, así que sin la
 * clave se acumularían filas duplicadas en cada login.
 */
@Injectable()
export class InventoryAlertsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ventana de deduplicación: una alerta por material y día calendario. */
  private dedupeKey(type: InventoryAlertType, materialId: string, day: string) {
    return `${type}:${materialId}:${day}`;
  }

  /**
   * Explora el inventario y crea las alertas que falten. Idempotente: repetirlo
   * el mismo día no duplica ni resucita alertas ya leídas.
   */
  async run() {
    const day = new Date().toISOString().slice(0, 10);
    const materials = await this.prisma.material.findMany({
      where: { alert: { gt: 0 } },
      select: { id: true, name: true, code: true, qty: true, alert: true, warehouseId: true, warehouse: { select: { title: true } } },
    });

    let created = 0;
    for (const m of materials) {
      const alert = m.alert ?? 0;
      if (m.qty > alert) continue; // por encima del umbral: nada que reportar
      const type: InventoryAlertType = m.qty <= 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK';
      const where = m.warehouse?.title ? ` en ${m.warehouse.title}` : '';
      const res = await this.prisma.inventoryNotification.createMany({
        data: [{
          type,
          title: m.qty <= 0 ? `Agotado: ${m.name}` : `Stock bajo: ${m.name}`,
          message: m.qty <= 0
            ? `${m.name}${m.code ? ` (${m.code})` : ''} está agotado${where}.`
            : `${m.name}${m.code ? ` (${m.code})` : ''} tiene ${m.qty} unidad(es)${where}, en o por debajo del mínimo de ${alert}.`,
          productId: m.id,
          warehouseId: m.warehouseId,
          entityType: 'material',
          entityId: m.id,
          dedupeKey: this.dedupeKey(type, m.id, day),
        }],
        skipDuplicates: true, // choca contra dedupeKey si ya se levantó hoy
      });
      created += res.count;
    }
    return { scanned: materials.length, created };
  }

  /** Alertas vigentes para la campana (las descartadas no vuelven a aparecer). */
  list() {
    return this.prisma.inventoryNotification.findMany({
      where: { status: { in: ['PENDIENTE', 'LEIDA'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, type: true, title: true, message: true, status: true, createdAt: true },
    });
  }

  async readAll() {
    const res = await this.prisma.inventoryNotification.updateMany({
      where: { status: 'PENDIENTE' },
      data: { status: 'LEIDA', readAt: new Date() },
    });
    return { updated: res.count };
  }
}
