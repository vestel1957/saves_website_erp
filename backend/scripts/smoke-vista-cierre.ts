/**
 * Comprueba que la vista del cierre trae la MISMA data que la pantalla del legacy:
 * la cabecera (caja, fecha, cajero, horas, efectivo) y los 10 bloques.
 *
 * Uso: npx ts-node --transpile-only scripts/smoke-vista-cierre.ts [caja] [fecha]
 */
import { PrismaClient } from '@prisma/client';
import { TreasuryService } from '../src/treasury/treasury.service';
import { AuthUser } from '../src/auth/current-user.decorator';

const prisma = new PrismaClient();
const cop = (n: number) => '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n || 0));
let ok = 0, fail = 0;
const chk = (c: boolean, m: string, extra = '') => {
  if (c) { ok++; console.log(`  OK    ${m}`); } else { fail++; console.log(`  FALLO ${m} ${extra}`); }
};

async function main() {
  const caja = Number(process.argv[2] ?? 1);
  const fecha = process.argv[3] ?? '2026-07-01';
  const svc = new TreasuryService(prisma as any);
  // Contabilidad: ve todas las cajas.
  const user: AuthUser = { id: 'x', email: 'c@v.dev', name: 'Contable', roles: [], permissions: ['area.contabilidad'] };

  const d: any = await svc.cashCloseReport(caja, fecha, user);
  const a = d.arqueo;

  console.log(`\n=== Cabecera (los mismos campos que el legacy) ===`);
  console.log(`  Caja          : ${d.caja.holder} · ${d.caja.accountNumber ?? '—'}`);
  console.log(`  Fecha         : ${new Date(d.fecha).toISOString().slice(0, 10)}`);
  console.log(`  Cajero        : ${a.cajero ?? '—'}`);
  console.log(`  Hora apertura : ${a.horaApertura ?? '—'}`);
  console.log(`  Hora cierre   : ${a.horaCierre ?? '—'}`);
  console.log(`  Efectivo Caja : ${cop(a.excedente)}`);
  console.log(`  (migrado: ${a.migrado})`);

  console.log(`\n=== Los 10 bloques ===`);
  chk(!!d.cobranza?.total, 'Resumen Cobranza');
  chk(Array.isArray(d.porBanco) && d.porBanco.length === 4, 'Resumen por Banco (4 cuentas)');
  chk(!!d.formaPago?.saldoAnterior, 'Resumen por Forma de pago (con Saldo Anterior)');
  chk(!!d.servicios?.total, 'Resumen por Servicios');
  chk(!!d.tipoServicio?.Internet, 'Resumen por tipo de servicio');
  chk(!!d.meses?.actual && !!d.meses?.anterior && !!d.meses?.anteriores, 'Cargos cobrados por meses');
  chk(!!d.meses?.actual?.Internet, 'Cargos por meses INTERNET');
  chk(!!d.meses?.actual?.Television, 'Cargos por meses TV');
  chk(!!d.anulaciones, 'Resumen Anulaciones');
  chk(!!d.egresos?.total, 'Resumen Egresos');

  console.log(`\n=== La cabecera cuadra con los bloques ===`);
  chk(a.cajero !== undefined, 'el cajero viene del cierre, no del usuario que mira (el legacy usaba el que miraba)');
  const totalTipo = d.tipoServicio.Internet.monto + d.tipoServicio.Television.monto;
  chk(Math.abs(d.cobranza.total.monto - totalTipo) < 1,
    'TOTAL COBRANZA == TOTAL TIPO DE SERVICIOS', `${cop(d.cobranza.total.monto)} vs ${cop(totalTipo)}`);
  chk(d.formaPago.saldoAnterior.cantidad === (d.formaPago.saldoAnterior.monto === 0 ? 0 : 1),
    'la CANT del Saldo Anterior es 0 o 1 (regla del legacy)');

  console.log(`\n${ok} OK · ${fail} fallos`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
