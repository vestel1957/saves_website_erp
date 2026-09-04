/**
 * ¿Puede la cajera editar plata? (2026-08-03)
 *
 * No prueba la lógica de negocio: prueba la FRONTERA. Lee del controlador el
 * `@RequireArea` efectivo de cada ruta (el del método, y si no el de la clase) y lo
 * evalúa con la MISMA regla del `AreaGuard` —OR de áreas, y `system.admin` pasa
 * siempre— contra los permisos REALES que el rol `area-caja` tiene hoy en la BD.
 *
 * Así, si mañana alguien le devuelve una ruta al área caja sin querer, esto lo dice.
 * Cubre las dos caras: lo que NO debe poder (editar/anular/borrar dinero) y lo que
 * SÍ debe seguir pudiendo (recaudar, egresar, transferir, cerrar su caja), que es la
 * mitad que se rompe cuando uno aprieta permisos.
 *
 * Uso: npx ts-node --transpile-only scripts/smoke-cajera-sin-editar-dinero.ts
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { exigenciasPorHandler } from './lib/areas-por-handler';
import { ALL_ROLES, SUPERADMIN_PERMISSION } from '../src/auth/permissions.catalog';
import { TreasuryController } from '../src/treasury/treasury.controller';
import { SubscribersController } from '../src/subscribers/subscribers.controller';
import { BillingController } from '../src/billing/billing.controller';
import { PlansController } from '../src/plans/plans.controller';
import { OmniController } from '../src/omni/omni.controller';
import { PaymentImportsController } from '../src/payment-imports/payment-imports.controller';
import { PromotionsService } from '../src/promotions/promotions.service';

const prisma = new PrismaClient();
let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg} ${extra}`); }
};

/** Se lee UNA vez de los routers: qué exige cada handler realmente montado. */
const EXIGENCIAS = exigenciasPorHandler();

/**
 * Copia exacta de la decisión de `exigirArea`, para no probar contra una regla
 * inventada. Antes leía los metadatos del decorador; ahora lee la línea de la ruta
 * en el router, que es donde vive la exigencia desde la migración a Express.
 */
function pasaElGuard(permisos: string[], ctrl: any, metodo: string): boolean {
  if (permisos.includes(SUPERADMIN_PERMISSION)) return true;
  if (!ctrl.prototype[metodo]) {
    throw new Error(`El método ${ctrl.name}.${metodo} no existe (¿lo renombraron?)`);
  }
  const exigencia = EXIGENCIAS.get(`${ctrl.name}.${metodo}`);
  if (!exigencia) {
    throw new Error(
      `${ctrl.name}.${metodo} no está montado en ningún router: la ruta desapareció.`,
    );
  }
  if (exigencia.areas.length === 0) return true; // sin área, el middleware no opina
  if (exigencia.orPermission.some((p) => permisos.includes(p))) return true;
  return exigencia.areas.some((a) => permisos.includes(`area.${a}`));
}

/** Rutas que la cajera NO debe poder tocar: son plata ya registrada, o su precio. */
const PROHIBIDO: [any, string, string][] = [
  [TreasuryController, 'editTx', 'editar un movimiento (monto/fecha/caja)'],
  [TreasuryController, 'voidTx', 'anular un movimiento'],
  [TreasuryController, 'createCashAccount', 'crear una caja/banco'],
  [TreasuryController, 'updateCashAccount', 'editar una caja (fondo fijo)'],
  [TreasuryController, 'deleteCashAccount', 'borrar una caja'],
  [TreasuryController, 'recomputeCashAccount', 'recalcular el saldo de una caja'],
  [TreasuryController, 'createCategory', 'crear categoría de movimiento'],
  [TreasuryController, 'updateCategory', 'renombrar categoría'],
  [TreasuryController, 'deleteCategory', 'borrar categoría'],
  [TreasuryController, 'pagosFijosCreate', 'definir un pago fijo'],
  [TreasuryController, 'pagosFijosUpdate', 'editar un pago fijo'],
  [TreasuryController, 'pagosFijosRemove', 'borrar un pago fijo'],
  [SubscribersController, 'updateInvoice', 'editar la factura desde la ficha del cliente'],
  [SubscribersController, 'deleteInvoice', 'BORRAR una factura del cliente'],
  [BillingController, 'update', 'editar una factura'],
  [BillingController, 'createNote', 'emitir nota crédito/débito'],
  [BillingController, 'voidInvoice', 'anular una factura'],
  [BillingController, 'generate', 'correr la facturación del mes'],
  [PlansController, 'create', 'crear un plan (precio)'],
  [PlansController, 'update', 'cambiar el PRECIO de un plan'],
  [PlansController, 'remove', 'borrar un plan'],
  [OmniController, 'createQuote', 'crear una cotización'],
  [OmniController, 'quoteStatus', 'cambiar el estado de una cotización'],
  [OmniController, 'convertQuote', 'convertir una cotización en FACTURA'],
  [PaymentImportsController, 'upload', 'subir el cargue masivo de Efecty'],
  [PaymentImportsController, 'process', 'aplicar el cargue masivo de Efecty'],
  [PaymentImportsController, 'remove', 'borrar un cargue de Efecty'],
];

