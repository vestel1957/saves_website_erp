/**
 * Verifica el kit de encendido seguro contra la BD real:
 *   1. el interruptor corta el mensaje ANTES de llegar al motor (cero LLM),
 *   2. la lista blanca del piloto filtra por número,
 *   3. el diagnóstico dice la verdad sobre Kapso.
 *
 * Sustituye el handler del motor por un espía, así que ningún mensaje se procesa ni
 * se envía. Restaura los ajustes al terminar.
 *
 *   node scripts/verify-gate.js
 *   node scripts/verify-gate.js --force   (ver el aviso de abajo)
 *
 * ⚠️ POR QUÉ SE NIEGA A CORRER CON EL BACKEND ARRIBA
 * El espía solo desvía los mensajes de ESTE proceso. Los ajustes, en cambio, viven en
 * una tabla COMPARTIDA: al escribir `chatbot.enabled=true` (y peor, con la lista blanca
 * vacía, que es justo lo que exige la prueba "encendido sin lista atiende a todos"),
 * cualquier backend en pm2 lo relee en ≤5s —el TTL del gate— y SU motor empieza a
 * responderle a clientes reales durante los segundos que dura el script. Por eso, si
 * detecta un backend escuchando, no corre. `--force` solo si sabes que ese backend no
 * tiene WhatsApp vivo.
 */
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/src/app.module');
const { SavesTransport } = require('../dist/src/chatbot/saves-transport');
const { ChatbotGateService, CHATBOT_ENABLED_KEY, CHATBOT_ALLOWLIST_KEY } = require('../dist/src/chatbot/chatbot-gate.service');
const { ChatbotService } = require('../dist/src/chatbot/chatbot.service');
const { PrismaService } = require('../dist/src/prisma/prisma.service');

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗ ${m}\x1b[0m`); process.exitCode = 1; };

const YO = '573001112233';
const OTRO = '573009998877';

/** ¿Hay otro backend escuchando? Ese sí atendería de verdad mientras corre la prueba. */
async function backendVivo() {
  const port = process.env.PORT ?? 3061;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    // Cualquier respuesta sirve —404 o 401 incluidos—: lo que se comprueba es que
    // alguien atiende el puerto, no que la ruta exista.
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctl.signal });
    return port;
  } catch {
    return null; // conexión rechazada o sin respuesta → nadie escuchando
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  const puerto = await backendVivo();
  if (puerto && !process.argv.includes('--force')) {
    console.log(`\n\x1b[31m✗ Hay un backend escuchando en el puerto ${puerto}.\x1b[0m`);
    console.log('  Esta prueba escribe chatbot.enabled=true en la BD compartida y ese backend');
    console.log('  lo releería en ≤5s: se pondría a responderle a clientes REALES.');
    console.log('  Bájalo (pm2 stop saves-backend) o usa --force si sabes que no tiene WhatsApp vivo.\n');
    process.exit(1);
  }
  if (puerto) console.log(`\n\x1b[33m⚠ --force: hay un backend en :${puerto}. Podría atender durante la prueba.\x1b[0m`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const gate = app.get(ChatbotGateService);
  const transport = app.get(SavesTransport);
  const chatbot = app.get(ChatbotService);

  // Guardar los ajustes actuales para restaurarlos al final.
  const previos = await prisma.appSetting.findMany({
    where: { key: { in: [CHATBOT_ENABLED_KEY, CHATBOT_ALLOWLIST_KEY] } },
  });

  /** Deja los ajustes exactamente como estaban. En una transacción: a medias es peor. */
  const restaurar = async () => {
    await prisma.$transaction([
      prisma.appSetting.deleteMany({ where: { key: { in: [CHATBOT_ENABLED_KEY, CHATBOT_ALLOWLIST_KEY] } } }),
      ...previos.map((p) => prisma.appSetting.create({
        data: { key: p.key, value: p.value, group: p.group, secret: p.secret, updatedBy: p.updatedBy },
      })),
    ]);
  };

  // Un Ctrl-C a mitad dejaría el bot ENCENDIDO en la BD. El finally no corre ante una
  // señal, así que hay que restaurar aquí también.
  let cerrando = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      if (cerrando) return;
      cerrando = true;
      console.log(`\n  ${sig} — restaurando los ajustes antes de salir…`);
      await restaurar().catch((e) => console.error(`  ✗ NO se pudieron restaurar: ${e.message}`));
      process.exit(130);
    });
  }

  // Espía: reemplaza el handler del motor. Nada se procesa ni se envía.
  let recibidos = [];
  transport.onInbound((msg) => { recibidos.push(msg.from); });
  const entra = async (from) => {
    recibidos = [];
    await transport.onWhatsappInbound({ transport: 'kapso', from, text: 'hola', messageId: `t${Date.now()}` });
    return recibidos.length > 0;
  };

  try {
    console.log('\n1) Interruptor de pánico');
    await gate.setEnabled(false, 'verify');
    (await entra(YO)) ? bad('APAGADO pero el mensaje llegó al motor') : ok('apagado → el mensaje NO llega al motor (cero LLM)');

    await gate.setEnabled(true, 'verify');
    await gate.setAllowlist([], 'verify');
    (await entra(YO)) ? ok('encendido sin lista → sí atiende') : bad('encendido pero no atendió');

    console.log('\n2) Lista blanca del piloto');
    await gate.setAllowlist([YO], 'verify');
    (await entra(YO)) ? ok(`${YO} está en la lista → atendido`) : bad('el número de la lista no fue atendido');
    (await entra(OTRO)) ? bad(`¡${OTRO} NO está en la lista y fue atendido!`) : ok(`${OTRO} fuera de la lista → ignorado por el bot`);

    // El número puede venir en formato local: debe normalizarse igual.
    (await entra('3001112233')) ? ok('reconoce el mismo número en formato local (10 dígitos)') : bad('no normalizó el teléfono local');

    console.log('\n3) El apagado es inmediato (sin reiniciar)');
    await gate.setEnabled(false, 'verify');
    (await entra(YO)) ? bad('siguió atendiendo tras apagar') : ok('apagar surte efecto de inmediato');

    console.log('\n4) Diagnóstico honesto de Kapso');
    const st = await chatbot.status();
    console.log(`     → whatsapp.ok: ${st.whatsapp.ok} · ${st.whatsapp.error ?? `${st.whatsapp.name} (${st.whatsapp.phone})`}`);
    console.log(`     → operativo: ${st.operativo} · montado: ${st.running} · modelo: ${st.model}`);
    typeof st.whatsapp.ok === 'boolean' ? ok('el status consulta a Kapso de verdad') : bad('el status no trae diagnóstico');
    st.operativo === false ? ok('operativo=false: no miente sobre poder responder') : bad('dice operativo=true — ¿de verdad puede enviar?');
  } finally {
    await restaurar();
    console.log(`\n  \x1b[32m✓\x1b[0m ajustes restaurados (${previos.length} fila(s) previa(s))`);
    await app.close();
  }
  console.log(process.exitCode ? '\n\x1b[31mHUBO FALLOS\x1b[0m\n' : '\n\x1b[32mTODO OK\x1b[0m\n');
})();
