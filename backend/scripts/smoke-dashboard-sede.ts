/** Comprobación del filtro por sede del panel ejecutivo contra la BD real (solo lee). */
import { PrismaClient } from '@prisma/client';
import { DashboardService } from '../src/dashboard/dashboard.service';

const prisma = new PrismaClient();
const admin: any = { id: 'smoke', permissions: ['system.admin'], sedes: [] };
const acotado: any = { id: 'smoke2', permissions: ['area.gerencia'], sedes: [3] };

const resumen = (t: string, d: any) => {
  console.log(`\n== ${t}`);
  console.log('  sede:', d.sede, '| catálogo:', d.sedes.map((s: any) => `${s.id}:${s.nombre}`).join(', '));
  console.log('  clientes:', d.clientes, '| nuevos:', d.nuevosAbonados);
  console.log('  facturado:', Math.round(d.facturacion.total), 'facturas', d.facturacion.facturas);
  console.log('  cartera:', Math.round(d.cartera.total), 'aging', JSON.stringify(d.cartera.aging));
  console.log('  tesorería:', JSON.stringify(d.tesoreria), '| puntos serie:', d.serieMensual.length);
  console.log('  soporte:', JSON.stringify(d.soporte), '| compras:', JSON.stringify(d.compras));
  console.log('  red:', JSON.stringify(d.red), '| inventario:', Math.round(d.inventario.valor));
  console.log('  ventasPorSede:', d.ventasPorSede.map((v: any) => `${v.id}:${v.sede}=${Math.round(v.total / 1e6)}M/${v.abonados}`).join('  '));
  console.log('  topDeudores:', d.topDeudores.length);
};

async function main() {
  const svc = new DashboardService(prisma as any);
  const from = '2026-08-01', to = '2026-08-31';
  const todas = await svc.summary(from, to, undefined, admin);
  resumen('TODAS las sedes (agosto)', todas);
  let suma = 0;
  for (const s of todas.sedes) {
    const d = await svc.summary(from, to, String(s.id), admin);
    suma += d.facturacion.total;
    console.log(`  · ${s.nombre.padEnd(14)} facturado ${Math.round(d.facturacion.total / 1e6)}M  clientes ${d.clientes.total}  recaudo ${Math.round(d.tesoreria.ingresos / 1e6)}M  órdenes ${d.soporte.total}`);
  }
  console.log('\n  suma por sede:', Math.round(suma), 'vs total:', Math.round(todas.facturacion.total), '(la diferencia son los abonados SIN sede)');

  resumen('Yopal (sede 2)', await svc.summary(from, to, '2', admin));
  resumen('Usuario acotado a Villanueva, sin pedir sede', await svc.summary(from, to, undefined, acotado));
  try {
    await svc.summary(from, to, '2', acotado);
    console.log('\n!! FALLO: el acotado pudo mirar Yopal');
  } catch (e: any) {
    console.log('\n  acotado pidiendo Yopal ->', e.constructor.name, e.message);
  }
  console.log('\n  sede basura ("abc") ->', (await svc.summary(from, to, 'abc', admin)).sede);
}

main().finally(() => prisma.$disconnect());
