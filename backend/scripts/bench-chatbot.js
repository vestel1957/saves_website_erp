/**
 * Perfilado del chatbot: cronometra identidad y cada herramienta contra la BD real.
 * No enciende el motor ni gasta LLM.
 *
 *   node scripts/bench-chatbot.js
 */
process.env.WA_AGENT_ENABLED = 'false';

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/src/app.module');
const { ChatbotIdentityService } = require('../dist/src/chatbot/chatbot-identity.service');
const { PublicoToolset } = require('../dist/src/chatbot/toolsets/publico.toolset');
const { ClienteToolset } = require('../dist/src/chatbot/toolsets/cliente.toolset');
const { InternoAbonadosToolset } = require('../dist/src/chatbot/toolsets/interno-abonados.toolset');
const { InternoTicketsToolset } = require('../dist/src/chatbot/toolsets/interno-tickets.toolset');
const { PrismaService } = require('../dist/src/prisma/prisma.service');

const ctx = (user) => ({
  user, convKey: `kapso:${user.id}`, committing: false,
  can: () => true, canStrict: () => true,
  preparePending: (a) => `PREPARADO: ${a.summary}`,
  sendDocument: async () => true, audit: async () => {},
});

/** Corre n veces y devuelve la mediana (evita que un outlier de red mienta). */
async function timeIt(label, fn, n = 5) {
  const ms = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    try { await fn(); } catch (e) { console.log(`  ${label.padEnd(34)} ERROR: ${e.message.slice(0, 50)}`); return null; }
    ms.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  ms.sort((a, b) => a - b);
  const med = ms[Math.floor(n / 2)];
  const flag = med > 300 ? ' \x1b[31m← LENTO\x1b[0m' : med > 120 ? ' \x1b[33m← pesado\x1b[0m' : '';
  console.log(`  ${label.padEnd(34)} ${med.toFixed(0).padStart(5)} ms${flag}`);
  return med;
}

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const identity = app.get(ChatbotIdentityService);

  const sub = await prisma.subscriber.findFirst({
    where: { phone1: { not: null }, status: { notIn: ['DEPURADO', 'RETIRADO'] } },
    select: { id: true, phone1: true },
  });
  const anon = await identity.resolveUser('573009998877');
  const cli = await identity.resolveUser(sub.phone1);
  const staff = { id: 'x', name: 'T', permissions: ['system.admin'], meta: { identity: { kind: 'interno', authUser: { id: 'x', email: 'a@b.c', name: 'T', roles: [], permissions: ['system.admin'] } } } };

  // Calentar la conexión de Prisma para no medir el primer handshake.
  await prisma.subscriber.count();

  console.log('\n\x1b[1mIDENTIDAD\x1b[0m (corre en CADA mensaje entrante)');
  await timeIt('resolveUser desconocido', () => identity.resolveUser('573009998877'));
  await timeIt('resolveUser abonado', () => identity.resolveUser(sub.phone1));

  console.log('\n\x1b[1mAGENTE PÚBLICO\x1b[0m');
  const pub = app.get(PublicoToolset);
  await timeIt('planes_disponibles', () => pub.execute('planes_disponibles', {}, ctx(anon)));
  await timeIt('sedes', () => pub.execute('sedes', {}, ctx(anon)));

  console.log('\n\x1b[1mAGENTE CLIENTES\x1b[0m');
  const c = app.get(ClienteToolset);
  await timeIt('mi_estado_de_cuenta', () => c.execute('mi_estado_de_cuenta', {}, ctx(cli)));
  await timeIt('mis_facturas', () => c.execute('mis_facturas', {}, ctx(cli)));
  await timeIt('mi_plan', () => c.execute('mi_plan', {}, ctx(cli)));
  await timeIt('mis_pagos', () => c.execute('mis_pagos', {}, ctx(cli)));
  await timeIt('mis_tickets_soporte', () => c.execute('mis_tickets_soporte', {}, ctx(cli)));

  console.log('\n\x1b[1mAGENTE INTERNO\x1b[0m');
  const a = app.get(InternoAbonadosToolset);
  const t = app.get(InternoTicketsToolset);
  await timeIt('buscar_abonado', () => a.execute('buscar_abonado', { q: 'maria' }, ctx(staff)));
  await timeIt('ficha_abonado', () => a.execute('ficha_abonado', { subscriberId: sub.id }, ctx(staff)));
  await timeIt('estado_cuenta_abonado', () => a.execute('estado_cuenta_abonado', { subscriberId: sub.id }, ctx(staff)));
  await timeIt('facturas_abonado', () => a.execute('facturas_abonado', { subscriberId: sub.id }, ctx(staff)));
  await timeIt('buscar_tickets', () => t.execute('buscar_tickets', { status: 'PENDIENTE' }, ctx(staff)));

  console.log('\n\x1b[1mTAMAÑO DEL PROMPT\x1b[0m (afecta el time-to-first-token del LLM)');
  for (const [name, ts, u] of [['público', pub, anon], ['clientes', c, cli]]) {
    const defs = ts.definitions(ctx(u));
    const chars = JSON.stringify(defs).length;
    console.log(`  ${('herramientas ' + name).padEnd(34)} ${String(defs.length).padStart(5)} defs · ~${Math.round(chars / 4)} tokens`);
  }
  const { combineToolsets } = require('../dist/src/chatbot/toolsets/toolset.util');
  const interno = combineToolsets(
    a, t, app.get(require('../dist/src/chatbot/toolsets/interno-red.toolset').InternoRedToolset),
    app.get(require('../dist/src/chatbot/toolsets/interno-inventario.toolset').InternoInventarioToolset),
    app.get(require('../dist/src/chatbot/toolsets/interno-caja.toolset').InternoCajaToolset),
    app.get(require('../dist/src/chatbot/toolsets/interno-reportes.toolset').InternoReportesToolset),
  );
  const idefs = interno.definitions(ctx(staff));
  console.log(`  ${'herramientas interno (superadmin)'.padEnd(34)} ${String(idefs.length).padStart(5)} defs · ~${Math.round(JSON.stringify(idefs).length / 4)} tokens`);
  await timeIt('combineToolsets.definitions()', async () => interno.definitions(ctx(staff)), 20);

  await app.close();
  console.log('');
})();
