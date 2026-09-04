#!/usr/bin/env node
/**
 * Resincroniza las plantillas locales (WhatsappTemplate) con las de la WABA nueva.
 * Al cambiar de número/WABA los nombres en Meta pasaron a llevar sufijo `_hx<hex>`:
 * sin esto, cualquier envío falla con "template name does not exist".
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const KEY = process.env.KAPSO_API_KEY, WABA = process.env.KAPSO_WABA_ID;
const BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0';
const raiz = (n) => n.replace(/_hx[0-9a-f]{32}$/i, '');

/** Deduce el origen de cada variable por el texto que la rodea (mismo criterio que el modal masivo). */
function inferir(body, i, previas) {
  const previa = previas.find((v) => v.index === i);
  if (previa) return previa;
  const antes = (body.split(`{{${i}}}`)[0] || '').toLowerCase().slice(-40);
  if (/hola,?\s*$/.test(antes)) return { index: i, label: 'Primer nombre', source: 'firstName' };
  if (/(saldo|valor|deuda|mora por|pagar):?\s*$/.test(antes.trim())) return { index: i, label: 'Deuda pendiente', source: 'deuda' };
  if (/contrato\s*$/.test(antes.trim())) return { index: i, label: 'N° de abonado', source: 'abonado' };
  return { index: i, label: `Texto fijo {{${i}}}`, source: 'custom', value: '' };
}

(async () => {
  const res = await fetch(`${BASE}/${WABA}/message_templates?limit=200`, { headers: { 'X-API-Key': KEY } });
  const { data } = await res.json();
  const locales = await prisma.whatsappTemplate.findMany();
  const porRaiz = new Map(locales.map((t) => [raiz(t.name), t]));
  const vistos = new Set();
  let act = 0, nuevas = 0;

  for (const t of data) {
    const body = (t.components || []).find((c) => c.type === 'BODY')?.text || '';
    const header = (t.components || []).find((c) => c.type === 'HEADER')?.text || null;
    const nVars = Math.max(0, ...[...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
    const local = porRaiz.get(raiz(t.name));
    const previas = local ? (local.variables || []) : [];
    const variables = Array.from({ length: nVars }, (_, k) => inferir(body, k + 1, previas));
    const datos = {
      name: t.name, language: t.language, category: t.category, bodyText: body, headerText: header,
      variables, active: true,
    };
    if (local) {
      vistos.add(local.id);
      await prisma.whatsappTemplate.update({ where: { id: local.id }, data: datos });
      act++;
    } else {
      await prisma.whatsappTemplate.create({ data: datos });
      nuevas++;
    }
  }

  // Las que ya no existen en esta WABA se apagan (no se borran: hay campañas que las referencian).
  const huerfanas = locales.filter((l) => !vistos.has(l.id));
  for (const h of huerfanas) await prisma.whatsappTemplate.update({ where: { id: h.id }, data: { active: false } });

  console.log(`Meta: ${data.length} · actualizadas: ${act} · nuevas: ${nuevas} · apagadas: ${huerfanas.length} (${huerfanas.map((h) => h.name).join(', ') || '—'})`);
  await prisma.$disconnect();
})();