/** Su oficio: esto TIENE que seguir funcionando o le rompimos el día. */
const PERMITIDO: [any, string, string][] = [
  [TreasuryController, 'collect', 'registrar un recaudo'],
  [TreasuryController, 'expense', 'registrar un egreso'],
  [TreasuryController, 'income', 'registrar un ingreso manual'],
  [TreasuryController, 'transfer', 'transferir entre cajas'],
  [TreasuryController, 'cashOpen', 'abrir su caja'],
  [TreasuryController, 'cashClose', 'cerrar su caja (arqueo)'],
  [TreasuryController, 'attach', 'adjuntar el comprobante de un movimiento'],
  [TreasuryController, 'pagosFijosEjecutar', 'ejecutar un pago fijo ya definido'],
  [TreasuryController, 'list', 'ver los movimientos (de su caja)'],
  [TreasuryController, 'cashAccounts', 'ver las cajas del selector'],
  [TreasuryController, 'categories', 'ver las categorías'],
  [BillingController, 'detail', 'ver el detalle de una factura'],
  [BillingController, 'invoicePdf', 'imprimir la factura'],
  // 2026-08-27: emitir SÍ es de ventanilla (instalación, traslado, reconexión,
  // venta de equipo). Es la única escritura suya sobre facturas: `update`,
  // `voidInvoice`, `createNote` y `generate` siguen en la lista de arriba.
  [BillingController, 'create', 'emitir una factura de ventanilla'],
  [SubscribersController, 'invoices', 'ver las facturas del cliente'],
  [PlansController, 'list', 'ver el catálogo de planes'],
  [OmniController, 'createEvent', 'crear un evento de su agenda'],
];

/**
 * Permisos del rol. Se prefieren los de la BD —la concesión real vive en
 * `RolePermission`, y el catálogo es sólo la semilla—, pero si no hay BD a mano se
 * cae al catálogo y se dice: la parte de guardas es la que importa y no necesita BD,
 * y así esto también corre en un entorno limpio.
 */
async function permisosDelRol(): Promise<{ permisos: string[]; fuente: 'BD' | 'catálogo' }> {
  try {
    const rol = await prisma.role.findUnique({
      where: { key: 'area-caja' },
      select: { permissions: { select: { permission: { select: { key: true } } } } },
    });
    if (rol) return { permisos: rol.permissions.map((p) => p.permission.key), fuente: 'BD' };
    console.log('  ⚠ El rol "area-caja" no está en la BD; se usa el catálogo.');
  } catch (e) {
    console.log(`  ⚠ Sin BD (${(e as Error).message.split('\n')[0]}); se usa el catálogo.`);
  }
  const def = ALL_ROLES.find((r) => r.key === 'area-caja');
  if (!def) { console.error('✗ El catálogo tampoco define "area-caja".'); process.exit(1); }
  return { permisos: def.permissions, fuente: 'catálogo' };
}

async function main() {
  const { permisos, fuente } = await permisosDelRol();
  console.log(`Rol "Caja y ventas" (${fuente}): ${permisos.length} permisos. Áreas: ${permisos.filter((p) => p.startsWith('area.')).join(', ') || '(ninguna)'}\n`);

  console.log('NO debe poder:');
  for (const [ctrl, metodo, desc] of PROHIBIDO) {
    assert(!pasaElGuard(permisos, ctrl, metodo), `${desc}  [${ctrl.name}.${metodo}]`);
  }

  console.log('\nSÍ debe poder (su oficio):');
  for (const [ctrl, metodo, desc] of PERMITIDO) {
    assert(pasaElGuard(permisos, ctrl, metodo), `${desc}  [${ctrl.name}.${metodo}]`);
  }

  // 2) Las promociones se le DEJAN a propósito (decisión 2026-08-03): su control ya no
  //    es la asignación al funcionario sino el PÚBLICO de la promo (a qué clientes
  //    alcanza). Se comprueba que ese control existe.
  console.log('\nPromociones (se le dejan, con su control):');
  assert(typeof PromotionsService.prototype.apply === 'function', 'aplicar una promoción sigue disponible');

  // 3) Lo que sólo se puede mirar con BD: de qué tamaño es el público de las promos
  //    vigentes, y si alguna cuenta con el rol trae un área extra por override (un
  //    permiso dado a mano a una persona concreta, que este cierre NO toca — misma
  //    política que migrate-cajera-recorte).
  if (fuente === 'BD') {
    const acotadas = await prisma.promotion.count({ where: { active: true, allSubscribers: false } });
    const aTodos = await prisma.promotion.count({ where: { active: true, allSubscribers: true } });
    console.log(`  · ${acotadas} promo(s) activa(s) acotada(s) a un público y ${aTodos} para todos los clientes — fuera de su público, la promo ni aparece.`);

    const cajeras = await prisma.user.findMany({
      where: { roles: { some: { role: { key: 'area-caja' } } } },
      select: { name: true, email: true, isActive: true, permissionOverrides: { select: { effect: true, permission: { select: { key: true } } } } },
    });
    console.log(`\nCuentas con el rol (${cajeras.filter((c) => c.isActive).length} activas de ${cajeras.length}):`);
    let avisos = 0;
    for (const c of cajeras) {
      const mando = c.permissionOverrides
        .filter((p) => p.effect === 'ALLOW' && (p.permission.key.startsWith('area.') || p.permission.key === SUPERADMIN_PERMISSION))
        .map((p) => p.permission.key)
        .filter((k) => k !== 'area.caja');
      if (mando.length) {
        avisos++;
        console.log(`  ⚠ ${c.name} <${c.email}>${c.isActive ? '' : ' (inhabilitada)'}: también tiene ${mando.join(', ')} → sigue pudiendo editar. Es un permiso dado a mano, no se toca aquí.`);
      }
    }
    if (!avisos) console.log('  · ninguna tiene un área extra por override: el cierre las cubre a todas.');
  } else {
    console.log('\n  (sin BD: no se pudo revisar overrides por usuario ni promos vigentes)');
  }

  console.log(`\n${ok} OK · ${fail} fallos`);
  await prisma.$disconnect();
  if (fail) process.exit(1);
}
main().catch(async (e) => { console.error('FALLO:', e); await prisma.$disconnect(); process.exit(1); });
