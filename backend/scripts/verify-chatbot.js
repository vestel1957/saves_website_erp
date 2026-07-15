/**
 * Verificación del agente de WhatsApp contra la BD real.
 *
 * Arranca el contexto de Nest SIN encender el motor (WA_AGENT_ENABLED=false), así
 * que no manda mensajes ni consume LLM: ejercita la identidad (que decide qué agente
 * atiende) y las herramientas de lectura de cada agente.
 *
 *   node scripts/verify-chatbot.js
 */
process.env.WA_AGENT_ENABLED = 'false';

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/src/app.module');
const { ChatbotIdentityService } = require('../dist/src/chatbot/chatbot-identity.service');
const { ChatbotLinkService } = require('../dist/src/chatbot/chatbot-link.service');
const { PublicoToolset } = require('../dist/src/chatbot/toolsets/publico.toolset');
const { ClienteToolset } = require('../dist/src/chatbot/toolsets/cliente.toolset');
const { InternoAbonadosToolset } = require('../dist/src/chatbot/toolsets/interno-abonados.toolset');
const { PrismaService } = require('../dist/src/prisma/prisma.service');

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗ ${m}\x1b[0m`); process.exitCode = 1; };

/** ToolContext falso: el motor lo arma en producción; aquí se simula. */
const ctx = (user, over = {}) => ({
  user,
  convKey: `kapso:${user.id}`,
  committing: false,
  can: (p) => user.permissions.includes(p) || user.permissions.includes('system.admin'),
  canStrict: (p) => user.permissions.includes(p),
  preparePending: (a) => `PREPARADO: ${a.summary}`,
  sendDocument: async () => true,
  audit: async () => {},
  ...over,
});

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const identity = app.get(ChatbotIdentityService);
  const links = app.get(ChatbotLinkService);

  try {
    // ── 1. Identidad: número desconocido → público ──────────────────
    console.log('\n1) Identidad');
    const anon = await identity.resolveUser('573009998877');
    anon?.meta?.identity?.kind === 'publico'
      ? ok(`desconocido → agente público (${anon.name})`)
      : bad(`desconocido → esperaba 'publico', obtuve '${anon?.meta?.identity?.kind}'`);

    // ── 2. Identidad: abonado real por su teléfono ──────────────────
    const sub = await prisma.subscriber.findFirst({
      where: { phone1: { not: null }, status: { notIn: ['DEPURADO', 'RETIRADO'] } },
      select: { id: true, abonado: true, phone1: true },
    });
    if (!sub) return bad('No hay abonados con teléfono en la BD para probar');

    const cli = await identity.resolveUser(sub.phone1);
    cli?.meta?.identity?.kind === 'cliente'
      ? ok(`abonado ${sub.abonado} (${sub.phone1}) → agente clientes (${cli.name})`)
      : bad(`abonado ${sub.phone1} → esperaba 'cliente', obtuve '${cli?.meta?.identity?.kind}'`);

    if (cli?.meta?.identity?.subscriberId !== sub.id) {
      bad('el subscriberId resuelto NO es el del teléfono: fuga de cuenta ajena');
    } else ok('el subscriberId resuelto corresponde al dueño del teléfono');

    // ── 3. Identidad: funcionario vinculado → interno + RBAC ────────
    const user = await prisma.user.findFirst({
      where: { isActive: true, whatsappPhone: null },
      select: { id: true, name: true },
    });
    const TEL = '573001234567';
    let linked = false;
    if (user) {
      await links.link(user.id, TEL);
      linked = true;
      const it = await identity.resolveUser(TEL);
      const kind = it?.meta?.identity?.kind;
      kind === 'interno'
        ? ok(`funcionario ${user.name} vinculado a ${TEL} → agente interno`)
        : bad(`funcionario → esperaba 'interno', obtuve '${kind}'`);
      it?.permissions?.length
        ? ok(`hereda ${it.permissions.length} permisos del ERP (ej. ${it.permissions.slice(0, 3).join(', ')})`)
        : bad('el funcionario no heredó permisos del ERP');

      // El agente interno de un usuario sin áreas no debe ver herramientas.
      const abonadosTs = app.get(InternoAbonadosToolset);
      const sinPermisos = { id: 'x', name: 'Pelado', permissions: [], meta: { identity: { kind: 'interno', authUser: {} } } };
      const defs = abonadosTs.definitions(ctx(sinPermisos));
      defs.length === 0
        ? ok('un funcionario sin áreas no ve NINGUNA herramienta de abonados')
        : bad(`un funcionario sin áreas vio ${defs.length} herramientas`);
    }

    // ── 4. Toolset público: solo info comercial ─────────────────────
    console.log('\n2) Agente público');
    const pub = app.get(PublicoToolset);
    const pubDefs = pub.definitions(ctx(anon)).map((d) => d.name);
    ok(`herramientas: ${pubDefs.join(', ')}`);
    pubDefs.every((n) => ['planes_disponibles', 'sedes', 'datos_empresa'].includes(n))
      ? ok('ninguna herramienta pública toca datos de cuenta')
      : bad('el agente público expone algo que no es info comercial');
    const planes = await pub.execute('planes_disponibles', {}, ctx(anon));
    console.log(`     → planes: ${planes.split('\n')[0]}`);
    planes.includes('$') ? ok('devuelve planes reales con precio') : bad(`respuesta inesperada: ${planes}`);

    // ── 5. Toolset cliente: sobre SU cuenta ────────────────────────
    console.log('\n3) Agente clientes');
    const cliTs = app.get(ClienteToolset);
    const estado = await cliTs.execute('mi_estado_de_cuenta', {}, ctx(cli));
    console.log(`     → estado de cuenta: ${estado.split('\n')[0]}`);
    estado.length > 0 && !estado.startsWith('No se pudo')
      ? ok('estado de cuenta resuelto desde el teléfono, sin pedir identificación')
      : bad(`estado de cuenta falló: ${estado}`);

    const plan = await cliTs.execute('mi_plan', {}, ctx(cli));
    console.log(`     → plan: ${plan.split('\n').slice(0, 2).join(' / ')}`);

    // Un cliente NO puede usar herramientas internas aunque se las pidan.
    const abonadosTs = app.get(InternoAbonadosToolset);
    const fuga = await abonadosTs.execute('buscar_abonado', { q: 'a' }, ctx(cli));
    fuga === 'PERMISO_DENEGADO'
      ? ok('un cliente que invoca una herramienta interna recibe PERMISO_DENEGADO')
      : bad(`¡FUGA! un cliente ejecutó buscar_abonado y obtuvo: ${String(fuga).slice(0, 80)}`);

    // ── 6. Escritura: prepara, no ejecuta ──────────────────────────
    console.log('\n4) Confirmación de escrituras');
    const falla = await cliTs.execute('reportar_falla', { descripcion: 'prueba' }, ctx(cli));
    falla.startsWith('PREPARADO')
      ? ok('reportar_falla PREPARA y espera confirmación (no crea el ticket solo)')
      : bad(`reportar_falla no pidió confirmación: ${falla}`);

    // Limpieza del vínculo de prueba.
    if (linked) {
      await links.unlink(user.id);
      ok('vínculo de prueba deshecho');
    }
  } finally {
    await app.close();
  }
  console.log(process.exitCode ? '\n\x1b[31mHUBO FALLOS\x1b[0m\n' : '\n\x1b[32mTODO OK\x1b[0m\n');
})();
