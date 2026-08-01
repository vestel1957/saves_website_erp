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
const { InternoRedToolset } = require('../dist/src/chatbot/toolsets/interno-red.toolset');
const { InternoTicketsToolset } = require('../dist/src/chatbot/toolsets/interno-tickets.toolset');
const { InternoInventarioToolset } = require('../dist/src/chatbot/toolsets/interno-inventario.toolset');
const { InternoCajaToolset } = require('../dist/src/chatbot/toolsets/interno-caja.toolset');
const { InternoReportesToolset } = require('../dist/src/chatbot/toolsets/interno-reportes.toolset');
const { InternoRrhhToolset } = require('../dist/src/chatbot/toolsets/interno-rrhh.toolset');
const { InternoComprasToolset } = require('../dist/src/chatbot/toolsets/interno-compras.toolset');
const { InternoFacturacionToolset } = require('../dist/src/chatbot/toolsets/interno-facturacion.toolset');
const { InternoCobranzaToolset } = require('../dist/src/chatbot/toolsets/interno-cobranza.toolset');
const { InternoOperacionToolset } = require('../dist/src/chatbot/toolsets/interno-operacion.toolset');
const { combineToolsets } = require('../dist/src/chatbot/toolsets/toolset.util');
const { WhatsappService } = require('../dist/src/common/whatsapp/whatsapp.service');
const { ChatAccessService } = require('../dist/src/chatbot/chat-access.service');
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

  // ── MORDAZA: este script NO puede mandar WhatsApps ──────────────────────────
  // El 2026-07-28 esta verificación le mandó una plantilla REAL a un cliente real:
  // ejercitaba `pedir_acceso_a_una_cuenta`, que avisa al titular. Las credenciales
  // de Kapso son las de producción, así que "probar contra la BD real" incluía
  // escribirle a la gente. Se sustituyen los envíos por un contador ANTES de tocar
  // nada; si alguna prueba intenta enviar, se ve al final y no le llega a nadie.
  const enviosBloqueados = [];
  const wa = app.get(WhatsappService);
  wa.sendText = async (to, text) => { enviosBloqueados.push({ to, text }); return false; };
  wa.sendTemplate = async (to, name) => { enviosBloqueados.push({ to, tpl: name }); return { ok: false, error: 'bloqueado en verificación' }; };
  wa.sendDocument = async (to, _b, f) => { enviosBloqueados.push({ to, doc: f }); return false; };

  const prisma = app.get(PrismaService);
  const identity = app.get(ChatbotIdentityService);
  const links = app.get(ChatbotLinkService);

  // Fuera del try: el vínculo de prueba se hace sobre un funcionario REAL, así que
  // deshacerlo NO puede depender de que el resto del script no lance. Ver el finally.
  let linkedUserId = null;

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
    if (user) {
      await links.link(user.id, TEL);
      linkedUserId = user.id;
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
    pubDefs.every((n) => ['planes_disponibles', 'sedes', 'datos_empresa', 'pedir_acceso_a_una_cuenta', 'validar_mi_identidad'].includes(n))
      ? ok('ninguna herramienta pública toca datos de cuenta')
      : bad('el agente público expone algo que no es info comercial');

    // `pedir_acceso_a_una_cuenta` es la única del agente público que RECIBE un
    // identificador de cliente. Se comprueba lo único que la hace segura: que no
    // devuelva ni un dato de la cuenta, y que responda IGUAL exista o no el abonado
    // — si distinguiera, sería un comprobador gratuito de números de cuenta ajenos.
    const real = await prisma.subscriber.findFirst({
      where: { status: { notIn: ['DEPURADO', 'RETIRADO'] } },
      select: { abonado: true, fullName: true, firstName: true },
    });
    const pideReal = await pub.execute('pedir_acceso_a_una_cuenta', { abonado: real.abonado }, ctx(anon));
    const pideFalso = await pub.execute('pedir_acceso_a_una_cuenta', { abonado: 99999999 }, ctx(anon));
    pideReal === pideFalso
      ? ok('pedir acceso responde IGUAL exista o no el abonado (no confirma cuentas ajenas)')
      : bad('la respuesta cambia según exista el abonado: se puede tantear qué cuentas existen');
    const nombreReal = (real.fullName || real.firstName || '').trim().split(/\s+/)[0] ?? '';
    nombreReal && pideReal.toUpperCase().includes(nombreReal.toUpperCase())
      ? bad(`¡FUGA! pedir acceso soltó el nombre del titular: ${pideReal.slice(0, 80)}`)
      : ok('pedir acceso no revela nada del titular ni de su cuenta');
    const planes = await pub.execute('planes_disponibles', {}, ctx(anon));
    console.log(`     → planes: ${planes.split('\n')[0]}`);
    planes.includes('$') ? ok('devuelve planes reales con precio') : bad(`respuesta inesperada: ${planes}`);

    // La validación por datos es la puerta más delicada del canal: se comprueba que
    // NO se abre con datos inventados y que el error no dice cuál de los tres falló
    // (si lo dijera, se podría afinar por partes hasta entrar).
    const validaFalso = await pub.execute(
      'validar_mi_identidad',
      { documento: '999999999', nombre: 'Fulano De Tal', telefono_titular: '3000000000' },
      ctx(anon),
    );
    /no coinciden|bloquead/i.test(validaFalso)
      ? ok('la validación por datos rechaza datos inventados')
      : bad(`¡FUGA! la validación aceptó datos falsos: ${validaFalso.slice(0, 90)}`);
    /documento|nombre|tel[eé]fono/i.test(validaFalso.replace(/Necesito los tres datos[^.]*\./i, ''))
      ? bad(`el error dice cuál dato falló: ${validaFalso.slice(0, 90)}`)
      : ok('el error no revela cuál de los tres datos falló');

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

    // ── 5b. Diagnóstico "no tengo internet" ────────────────────────
    // Es la consulta más frecuente del canal. Se comprueba que responde con la
    // cuenta de QUIEN escribe y que no se cae cuando la red no está disponible
    // (dry-run del Mikrotik, router mudo, abonado sin PPPoE): un diagnóstico
    // incompleto sirve, una herramienta que revienta deja al cliente sin respuesta.
    const diag = await cliTs.execute('estado_de_mi_servicio', {}, ctx(cli));
    console.log(`     → diagnóstico: ${diag.split('\n').join(' | ').slice(0, 160)}`);
    !diag.startsWith('No se pudo')
      ? ok('estado_de_mi_servicio responde sin pedir identificación ni romperse')
      : bad(`estado_de_mi_servicio falló: ${diag}`);
    /(suspendido|al día|activo|servicio)/i.test(diag)
      ? ok('el diagnóstico dice el estado del servicio en palabras, no en códigos')
      : bad(`el diagnóstico no explica el estado: ${diag}`);

    // ── 5c. Diagnóstico de fibra (interno, para técnicos) ──────────
    console.log('\n3b) Diagnóstico de fibra (agente interno)');
    const redTs = app.get(InternoRedToolset);
    const tecnico = {
      id: 'tec', name: 'Técnico', permissions: ['area.tecnicos'],
      meta: { identity: { kind: 'interno', authUser: { id: 'tec', name: 'Técnico', permissions: ['area.tecnicos'] } } },
    };
    const verDefs = redTs.definitions(ctx(tecnico)).map((d) => d.name);
    verDefs.includes('diagnostico_onu')
      ? ok(`el técnico ve diagnostico_onu (${verDefs.length} herramientas de red)`)
      : bad('el técnico NO ve diagnostico_onu');

    // Un cliente no puede pedir la óptica de nadie, ni de sí mismo.
    const fugaOnu = await redTs.execute('diagnostico_onu', { subscriberId: sub.id }, ctx(cli));
    fugaOnu === 'PERMISO_DENEGADO'
      ? ok('un cliente que invoca diagnostico_onu recibe PERMISO_DENEGADO')
      : bad(`¡FUGA! un cliente leyó la OLT: ${String(fugaOnu).slice(0, 80)}`);

    const conOnu = await prisma.oltOnu.findFirst({ where: { subscriberId: { not: null } }, select: { subscriberId: true } });
    if (conOnu) {
      const onu = await redTs.execute('diagnostico_onu', { subscriberId: conOnu.subscriberId }, ctx(tecnico));
      console.log(`     → ONU: ${onu.split('\n').join(' | ').slice(0, 200)}`);
      /OLT|SIMULACIÓN|no tiene ONU/i.test(onu)
        ? ok('diagnostico_onu responde con la ubicación real de la ONU o dice por qué no puede')
        : bad(`respuesta inesperada de diagnostico_onu: ${onu}`);
    } else {
      console.log('     (no hay ONUs ligadas a un abonado en la BD; se omite la lectura real)');
    }

    // ── 5d. Enrutador del motor: el agente interno DEBE poder ejecutar ──
    //
    // El motor arma su tabla nombre→toolset UNA vez, con un usuario sonda sin
    // permisos. Como las herramientas internas se declaran por área, esa tabla
    // quedaba vacía y toda llamada del funcionario moría en "herramienta
    // desconocida" — el bot veía las herramientas pero no podía usar ninguna.
    // Estas dos comprobaciones son las que evitan que vuelva a pasar sin que nadie
    // se entere: la sonda tiene que ver TODO, y el funcionario solo lo suyo.
    console.log('\n3c) Enrutador de herramientas (sonda del motor)');
    const internoTs = combineToolsets(
      app.get(InternoAbonadosToolset), app.get(InternoTicketsToolset), app.get(InternoRedToolset),
      app.get(InternoInventarioToolset), app.get(InternoCajaToolset), app.get(InternoReportesToolset),
      app.get(InternoRrhhToolset), app.get(InternoComprasToolset),
      app.get(InternoFacturacionToolset), app.get(InternoCobranzaToolset), app.get(InternoOperacionToolset),
    );
    const sonda = ctx({ id: '', name: '', permissions: [] });
    const nombresSonda = internoTs.definitions(sonda).map((d) => d.name);
    nombresSonda.includes('buscar_tickets') && nombresSonda.includes('caja_del_dia')
      ? ok(`la sonda del motor ve las ${nombresSonda.length} herramientas internas (el enrutador queda completo)`)
      : bad(`la sonda solo ve ${nombresSonda.length}: el agente interno no podrá ejecutar nada`);

    const delTecnico = internoTs.definitions(ctx(tecnico)).map((d) => d.name);
    !delTecnico.includes('caja_del_dia') && delTecnico.includes('buscar_tickets')
      ? ok(`al técnico se le ofrecen ${delTecnico.length} herramientas, ninguna de caja`)
      : bad(`el técnico ve herramientas que no son de su área: ${delTecnico.join(', ')}`);

    const fugaCaja = await internoTs.execute('caja_del_dia', {}, ctx(tecnico));
    /no disponible|PERMISO_DENEGADO/i.test(fugaCaja)
      ? ok('un técnico que invoca una herramienta de caja recibe "no disponible"')
      : bad(`¡FUGA! un técnico leyó la caja: ${String(fugaCaja).slice(0, 80)}`);

    // Lo que la mordaza atajó: cero es lo esperable en las pruebas de lectura.
    if (enviosBloqueados.length) {
      console.log(`\n  \x1b[33m⚠ se bloquearon ${enviosBloqueados.length} envío(s) de WhatsApp que esta prueba habría hecho:\x1b[0m`);
      for (const e of enviosBloqueados) console.log(`     → a ${e.to}: ${e.tpl ? `plantilla ${e.tpl}` : e.doc ? `documento ${e.doc}` : String(e.text).slice(0, 60)}`);
    }

    // ── 5e. Acceso por niveles: la barrera del EXECUTE ─────────────
    //
    // Que a un acceso básico no se le DECLAREN las herramientas sensibles solo evita
    // que el modelo las vea. Si se inventa el nombre, el motor igual las encuentra en
    // su enrutador y las ejecuta: el 2026-07-28 así se envió el PDF de una factura a
    // quien solo había acertado los datos. Esto comprueba la barrera de verdad.
    console.log('\n3d) Acceso por niveles (validación por datos)');
    const subVal = await prisma.subscriber.findFirst({
      where: { status: 'ACTIVO', docNumber: { not: null }, phone1: { not: null }, fullName: { not: null } },
      select: { docNumber: true, fullName: true, phone1: true },
    });
    if (subVal) {
      const TEL_VAL = '573009998877';
      const vr = await app.get(ChatAccessService).validarDatos(TEL_VAL, {
        documento: subVal.docNumber, nombre: subVal.fullName, telefonoTitular: subVal.phone1,
      });
      vr.ok ? ok('los datos correctos del titular dan acceso básico') : bad(`la validación rechazó datos correctos: ${vr.error}`);

      const basico = await identity.resolveUser(TEL_VAL);
      basico?.meta?.identity?.acceso === 'basico'
        ? ok('quien se validó por datos queda como cliente con acceso BÁSICO')
        : bad(`esperaba acceso 'basico', obtuve '${basico?.meta?.identity?.acceso}'`);

      const ofrecidas = cliTs.definitions(ctx(basico)).map((d) => d.name);
      ['enviar_mi_factura', 'mis_pagos', 'autorizar_numero'].every((h) => !ofrecidas.includes(h))
        ? ok('no se le ofrecen las herramientas que exponen la cuenta')
        : bad(`se le ofrecieron herramientas sensibles: ${ofrecidas.join(', ')}`);

      // Lo importante: invocarlas A LA FUERZA, como haría un modelo que alucina.
      const forzadas = await Promise.all(
        ['enviar_mi_factura', 'mis_facturas', 'mis_pagos', 'mi_plan', 'autorizar_numero'].map((h) =>
          cliTs.execute(h, { telefono: '3001112233' }, ctx(basico))),
      );
      forzadas.every((r) => /no te lo puedo dar|PERMISO_DENEGADO/i.test(String(r)))
        ? ok('invocadas a la fuerza, TODAS se niegan (barrera en el execute)')
        : bad(`¡FUGA! con acceso básico se ejecutó algo sensible: ${forzadas.find((r) => !/no te lo puedo dar/i.test(String(r)))}`);

      const permitida = await cliTs.execute('mi_estado_de_cuenta', {}, ctx(basico));
      /pendiente|al día/i.test(permitida) && !/Factura \d/.test(permitida)
        ? ok('sí puede saber cuánto se debe, pero sin el desglose factura por factura')
        : bad(`el estado de cuenta básico no es el esperado: ${permitida.slice(0, 90)}`);
    }

    // ── 6. Escritura: prepara, no ejecuta ──────────────────────────
    console.log('\n4) Confirmación de escrituras');
    const falla = await cliTs.execute('reportar_falla', { descripcion: 'prueba' }, ctx(cli));
    falla.startsWith('PREPARADO')
      ? ok('reportar_falla PREPARA y espera confirmación (no crea el ticket solo)')
      : bad(`reportar_falla no pidió confirmación: ${falla}`);

  } finally {
    // La prueba de "pedir acceso" deja una solicitud PENDIENTE contra un abonado
    // real. No da acceso a nada (pendiente ≠ autorizado), pero dejarla ahí le
    // ensuciaría la cuenta a un cliente y aparecería en su lista de solicitudes.
    try {
      await prisma.subscriberContact.deleteMany({ where: { phone: '573009998877' } });
      await prisma.chatAccessVerification.deleteMany({ where: { phone: '573009998877' } });
      ok('solicitud y verificación de prueba borradas');
    } catch (e) {
      bad(`no se pudo borrar la solicitud de prueba: ${e.message}`);
    }

    // Deshacer el vínculo SIEMPRE, pase lo que pase. Si esto se queda a medias, un
    // funcionario real queda atado al número de prueba y quien lo tenga en su WhatsApp
    // sería atendido como interno, con el RBAC completo de esa persona. Por eso va en
    // el finally y con su propio try: ni un fallo aquí puede saltárselo.
    if (linkedUserId) {
      try {
        await links.unlink(linkedUserId);
        ok('vínculo de prueba deshecho');
      } catch (e) {
        bad(`NO SE PUDO DESHACER EL VÍNCULO de ${linkedUserId} con 573001234567 — `
          + `deshazlo A MANO ya mismo (Configuración → vínculos): ${e.message}`);
      }
    }
    await app.close();
  }
  console.log(process.exitCode ? '\n\x1b[31mHUBO FALLOS\x1b[0m\n' : '\n\x1b[32mTODO OK\x1b[0m\n');
})();
