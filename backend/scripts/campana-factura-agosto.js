#!/usr/bin/env node
/**
 * Campaña "ya está disponible tu factura · fecha límite 20" por WhatsApp.
 *
 * Se apoya en el motor de campañas del backend (throttle, reintento con backoff,
 * seguimiento por webhook y reporte en /configuracion/whatsapp/masivo) en vez de
 * un bucle propio: una corrida de este script se ve y se audita como cualquier
 * campaña lanzada a mano.
 *
 * Uso:
 *   node scripts/campana-factura-agosto.js --prueba 573001112233   → 1 mensaje suelto
 *   node scripts/campana-factura-agosto.js --plan                  → a quién iría, sin enviar
 *   node scripts/campana-factura-agosto.js --enviar [--tope 1900]  → crea y corre la campaña
 *
 * El tope existe porque Meta limita el número a 2.000 clientes únicos cada 24 h
 * (TIER_2K): pasarse no manda más mensajes, solo genera FAILED y castiga la
 * calidad de la línea. Con ~3.500 destinatarios van dos tandas, un día cada una.
 */
require('reflect-metadata');
const path = require('path');
const fs = require('fs');

// El .env del backend (mismo parser mínimo que el resto de scripts del proyecto).
for (const linea of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(linea);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const mysql = require('mysql2/promise');
const { prismaService, whatsappService, whatsappCampaignService } = require('../dist/src/core/contenedor.js');

const TEMPLATE = 'vestel_facturacion_86_hx3fcac5bd7f421eacb08b158f2fba94bf';
/** Quiénes reciben "tu factura está disponible": los que siguen al día o con acuerdo. */
const ESTADOS = ['ACTIVO', 'COMPROMISO'];
const TOPE_DEFECTO = 1900;

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? null : (process.argv[i + 1] ?? '');
};
const esMovil = (p) => /^573\d{9}$/.test(p);
const normaliza = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (/^3\d{9}$/.test(d)) return `57${d}`;
  if (/^573\d{9}$/.test(d)) return d;
  return null;
};
const cop = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

/**
 * Destinatarios: cliente vivo, con factura pendiente, celular móvil y que NO haya
 * recibido ya esta plantilla (el dedupe es por teléfono, no por ficha: dos
 * contratos de la misma persona son un solo WhatsApp).
 */
async function publico() {
  const subs = await prismaService.subscriber.findMany({
    where: {
      status: { in: ESTADOS },
      invoices: { some: { status: { in: ['DUE', 'PARTIAL'] } } },
    },
    select: { id: true, abonado: true, phone1: true, phone2: true, firstName: true, fullName: true, branchId: true },
    orderBy: { abonado: 'asc' },
  });

  const yaEnviados = await prismaService.whatsappSend.findMany({
    where: { templateName: TEMPLATE, status: { in: ['SENT', 'DELIVERED', 'READ'] } },
    select: { phone: true },
  });
  const hechos = new Set(yaEnviados.map((s) => s.phone));
  // El legacy también manda este aviso (`KAPSO_masivo_factura_disponible.php`) y en
  // agosto ya cubrió ~1.100 clientes: sin cruzar contra su bitácora les llegaría el
  // mismo mensaje dos veces, que es la vía rápida a que reporten el número.
  for (const p of await avisadosPorElLegacy()) hechos.add(p);

  const vistos = new Set();
  const lista = [];
  for (const s of subs) {
    const phone = [s.phone1, s.phone2].map(normaliza).find((p) => p && esMovil(p));
    if (!phone || hechos.has(phone) || vistos.has(phone)) continue;
    vistos.add(phone);
    lista.push({ ...s, phone });
  }
  return lista;
}

/** Teléfonos que el legacy ya avisó este mes (bitácora `whatsapp_envios`). */
async function avisadosPorElLegacy() {
  const cn = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD, database: process.env.LEGACY_DB_NAME,
  });
  try {
    const [filas] = await cn.query(
      `select distinct phone from whatsapp_envios
        where status = 'sent' and created_at >= ? and template_label like '%Factura disponible%'`,
      ['2026-08-01'],
    );
    return filas.map((f) => normaliza(f.phone)).filter(Boolean);
  } finally {
    await cn.end();
  }
}

async function deudas(ids) {
  const filas = await prismaService.subInvoice.groupBy({
    by: ['subscriberId'],
    where: { subscriberId: { in: ids }, status: { in: ['DUE', 'PARTIAL'] } },
    _sum: { total: true, paidAmount: true },
  });
  const m = {};
  for (const f of filas) if (f.subscriberId) m[f.subscriberId] = Math.max(0, Number(f._sum.total ?? 0) - Number(f._sum.paidAmount ?? 0));
  return m;
}

(async () => {
  const prueba = arg('--prueba');
  if (prueba) {
    const to = normaliza(prueba);
    if (!to) throw new Error(`Número no válido: ${prueba}`);
    const params = ['PRUEBA', 'agosto', cop(65000), '08'];
    const res = await whatsappService.sendTemplate(to, TEMPLATE, 'es', params);
    console.log(res.ok ? `✅ Enviado a +${to} (id ${res.messageId})` : `❌ ${res.error}`);
    return;
  }

  const lista = await publico();
  const mapa = await deudas(lista.map((s) => s.id));
  const conDeuda = lista.filter((s) => (mapa[s.id] ?? 0) > 0);
  const total = conDeuda.reduce((a, s) => a + (mapa[s.id] ?? 0), 0);
  const tope = Number(arg('--tope') || TOPE_DEFECTO);
  const tanda = conDeuda.slice(0, tope);

  console.log(`Destinatarios pendientes de aviso: ${conDeuda.length} (${cop(total)})`);
  console.log(`Esta tanda: ${tanda.length} (tope ${tope}) · quedan para la siguiente: ${Math.max(0, conDeuda.length - tanda.length)}`);
  console.log('Muestra:', tanda.slice(0, 5).map((s) => `${s.abonado}/${s.phone}/${cop(mapa[s.id] ?? 0)}`).join('  '));

  if (!process.argv.includes('--enviar')) {
    console.log('\n(plan: no se envió nada — añade --enviar)');
    return;
  }

  const hoy = new Date().toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
  const { campaignId } = await whatsappCampaignService.createCampaign(
    { name: `Factura disponible · pago hasta el 20 · ${hoy}`, templateName: TEMPLATE, subscriberIds: tanda.map((s) => s.id) },
    { name: 'Campaña facturación (script)' },
    { autoStart: false },
  );
  console.log(`Campaña ${campaignId} creada. Enviando…`);
  await whatsappCampaignService.runCampaign(campaignId);

  const grupos = await prismaService.whatsappSend.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true } });
  console.log('Resultado:', grupos.map((g) => `${g.status}=${g._count._all}`).join(' '));
})()
  .catch((e) => { console.error('✖', e.message); process.exitCode = 1; })
  .finally(() => prismaService.$disconnect());
