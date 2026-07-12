/**
 * Limpieza de datos TRANSACCIONALES de inventario, para dejar la base lista para
 * producción. PRESERVA el catálogo (productos, categorías, marcas, unidades,
 * bodegas, ubicaciones, áreas) y los usuarios/roles/permisos.
 *
 * Borra: movimientos, kardex, existencias, series, OC/recepciones,
 * ajustes, reglas de reorden, alertas, mantenimientos y órdenes de trabajo.
 * Además pone en 0 los costos de los productos.
 *
 * ⚠️  DESTRUCTIVO e IRREVERSIBLE. Haz un backup antes (scripts/backup-db.sh).
 *
 * Uso:  CONFIRM_RESET=YES npx ts-node prisma/reset-inventory-data.ts
 *       (sin la variable, solo muestra qué borraría — dry run)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CONFIRM = process.env.CONFIRM_RESET === 'YES';

async function main() {
  console.log(CONFIRM ? '🧹 LIMPIANDO datos transaccionales de inventario…\n' : '🔎 DRY RUN (define CONFIRM_RESET=YES para ejecutar)\n');

  // Conteos antes (para reportar). Orden de borrado respeta llaves foráneas:
  // primero hijos, luego cabeceras.
  const steps: { label: string; del: () => Promise<{ count: number }>; count: () => Promise<number> }[] = [
    { label: 'Alertas de inventario', del: () => prisma.inventoryNotification.deleteMany(), count: () => prisma.inventoryNotification.count() },
    { label: 'Partes de mantenimiento', del: () => prisma.maintenancePart.deleteMany(), count: () => prisma.maintenancePart.count() },
    { label: 'Partes de órdenes de trabajo', del: () => prisma.workOrderPart.deleteMany(), count: () => prisma.workOrderPart.count() },
    { label: 'Tareas de órdenes de trabajo', del: () => prisma.workOrderTask.deleteMany(), count: () => prisma.workOrderTask.count() },
    { label: 'Mantenimientos', del: () => prisma.maintenanceOrder.deleteMany(), count: () => prisma.maintenanceOrder.count() },
    { label: 'Órdenes de trabajo', del: () => prisma.workOrder.deleteMany(), count: () => prisma.workOrder.count() },
    { label: 'Asignaciones de activos', del: () => prisma.assetAssignment.deleteMany(), count: () => prisma.assetAssignment.count() },
    { label: 'Ajustes', del: () => prisma.inventoryAdjustment.deleteMany(), count: () => prisma.inventoryAdjustment.count() },
    { label: 'Líneas de recepción', del: () => prisma.gRLine.deleteMany(), count: () => prisma.gRLine.count() },
    { label: 'Recepciones', del: () => prisma.goodsReceipt.deleteMany(), count: () => prisma.goodsReceipt.count() },
    { label: 'Líneas de OC', del: () => prisma.pOLine.deleteMany(), count: () => prisma.pOLine.count() },
    { label: 'Órdenes de compra', del: () => prisma.purchaseOrder.deleteMany(), count: () => prisma.purchaseOrder.count() },
    { label: 'Reglas de reorden (límites)', del: () => prisma.reorderRule.deleteMany(), count: () => prisma.reorderRule.count() },
    { label: 'Kardex', del: () => prisma.kardexEntry.deleteMany(), count: () => prisma.kardexEntry.count() },
    { label: 'Movimientos', del: () => prisma.inventoryMovement.deleteMany(), count: () => prisma.inventoryMovement.count() },
    { label: 'Existencias', del: () => prisma.stockLevel.deleteMany(), count: () => prisma.stockLevel.count() },
    { label: 'Series', del: () => prisma.serialNumber.deleteMany(), count: () => prisma.serialNumber.count() },
  ];

  for (const s of steps) {
    if (CONFIRM) {
      const { count } = await s.del();
      console.log(`   ✓ ${s.label}: ${count} borrados`);
    } else {
      console.log(`   • ${s.label}: ${await s.count()} se borrarían`);
    }
  }

  if (CONFIRM) {
    const { count } = await prisma.product.updateMany({ data: { averageCost: 0, lastCost: 0 } });
    console.log(`   ✓ Costos de ${count} productos reseteados a 0`);
    console.log('\n✅ Listo. Catálogo, bodegas, usuarios y roles INTACTOS. Carga el stock inicial con recepciones o ajustes.');
  } else {
    const prods = await prisma.product.count();
    console.log(`\n   (se conservarían ${prods} productos y todo el catálogo/usuarios)`);
    console.log('   Para ejecutar: CONFIRM_RESET=YES npx ts-node prisma/reset-inventory-data.ts');
  }
}

main()
  .catch((e) => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
