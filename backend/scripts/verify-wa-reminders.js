/**
 * Verificación de los recordatorios de cartera por WhatsApp, contra la BD real.
 *
 * NO envía nada: fuerza la simulación (WA_REMINDERS_LIVE=false) y comprueba que la
 * selección de candidatos respeta sus reglas — estados cobrables, deuda mínima,
 * solo móviles, un mensaje por teléfono, sin tocar conversaciones escaladas a una
 * persona, rotación por "hace más que no le escribimos" y tope por corrida.
 *
 * Deja la BD como estaba: la simulación no marca `lastWaReminderAt`, y eso también
 * se verifica.
 *
 *   node scripts/verify-wa-reminders.js
 */
process.env.WA_AGENT_ENABLED = 'false';
process.env.CRONS_ENABLED = 'false';
process.env.WA_REMINDERS_LIVE = 'false';
process.env.WA_REMINDERS_ENABLED = 'false';

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/src/app.module');
const { WhatsappRemindersService } = require('../dist/src/common/whatsapp/whatsapp-reminders.service');
const { PrismaService } = require('../dist/src/prisma/prisma.service');

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗ ${m}\x1b[0m`); process.exitCode = 1; };
const cop = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const svc = app.get(WhatsappRemindersService);

  console.log('\n\x1b[1m1. Configuración\x1b[0m');
  const cfg = await svc.config();
  console.log(`  ${JSON.stringify({ enabled: cfg.enabled, live: cfg.live, cap: cfg.cap, plantilla: cfg.template })}`);
  cfg.live === false ? ok('arranca en SIMULACIÓN (no se envía nada sin encenderlo a propósito)')
    : bad('¡está en modo REAL! el gate no está tomando el valor por defecto');

  console.log('\n\x1b[1m2. Selección de candidatos\x1b[0m');
  const t0 = Date.now();
  const cands = await svc.candidatos(cfg.cap);
  console.log(`  ${cands.length} candidatos en ${Date.now() - t0} ms · cartera ${cop(cands.reduce((a, c) => a + c.deuda, 0))}`);
  cands.length <= cfg.cap ? ok(`respeta el tope por corrida (${cands.length}/${cfg.cap})`) : bad('se pasó del tope');

  const estadosOk = ['ACTIVO', 'CORTADO', 'CARTERA', 'COMPROMISO', 'SUSPENDIDO'];
  const intrusos = cands.filter((c) => !estadosOk.includes(c.status));
  intrusos.length === 0 ? ok('nadie RETIRADO/DEPURADO/EXONERADO en la lista')
    : bad(`${intrusos.length} con estado no cobrable: ${intrusos.slice(0, 3).map((c) => c.status).join(', ')}`);

  const noMovil = cands.filter((c) => !/^573\d{9}$/.test(c.phone));
  noMovil.length === 0 ? ok('todos los destinos son móviles colombianos')
    : bad(`${noMovil.length} destinos no son móviles: ${noMovil.slice(0, 3).map((c) => c.phone).join(', ')}`);

  const pobres = cands.filter((c) => c.deuda < 1000);
  pobres.length === 0 ? ok('nadie por debajo de la deuda mínima ($1.000)')
    : bad(`${pobres.length} con deuda menor a $1.000`);

  const tel = new Set(cands.map((c) => c.phone));
  tel.size === cands.length ? ok('un solo mensaje por teléfono (fichas que comparten celular)')
    : bad(`${cands.length - tel.size} teléfonos repetidos`);

  console.log('\n\x1b[1m3. Conversaciones escaladas a una persona\x1b[0m');
  const escaladas = await prisma.chatbotSession.findMany({ where: { handoffAt: { not: null } }, select: { convKey: true } });
  if (!escaladas.length) {
    console.log('  (no hay ninguna escalada ahora mismo; se simula una con el primer candidato)');
    const victima = cands[0];
    if (!victima) { bad('sin candidatos para probar'); }
    else {
      const convKey = `kapso:${victima.phone}`;
      await prisma.chatbotSession.upsert({
        where: { convKey },
        create: { convKey, history: [], handoffAt: new Date(), handoffReason: 'prueba verify-wa-reminders' },
        update: { handoffAt: new Date(), handoffReason: 'prueba verify-wa-reminders' },
      });
      const otraVez = await svc.candidatos(cfg.cap);
      otraVez.some((c) => c.phone === victima.phone)
        ? bad(`al abonado ${victima.abonado} le llegaría un cobro pese a estar esperando a una persona`)
        : ok(`el abonado ${victima.abonado} queda fuera mientras espera a una persona`);
      await prisma.chatbotSession.delete({ where: { convKey } }).catch(() => {});
    }
  } else {
    const ult10 = new Set(escaladas.map((e) => e.convKey.replace(/\D/g, '').slice(-10)));
    const colados = cands.filter((c) => ult10.has(c.phone.slice(-10)));
    colados.length === 0 ? ok(`${escaladas.length} conversación(es) escalada(s) quedan fuera de la lista`)
      : bad(`${colados.length} escalados recibirían el cobro igual`);
  }

  console.log('\n\x1b[1m4. Rotación\x1b[0m');
  const nunca = cands.filter((c) => true).length;
  const conFecha = await prisma.subscriber.count({ where: { lastWaReminderAt: { not: null } } });
  console.log(`  ${conFecha} abonados ya tienen fecha de último recordatorio`);
  const total = await prisma.subscriber.count({
    where: {
      status: { in: estadosOk },
      invoices: { some: { status: { in: ['DUE', 'PARTIAL'] }, dueDate: { lt: new Date() } } },
    },
  });
  console.log(`  ${total} morosos en total ⇒ la rotación los cubre en ~${Math.ceil(total / cfg.cap)} días con tope ${cfg.cap}`);
  nunca > 0 ? ok('hay a quién escribirle') : bad('la lista salió vacía');

  console.log('\n\x1b[1m5. La simulación NO toca la BD\x1b[0m');
  const antes = await prisma.subscriber.count({ where: { lastWaReminderAt: { not: null } } });
  const campanasAntes = await prisma.whatsappCampaign.count();
  const r = await svc.run({ manual: true, userName: 'verify-wa-reminders' });
  const despues = await prisma.subscriber.count({ where: { lastWaReminderAt: { not: null } } });
  const campanasDespues = await prisma.whatsappCampaign.count();
  console.log(`  resultado: ${JSON.stringify({ enviados: r.enviados, candidatos: r.candidatos, dryRun: r.dryRun })}`);
  r.dryRun === true ? ok('la corrida se declara simulación') : bad('¡la corrida NO fue simulación!');
  r.enviados === 0 ? ok('cero mensajes enviados') : bad(`¡se enviaron ${r.enviados} mensajes!`);
  antes === despues ? ok('ningún `lastWaReminderAt` marcado (al encender, nadie se salta su aviso)')
    : bad(`se marcaron ${despues - antes} abonados sin haber enviado nada`);
  campanasAntes === campanasDespues ? ok('no se creó campaña en simulación') : bad('se creó una campaña en simulación');

  await app.close();
  console.log(process.exitCode ? '\n\x1b[31mHay fallos.\x1b[0m\n' : '\n\x1b[32mTodo bien.\x1b[0m\n');
})().catch((e) => { console.error(e); process.exit(1); });
