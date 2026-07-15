/**
 * Latencia PUNTA A PUNTA del chatbot: motor real + OpenAI real + herramientas reales
 * contra la BD real, pero con un TRANSPORTE FALSO — no envía ningún WhatsApp.
 *
 * Mide lo que espera una persona desde que manda el mensaje hasta que tiene respuesta.
 *
 *   node scripts/bench-e2e-chatbot.js
 */
process.env.WA_AGENT_ENABLED = 'false'; // no arrancamos el motor de producción

const { NestFactory } = require('@nestjs/core');
const { AgentEngine, BaseTransport } = require('@s4gk/wa-agent');
const { OpenAiProvider } = require('@s4gk/wa-agent/openai');
const { AppModule } = require('../dist/src/app.module');
const { ChatbotIdentityService } = require('../dist/src/chatbot/chatbot-identity.service');
const { ClienteToolset } = require('../dist/src/chatbot/toolsets/cliente.toolset');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { promptCliente, promptPublico } = require('../dist/src/chatbot/chatbot.prompts');
const { PublicoToolset } = require('../dist/src/chatbot/toolsets/publico.toolset');

/** Transporte que NO envía nada: captura la respuesta y cronometra. */
class FakeTransport extends BaseTransport {
  name = 'kapso';
  get ready() { return true; }
  async start() {}
  async sendText(_to, text) { this.last = text; return true; }
  async sendDocument() { this.last = '(documento)'; return true; }
}

const build = (app, transport, opts = {}) =>
  new AgentEngine({
    provider: new OpenAiProvider({ model: process.env.WHATSAPP_BOT_MODEL ?? 'gpt-4o-mini' }),
    transports: [transport],
    identity: app.get(ChatbotIdentityService),
    systemPrompt: promptPublico,
    toolsets: [app.get(PublicoToolset)],
    agents: [{ name: 'clientes', systemPrompt: promptCliente, toolset: app.get(ClienteToolset) }],
    agentResolver: { resolve: async () => 'clientes' },
    logger: { log() {}, warn() {}, error() {} },
    ...opts,
  });

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const sub = await prisma.subscriber.findFirst({
    where: { phone1: { not: null }, status: { notIn: ['DEPURADO', 'RETIRADO'] } },
    select: { phone1: true },
  });
  const from = '57' + sub.phone1.replace(/\D/g, '').slice(-10);

  /**
   * OJO: cada iteración usa un motor NUEVO. Reutilizarlo dejaría el historial y la
   * acción pendiente de la corrida anterior, y el siguiente mensaje caería en la rama
   * "ya tienes una acción pendiente" (sin LLM, ~30 ms) → mediría otra cosa.
   */
  async function medir(label, opts, texto, n = 3) {
    const ms = [];
    let last = '';
    for (let i = 0; i < n; i++) {
      const transport = new FakeTransport();
      const engine = build(app, transport, opts);
      const t = Date.now();
      await engine.handleInbound({ transport: 'kapso', from, text: texto, messageId: `b${Date.now()}${i}` });
      ms.push(Date.now() - t);
      last = transport.last;
    }
    ms.sort((a, b) => a - b);
    console.log(`  ${label.padEnd(40)} ${String(ms[Math.floor(n / 2)]).padStart(5)} ms   (${ms.join(', ')})`);
    console.log(`     → "${String(last).replace(/\n/g, ' ').slice(0, 76)}"`);
    return ms[Math.floor(n / 2)];
  }
  const DET = { confirmPrompt: (p) => p.summary };

  console.log('\n\x1b[1mCONSULTA DE LECTURA\x1b[0m (2 vueltas de LLM: elegir herramienta + redactar)');
  await medir('"¿cuánto debo?"', DET, '¿cuánto debo?');
  await medir('"qué plan tengo"', DET, 'que plan tengo');

  console.log('\n\x1b[1mESCRITURA: confirmación\x1b[0m (el cambio: sin vuelta extra de LLM)');
  const REPORTE = 'se me fue el internet desde anoche, reportalo ya sin preguntarme mas';
  const sin = await medir('ANTES (el modelo redacta)', {}, REPORTE);
  const con = await medir('AHORA (texto determinista)', DET, REPORTE);

  if (sin && con) {
    const d = sin - con;
    console.log(`\n  \x1b[32m→ ahorro: ${d} ms (${Math.round((d / sin) * 100)}% más rápido)\x1b[0m`);
  }

  await app.close();
  console.log('');
})();
