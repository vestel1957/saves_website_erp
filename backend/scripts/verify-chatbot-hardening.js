/**
 * Verifica lo que se le añadió al bot para que aguante producción:
 *   1. la sesión sobrevive a un reinicio (SessionStore en Prisma),
 *   2. la deduplicación de mensajes es a prueba de carreras,
 *   3. el escalamiento a humano calla al bot en esa conversación,
 *   4. el tope de tokens lo apaga y el `status` no miente,
 *   5. el timeout del LLM está puesto.
 *
 * Usa claves de conversación de prueba (`kapso:99000000xx`) y las borra al terminar.
 * No enciende el motor ni gasta LLM.
 *
 *   node scripts/verify-chatbot-hardening.js
 */
process.env.WA_AGENT_ENABLED = 'false';

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/src/app.module');
const { ChatbotSessionStore } = require('../dist/src/chatbot/chatbot-session.store');
const { ChatbotUsageService, CHATBOT_BUDGET_KEY } = require('../dist/src/chatbot/chatbot-usage.service');
const { ChatbotGateService, CHATBOT_ENABLED_KEY, CHATBOT_ALLOWLIST_KEY } = require('../dist/src/chatbot/chatbot-gate.service');
const { ChatbotService } = require('../dist/src/chatbot/chatbot.service');
const { PrismaService } = require('../dist/src/prisma/prisma.service');

