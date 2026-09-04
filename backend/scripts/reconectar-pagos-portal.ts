/**
 * Pasada RETROACTIVA del puente con el portal de pagos en línea.
 *
 * El puente normal (`OnlinePaymentsService`, cron cada 5 min) solo mira los últimos
 * días: sin esa ventana, la primera pasada saldría a reconectar meses de historia.
 * Esto es lo otro — el arrastre de una sola vez, para la gente que YA pagó por el
 * portal y se quedó sin servicio porque el sistema anterior solo reconecta internet
 * (y solo si la factura es del mes corriente) y la TV nunca la devuelve.
 *
 * Va en SECO por defecto: dice a quién reconectaría, servicio por servicio, sin tocar
 * un solo equipo. Con `--aplicar` sale de verdad contra routers y OLTs.
 *
 *   npx ts-node --transpile-only scripts/reconectar-pagos-portal.ts [--dias=30]
 *   npx ts-node --transpile-only scripts/reconectar-pagos-portal.ts --dias=30 --aplicar
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';

// El arranque normal recibe el entorno de PM2; una corrida por consola no, y sin
// `.env` no hay ni base de datos ni credenciales del portal. Se lee a mano, igual
// que en `sync-legacy-vivo.js`: el proyecto no tiene `dotenv` instalado.
for (const linea of (() => { try { return fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n'); } catch { return []; } })()) {
  const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

import { PrismaService } from '../src/prisma/prisma.service';
import { onlinePaymentsService } from '../src/core/contenedor';
import { displayName } from '../src/common/subscriber-name';

const arg = (n: string, d: string) =>
  (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split('=')[1];
const DIAS = Number(arg('dias', '30'));
const APLICAR = process.argv.includes('--aplicar');
const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

async function main() {
  const prisma = new PrismaService();
  console.log(`\n=== Pagos del portal · últimos ${DIAS} días · ${APLICAR ? 'APLICAR' : 'SIMULACIÓN'} ===\n`);

  // 1. Traer del portal lo que falte. Se repite hasta agotar (la ingesta va por lotes).
  let ingestadas = 0;
  let actualizadas = 0;
  let sinAbonado = 0;
  for (let i = 0; i < 200; i++) {
    const r = await onlinePaymentsService.ingest();
    ingestadas += r.ingestadas;
    actualizadas += r.actualizadas;
    sinAbonado += r.sinAbonado;
    if (!r.ingestadas && !r.actualizadas) break;
  }
  console.log(`Ingesta: ${ingestadas} orden(es) nuevas · ${actualizadas} con estado nuevo · ${sinAbonado} sin abonado aquí\n`);

  // 2. Quiénes son. Se listan ANTES de tocar nada: es lo que hay que poder revisar.
  const seco = await onlinePaymentsService.reconectar({ dias: DIAS, dryRun: true, limite: 5000 });
  if (!seco.candidatos) {
    console.log('No hay pagos del portal pendientes de reconexión en esa ventana.\n');
    return;
  }

  const subs = await prisma.subscriber.findMany({
    where: { id: { in: seco.abonados } },
    select: {
      id: true, abonado: true, status: true,
      fullName: true, firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true,
    },
    orderBy: { abonado: 'asc' },
  });
  const montos = await prisma.paymentOrder.groupBy({
    by: ['subscriberId'],
    where: { subscriberId: { in: seco.abonados }, status: 'APPROVED', appliedAt: null },
    _sum: { amount: true },
  });
  const porSub = new Map(montos.map((m) => [m.subscriberId, Number(m._sum.amount ?? 0)]));
  const internet = new Set(seco.internetIds);
  const tv = new Set(seco.tvIds);

  if (!subs.length) {
    console.log(`${seco.candidatos} pago(s) revisados: ninguno de esos clientes tenía servicio cortado.\n`);
    return;
  }
  console.log(
    `${seco.candidatos} pago(s) revisados · ${subs.length} abonado(s) con servicio caído ` +
    `(internet ${seco.internet} · TV ${seco.tv}):\n`,
  );
  for (const s of subs) {
    const caido = [internet.has(s.id) ? 'internet' : null, tv.has(s.id) ? 'TV' : null].filter(Boolean).join(' + ');
    console.log(
      `  ${String(s.abonado).padStart(7)}  ${displayName(s).slice(0, 32).padEnd(32)} ` +
      `${(s.status ?? '—').padEnd(11)} ${caido.padEnd(15)} ${cop(porSub.get(s.id) ?? 0)}`,
    );
  }

  if (!APLICAR) {
    console.log(`\nSIMULACIÓN: no se tocó ningún equipo. Repite con --aplicar para reconectar.\n`);
    return;
  }

  // 3. En serio. `porPagoLote` decide qué le toca a cada quien (internet, TV o nada) y
  //    abre orden de servicio de lo que el equipo no deje hacer.
  console.log('\nReconectando…\n');
  const r = await onlinePaymentsService.reconectar({ dias: DIAS, limite: 5000 });
  console.log(
    `Internet: ${r.internet} · TV: ${r.tv} · órdenes de visita abiertas: ${r.ordenes}` +
    (r.dryRun ? '\nOJO: los gates de red están en DRY-RUN; no se tocó ningún equipo de verdad.' : ''),
  );
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .then(() => process.exit(0));
