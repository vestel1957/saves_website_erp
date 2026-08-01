/**
 * Simula que alguien le escribe al WhatsApp del negocio y muestra qué contestaría el
 * bot — SIN mandar ningún mensaje real.
 *
 * Es el motor de producción entero: la misma identidad (que decide si quien escribe es
 * funcionario, abonado o desconocido), los mismos prompts, los mismos toolsets contra
 * la BD real y OpenAI de verdad. Lo único falso es el transporte: la respuesta se
 * imprime en pantalla en vez de salir por Kapso. Sirve para probar cambios de prompt o
 * de herramientas sin gastarle un mensaje a nadie ni depender de que el webhook entre.
 *
 * Consume tokens de OpenAI (unos pocos céntimos con gpt-4o-mini).
 *
 *   node scripts/simular-chat.js                          → batería por defecto
 *   node scripts/simular-chat.js 573215642425 "hola"      → un caso suelto
 *
 * Ojo: cada caso usa un MOTOR NUEVO. Reutilizarlo arrastra el historial y la acción
 * pendiente del caso anterior, y el siguiente mensaje cae en la rama "ya tienes una
 * acción pendiente" sin llegar a pensar nada.
 */
process.env.WA_AGENT_ENABLED = 'false'; // que no se monte el motor de producción

const { NestFactory } = require('@nestjs/core');
const { AgentEngine, BaseTransport } = require('@s4gk/wa-agent');
const { OpenAiProvider } = require('@s4gk/wa-agent/openai');
const { AppModule } = require('../dist/src/app.module');
const { ChatbotIdentityService } = require('../dist/src/chatbot/chatbot-identity.service');
const { ChatbotSessionStore } = require('../dist/src/chatbot/chatbot-session.store');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { promptCliente, promptInterno, promptPublico } = require('../dist/src/chatbot/chatbot.prompts');
const { combineToolsets } = require('../dist/src/chatbot/toolsets/toolset.util');
const { PublicoToolset } = require('../dist/src/chatbot/toolsets/publico.toolset');
const { ClienteToolset } = require('../dist/src/chatbot/toolsets/cliente.toolset');
const { InternoAbonadosToolset } = require('../dist/src/chatbot/toolsets/interno-abonados.toolset');
const { InternoTicketsToolset } = require('../dist/src/chatbot/toolsets/interno-tickets.toolset');
const { InternoRedToolset } = require('../dist/src/chatbot/toolsets/interno-red.toolset');
const { InternoInventarioToolset } = require('../dist/src/chatbot/toolsets/interno-inventario.toolset');
const { InternoCajaToolset } = require('../dist/src/chatbot/toolsets/interno-caja.toolset');
const { InternoReportesToolset } = require('../dist/src/chatbot/toolsets/interno-reportes.toolset');
const { InternoRrhhToolset } = require('../dist/src/chatbot/toolsets/interno-rrhh.toolset');
const { InternoComprasToolset } = require('../dist/src/chatbot/toolsets/interno-compras.toolset');
const { InternoFacturacionToolset } = require('../dist/src/chatbot/toolsets/interno-facturacion.toolset');
const { InternoCobranzaToolset } = require('../dist/src/chatbot/toolsets/interno-cobranza.toolset');
const { InternoOperacionToolset } = require('../dist/src/chatbot/toolsets/interno-operacion.toolset');
const { InternoDatosToolset } = require('../dist/src/chatbot/toolsets/interno-datos.toolset');

const AGENTES = { interno: 'soporte-interno', cliente: 'clientes', publico: 'publico' };

/** `--debug` muestra el razonamiento del motor (herramientas elegidas y sus errores). */
const DEBUG = process.argv.includes('--debug');
/** `--seguir` conserva el historial previo, para simular el 2.º mensaje de un hilo. */
const MANTENER = process.argv.includes('--seguir');

/** Transporte que no habla con Kapso: se queda con lo que el bot quiso responder. */
class TransporteFalso extends BaseTransport {
  constructor() {
    super();
    this.name = 'kapso';
    this.enviados = [];
  }
  get ready() { return true; }
  async start() {}
  async sendText(_to, text) { this.enviados.push(text); return true; }
  async sendDocument(_to, _buf, fileName) { this.enviados.push(`[documento adjunto: ${fileName}]`); return true; }
}

/**
 * Con --debug, envuelve un toolset para ver QUÉ herramientas se le ofrecen al modelo,
 * cuál eligió y qué le devolvió. Es la única forma de distinguir "la herramienta no
 * existe para este usuario" de "la herramienta falló" cuando el bot dice "no puedo".
 */
function espiar(toolset) {
  if (!DEBUG) return toolset;
  return {
    definitions: (ctx) => {
      const defs = toolset.definitions(ctx);
      console.log(`   \x1b[2m· se le ofrecen ${defs.length}: ${defs.map((d) => d.name).join(', ')}\x1b[0m`);
      return defs;
    },
    execute: async (name, input, ctx) => {
      const r = await toolset.execute(name, input, ctx);
      console.log(`   \x1b[2m· ${name}(${JSON.stringify(input)}) → ${String(r).replace(/\n/g, ' ').slice(0, 120)}\x1b[0m`);
      return r;
    },
  };
}