let n = 0, bad = 0;
const ok = (m) => { n++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const no = (m) => { n++; bad++; console.log(`  \x1b[31m✗ ${m}\x1b[0m`); };
const is = (c, m) => (c ? ok(m) : no(m));

const TEL = '9900000011';
const CONV = `kapso:${TEL}`;
const AJUSTES = [CHATBOT_ENABLED_KEY, CHATBOT_ALLOWLIST_KEY, CHATBOT_BUDGET_KEY];

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const store = app.get(ChatbotSessionStore);
  const usage = app.get(ChatbotUsageService);
  const gate = app.get(ChatbotGateService);
  const chatbot = app.get(ChatbotService);

  const previos = await prisma.appSetting.findMany({ where: { key: { in: AJUSTES } } });
  const restaurar = async () => {
    await prisma.$transaction([
      prisma.appSetting.deleteMany({ where: { key: { in: AJUSTES } } }),
      ...previos.map((p) => prisma.appSetting.create({
        data: { key: p.key, value: p.value, group: p.group, secret: p.secret, updatedBy: p.updatedBy },
      })),
    ]);
  };
  const limpiar = async () => {
    await prisma.chatbotSession.deleteMany({ where: { convKey: { startsWith: 'kapso:990000' } } });
    await prisma.chatbotSeenMessage.deleteMany({ where: { messageId: { startsWith: 'test-' } } });
    await prisma.chatbotUsage.deleteMany({ where: { model: 'modelo-de-prueba' } });
  };

  try {
    await limpiar();

    console.log('\n1) La sesión sobrevive a un reinicio');
    await store.setHistory(CONV, [{ role: 'user', content: 'hola' }]);
    is((await store.getHistory(CONV)).length === 1, 'el historial se guarda y se lee de la BD');

    const pend = { tool: 'cortar_servicio', commitInput: { subscriberId: 'x' }, summary: 'Cortar el servicio de X', permission: 'area.tecnicos', createdAt: Date.now() };
    await store.setPending(CONV, pend);
    // Un store nuevo = lo que vería el proceso tras un `pm2 restart`.
    const otro = new ChatbotSessionStore(prisma);
    const leido = await otro.getPending(CONV);
    is(leido?.tool === 'cortar_servicio' && leido?.summary === pend.summary,
      'otra instancia ve la confirmación pendiente (sobrevive al reinicio y sirve en cluster)');
    await store.setPending(CONV, null);
    is((await store.getPending(CONV)) === null, 'la pendiente se limpia');

    console.log('\n2) Deduplicación de mensajes');
    is((await store.seen('test-a')) === false, 'un id nuevo NO estaba visto');
    is((await store.seen('test-a')) === true, 'el mismo id ya figura como visto (reintento de Kapso ignorado)');
    const carrera = await Promise.all([store.seen('test-race'), store.seen('test-race'), store.seen('test-race')]);
    is(carrera.filter((x) => x === false).length === 1,
      `en carrera, exactamente 1 de 3 pasa (got ${carrera.filter((x) => x === false).length})`);

    console.log('\n3) Escalamiento a una persona');
    await gate.setEnabled(true, 'verify');
    await gate.setAllowlist([], 'verify');
    is((await gate.shouldHandle(TEL)).ok === true, 'antes de escalar, el bot atiende');
    await store.setHandoff(CONV, 'quiere hablar con alguien');
    const tras = await gate.shouldHandle(TEL);
    is(tras.ok === false, 'tras escalar, el bot NO atiende esa conversación');
    is(/escalada|persona/i.test(tras.reason ?? ''), `y dice por qué: "${tras.reason}"`);
    const cola = await store.listHandoffs();
    is(cola.some((h) => h.convKey === CONV), 'aparece en la cola de conversaciones por atender');
    is((await gate.shouldHandle('9900000099')).ok === true, 'el escalamiento NO afecta a otras conversaciones');
    await store.clearHandoff(CONV);
    is((await gate.shouldHandle(TEL)).ok === true, 'al liberarla, el bot vuelve');

    console.log('\n4) La escalada manda sobre la lista blanca');
    await gate.setAllowlist([TEL], 'verify');
    await store.setHandoff(CONV, 'x');
    is((await gate.shouldHandle(TEL)).ok === false, 'aunque esté en la lista blanca, escalada = el bot calla');
    await store.clearHandoff(CONV);
    await gate.setAllowlist([], 'verify');

    console.log('\n5) Tope de tokens');
    await usage.setBudget(0, 'verify');
    is((await usage.exceeded()) === false, 'sin tope configurado no se bloquea nada');
    await prisma.chatbotUsage.create({
      data: { day: new Date(new Date().toISOString().slice(0, 10)), model: 'modelo-de-prueba', inputTokens: 900, outputTokens: 200, requests: 3 },
    });
    await usage.setBudget(1000, 'verify');
    is((await usage.exceeded()) === true, '1100 tokens gastados contra un tope de 1000 → excedido');
    is((await gate.shouldHandle(TEL)).ok === false, 'y el gate deja de atender (no se gasta un token más)');
    await usage.setBudget(100000, 'verify');
    is((await usage.exceeded()) === false, 'subiendo el tope, vuelve a atender');
    const resumen = await usage.summary();
    is(resumen.hoy >= 1100, `el resumen cuenta los tokens de hoy (${resumen.hoy})`);

    console.log('\n6) El status sigue sin mentir');
    const st = await chatbot.status();
    is(typeof st.uso?.hoy === 'number', 'status expone el consumo');
    is(st.operativo === false, `operativo=false (Kapso: ${st.whatsapp.error ?? 'ok'})`);
    await usage.setBudget(1000, 'verify');
    const st2 = await chatbot.status();
    is(st2.operativo === false && st2.uso.excedido === true, 'con el tope superado, operativo=false');

    console.log('\n7) Timeout del LLM');
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/chatbot/chatbot.service.ts'), 'utf8');
    is(/timeout:\s*Number\(process\.env\.WHATSAPP_BOT_TIMEOUT_MS/.test(src), 'el cliente de OpenAI lleva timeout explícito');
    is(/maxRetries:\s*1/.test(src), 'y reintentos acotados (antes: 10 min x 2 = ~30 min colgado)');
  } finally {
    console.log('\n=== Limpieza ===');
    await limpiar();
    await restaurar();
    const resto = await prisma.chatbotSession.count({ where: { convKey: { startsWith: 'kapso:990000' } } });
    is(resto === 0, 'sin residuos');
    await app.close();
  }
  console.log(`\n${bad ? '\x1b[31m' : '\x1b[32m'}${n - bad}/${n} asserts\x1b[0m\n`);
  process.exit(bad ? 1 : 0);
})();
