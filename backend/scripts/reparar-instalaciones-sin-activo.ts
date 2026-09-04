/**
 * Repara las INSTALACIONES que se cerraron aquí y dejaron al cliente en INSTALAR.
 *
 * La cascada de cierre (`applyCloseCascade`) SÍ pone al abonado en ACTIVO cuando se
 * cierra una orden de Instalación, pero ese cambio nunca viaja al legacy: quien
 * empuja activaciones allá es `pushReconexiones` en `writeback-legacy.js`, y esa
 * función solo reconoce cierres de RECONEXIÓN (nota que empieza en 'Reconexión…' u
 * orden 'Reconexion …'), nunca 'Instalación'. Como `status` es de los campos que la
 * ida siempre trae del legacy (`CAMPOS_DE_ALLA`, sin blindaje de `editedAt`), la
 * siguiente pasada del sync (15 min) devuelve el 'Instalar' que el legacy sigue
 * teniendo — sin error, sin rastro. Mismo patrón que ya pasó con los retiros, ver
 * `reparar-retiros-sin-estado.ts`.
 *
 * Esto repone el estado + historial AQUÍ y empuja `usu_estado='Activo'` al legacy
 * en el mismo acto (no hay `pushReconexiones` genérico que lo recoja para este caso),
 * para que la próxima ida no lo vuelva a revertir.
 *
 * Uso:  npx ts-node --transpile-only scripts/reparar-instalaciones-sin-activo.ts [--desde=2026-08-01]
 *       (por defecto SECO: hay que pasar --aplicar para escribir)
 */
import { PrismaClient, type SubscriberStatus } from '@prisma/client';
import mysql from 'mysql2/promise';

const prisma = new PrismaClient();

const arg = (n: string) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=').slice(1).join('=') : null;
};
const APLICAR = process.argv.includes('--aplicar');
const DESDE = new Date(arg('desde') || '2026-08-01');

async function main() {
  const ordenes = await prisma.ticket.findMany({
    where: {
      status: 'RESUELTO',
      resolvedAt: { not: null, gte: DESDE }, // sólo lo escribe este sistema: "se cerró AQUÍ"
      editedAt: { not: null },
      type: { contains: 'Instalac', mode: 'insensitive' },
    },
    select: {
      id: true, code: true, type: true, resolvedAt: true, subscriberId: true,
      subscriber: { select: { id: true, abonado: true, legacyId: true, status: true } },
    },
    orderBy: { resolvedAt: 'asc' },
  });

  const plan: Array<{
    code: number | null; abonado: number; subId: string; legacyId: number | null;
    antes: SubscriberStatus; fecha: Date;
  }> = [];
  for (const o of ordenes) {
    const s = o.subscriber;
    if (!s || s.status !== 'INSTALAR') continue; // ya está bien (o es otro caso)
    if (plan.some((p) => p.subId === s.id)) continue; // dos órdenes del mismo cliente
    plan.push({ code: o.code, abonado: s.abonado, subId: s.id, legacyId: s.legacyId, antes: s.status as SubscriberStatus, fecha: o.resolvedAt! });
  }

  console.log(`Órdenes de instalación cerradas aquí desde ${DESDE.toISOString().slice(0, 10)}: ${ordenes.length}`);
  console.log(`Clientes por reponer: ${plan.length}`);
  for (const p of plan) {
    console.log(`  · abonado ${p.abonado} — orden #${p.code} cerrada ${p.fecha.toISOString().slice(0, 16)} — hoy está ${p.antes}`);
  }
  if (!plan.length || !APLICAR) {
    console.log(APLICAR ? 'Nada que hacer.' : 'SECO: no se escribió nada (pasa --aplicar).');
    return;
  }

  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST || '127.0.0.1',
    port: Number(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER,
    password: process.env.LEGACY_DB_PASSWORD,
    database: process.env.LEGACY_DB_NAME || 'admin_vestel',
    dateStrings: true,
  });

  let ok = 0;
  for (const p of plan) {
    const ahora = new Date();
    await prisma.$transaction([
      prisma.subscriber.update({
        where: { id: p.subId },
        data: { previousStatus: p.antes, status: 'ACTIVO', statusChangedAt: ahora },
      }),
      prisma.subscriberStatusHistory.create({
        data: {
          subscriberId: p.subId,
          status: 'ACTIVO',
          date: ahora,
          originTicketId: p.code ?? null,
          note: `Instalación${p.code ? ` (orden #${p.code})` : ''} — repuesto: el cierre no viajó al legacy y la ida lo revirtió`,
        },
      }),
    ]);
    if (p.legacyId) {
      await my.execute(
        'UPDATE `customers` SET `usu_estado`=?, `ultimo_estado`=?, `fecha_cambio`=? WHERE `id`=?',
        ['Activo', 'Instalar', ahora.toISOString().slice(0, 19).replace('T', ' '), p.legacyId],
      );
    }
    ok++;
    console.log(`  ✓ abonado ${p.abonado} → ACTIVO (aquí y en el legacy)`);
  }
  console.log(`Listo: ${ok} clientes repuestos.`);
  await my.end();
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