function construir(app, transporte) {
  const interno = combineToolsets(
    app.get(InternoAbonadosToolset), app.get(InternoTicketsToolset), app.get(InternoRedToolset),
    app.get(InternoInventarioToolset), app.get(InternoCajaToolset), app.get(InternoReportesToolset),
      app.get(InternoRrhhToolset), app.get(InternoComprasToolset),
      app.get(InternoFacturacionToolset), app.get(InternoCobranzaToolset), app.get(InternoOperacionToolset),
      // OJO: esta lista es GEMELA de la de chatbot.service.ts. Si se añade un toolset
      // allá y no aquí, el simulador prueba un bot que no existe — pasó con el de
      // datos y el resultado fue creer que el modelo ignoraba unas herramientas que
      // en realidad nunca se le ofrecieron.
      app.get(InternoDatosToolset),
  );
  const identity = app.get(ChatbotIdentityService);
  return new AgentEngine({
    provider: new OpenAiProvider({ model: process.env.WHATSAPP_BOT_MODEL ?? 'gpt-4o-mini' }),
    transports: [transporte],
    identity,
    store: app.get(ChatbotSessionStore),
    systemPrompt: promptPublico,
    toolsets: [app.get(PublicoToolset)],
    agents: [
      { name: AGENTES.interno, systemPrompt: promptInterno, toolset: espiar(interno) },
      { name: AGENTES.cliente, systemPrompt: promptCliente, toolset: espiar(app.get(ClienteToolset)) },
      { name: AGENTES.publico, systemPrompt: promptPublico, toolset: espiar(app.get(PublicoToolset)) },
    ],
    agentResolver: {
      resolve: async (user) => {
        const kind = user.meta.identity.kind;
        return kind === 'interno' ? AGENTES.interno : kind === 'cliente' ? AGENTES.cliente : AGENTES.publico;
      },
    },
    confirmPrompt: (pending) => pending.summary,
    // Con --debug se ve qué herramienta eligió el modelo y qué le devolvió: sin eso,
    // un "tuve un problema" del bot no se puede diagnosticar.
    logger: DEBUG
      ? { log: (m) => console.log(`   \x1b[2m· ${m}\x1b[0m`), warn: (m) => console.log(`   \x1b[33m· ${m}\x1b[0m`), error: (m) => console.log(`   \x1b[31m· ${m}\x1b[0m`) }
      : { log() {}, warn() {}, error() {} },
  });
}

const COLOR = { interno: '\x1b[36m', cliente: '\x1b[35m', publico: '\x1b[33m' };

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const identity = app.get(ChatbotIdentityService);

  const [telArg, ...restoArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  let casos;

  if (telArg) {
    casos = [{ titulo: 'caso indicado', from: telArg.replace(/\D/g, ''), texto: restoArg.join(' ') || 'hola' }];
  } else {
    // Un número de cada tipo, sacados de la BD real para que la simulación no dependa
    // de datos inventados que mañana ya no existan.
    const funcionario = await prisma.user.findFirst({
      where: { whatsappPhone: { not: null }, isActive: true },
      select: { name: true, whatsappPhone: true },
      orderBy: { name: 'asc' },
    });
    const abonado = await prisma.subscriber.findFirst({
      where: { phone1: { not: null }, status: 'ACTIVO' },
      select: { fullName: true, phone1: true },
    });

    casos = [
      funcionario && {
        titulo: `funcionario · ${funcionario.name}`,
        from: funcionario.whatsappPhone,
        texto: 'hola, quién te está escribiendo?',
      },
      funcionario && {
        titulo: `funcionario · ${funcionario.name} (consulta de trabajo)`,
        from: funcionario.whatsappPhone,
        texto: 'buenas, cuántos tickets de soporte hay abiertos?',
      },
      abonado && {
        titulo: `abonado · ${abonado.fullName}`,
        from: '57' + abonado.phone1.replace(/\D/g, '').slice(-10),
        texto: 'hola, cuánto debo?',
      },
      { titulo: 'desconocido (posible cliente nuevo)', from: '573001234567', texto: 'Quiero conocer los planes sólo internet hogar' },
    ].filter(Boolean);
  }

  console.log('\n\x1b[1mSIMULACIÓN DE CONVERSACIÓN\x1b[0m  (motor y LLM reales · NO se envía ningún WhatsApp)\n');

  const store = app.get(ChatbotSessionStore);

  for (const c of casos) {
    const quien = await identity.resolveUser(c.from);
    const kind = quien.meta.identity.kind;

    // Historial en limpio. El almacén es la BD compartida con producción, así que sin
    // esto la simulación arrastra la conversación anterior: el modelo contesta "SIGO
    // sin poder…" arrastrando un error viejo y uno cree que el arreglo no sirvió.
    if (!MANTENER) {
      await store.setHistory(`kapso:${c.from}`, []);
      await store.setPending(`kapso:${c.from}`, null);
    }

    const transporte = new TransporteFalso();
    const engine = construir(app, transporte);

    const t = Date.now();
    await engine.handleInbound({ transport: 'kapso', from: c.from, text: c.texto, messageId: `sim${Date.now()}` });
    const ms = Date.now() - t;

    console.log(`${COLOR[kind] ?? ''}── ${c.titulo}\x1b[0m`);
    console.log(`   de ${c.from} → identidad: ${kind} (${quien.name}) · ${quien.permissions.length} permisos`);
    console.log(`   \x1b[2m▸ cliente:\x1b[0m ${c.texto}`);
    for (const r of transporte.enviados) console.log(`   \x1b[1m◂ bot:\x1b[0m ${r.split('\n').join('\n          ')}`);
    if (!transporte.enviados.length) console.log('   \x1b[31m◂ bot: (no respondió nada)\x1b[0m');
    console.log(`   \x1b[2m${ms} ms\x1b[0m\n`);
  }

  await app.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
