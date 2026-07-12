/**
 * Backfill Plan.pppProfile (solo planes INTERNET) desde el perfil RouterOS real
 * de los abonados legacy (customers.perfil).
 *
 * Puente: Plan <- SubscriberService.planId <- Subscriber.legacyId == customers.id -> customers.perfil
 * Por cada plan se toma el perfil VÁLIDO dominante entre sus abonados.
 *
 * Uso:  node scripts/backfill-plan-pppprofile.js            (preview, no escribe)
 *       node scripts/backfill-plan-pppprofile.js --commit   (aplica)
 *
 * Idempotente: recalcula y sobreescribe pppProfile en cada corrida.
 */
const { PrismaClient } = require('@prisma/client');
const mysql = require('mysql2/promise');

const COMMIT = process.argv.includes('--commit');

// Valores de customers.perfil que NO son perfiles reales del router.
const INVALID = new Set(
  ['', '-', '0', 'default', 'cortado', 'cortados', 'suspendido',
   'seleccine...', 'seleccione...', 'pppoe'].map((s) => s.toLowerCase()),
);

// Normaliza para comparar nombre de plan vs perfil de router:
// minúsculas, sin espacios/guiones, "mega(s)"->"megas". "50 Megas" == "50Megas".
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/megabyte|mbps|mb/g, 'megas')
    .replace(/mega(?!s)/g, 'megas')
    .replace(/[\s\-_.]/g, '')
    .trim();
}

// Deriva el perfil de router por VELOCIDAD BASE cuando el nombre trae sufijo
// comercial (F/S/V/-26/FS-26...). Conserva variantes reales del router (St/D/26F)
// probándolas primero; si esa variante no existe a esa velocidad, cae a la base.
function deriveProfile(planName, profileSet) {
  const m = String(planName).match(/(\d+)\s*mega/i);
  if (!m) return null;
  const num = m[1];
  const candidates = [];
  if (/\bst\b|megasst|megas\s*st/i.test(planName)) candidates.push(num + 'MegasSt');
  if (/26\s*f|f\s*-\s*26|fs\s*-?\s*26|\b26\b/i.test(planName)) candidates.push(num + 'Megas26F');
  if (/megasd|\bdr?\b/i.test(planName)) candidates.push(num + 'MegasD');
  candidates.push(num + 'Megas'); // velocidad base
  for (const c of candidates) {
    const hit = profileSet.get(norm(c));
    if (hit) return hit;
  }
  return null;
}

function cleanProfile(raw) {
  if (raw == null) return null;
  const p = String(raw).trim();
  if (!p) return null;
  if (INVALID.has(p.toLowerCase())) return null;
  return p;
}

(async () => {
  const prisma = new PrismaClient();
  const my = await mysql.createConnection({
    host: 'localhost', user: 'admin_vestel', password: 'Vestel_2025!', database: 'vestel_dev',
  });

  try {
    // 1) legacyId (customers.id) -> perfil limpio
    const [rows] = await my.execute(
      "SELECT id, perfil FROM customers WHERE perfil IS NOT NULL AND perfil <> ''",
    );
    const perfilById = new Map();
    for (const r of rows) {
      const cp = cleanProfile(r.perfil);
      if (cp) perfilById.set(Number(r.id), cp);
    }
    console.log(`customers con perfil válido: ${perfilById.size}`);

    // Conjunto de perfiles REALES del router (los válidos distintos en customers).
    const profileSet = new Map(); // norm -> forma canónica del router
    for (const cp of perfilById.values()) {
      const n = norm(cp);
      if (!profileSet.has(n)) profileSet.set(n, cp);
    }

    // 2) planes INTERNET
    const plans = await prisma.plan.findMany({
      where: { kind: 'INTERNET' },
      select: { id: true, name: true, pppProfile: true },
    });
    console.log(`planes INTERNET: ${plans.length}\n`);

    // 3) match por NOMBRE normalizado exacto (alta confianza). Además calcula el
    //    perfil dominante entre abonados solo como pista informativa (no se aplica).
    let willSet = 0, unchanged = 0, noMatch = 0;
    const matched = [], ambiguous = [];
    for (const plan of plans) {
      const canonical = profileSet.get(norm(plan.name)) || null;

      // pista: dominante entre abonados
      const svcs = await prisma.subscriberService.findMany({
        where: { planId: plan.id },
        select: { subscriber: { select: { legacyId: true } } },
      });
      const tally = new Map();
      for (const s of svcs) {
        const cp = perfilById.get(Number(s.subscriber?.legacyId));
        if (cp) tally.set(cp, (tally.get(cp) || 0) + 1);
      }
      const dom = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];

      const chosen = canonical || deriveProfile(plan.name, profileSet);
      if (chosen) {
        matched.push({ plan: plan.name, profile: chosen, via: canonical ? 'exacto' : 'derivado' });
        if (plan.pppProfile === chosen) unchanged++;
        else {
          willSet++;
          if (COMMIT) await prisma.plan.update({ where: { id: plan.id }, data: { pppProfile: chosen } });
        }
      } else {
        noMatch++;
        ambiguous.push({ plan: plan.name, hint: dom ? `${dom[0]} (${dom[1]}/${svcs.length})` : '(sin datos)' });
      }
    }

    console.log('--- ASIGNADOS (exacto + derivado por velocidad base) ---');
    for (const r of matched.sort((a, b) => a.plan.localeCompare(b.plan)))
      console.log(`  ✓ ${r.plan.padEnd(20)} -> ${r.profile.padEnd(14)} [${r.via}]`);
    console.log('\n--- SIN PERFIL (quedan null; no mapeables a velocidad) ---');
    for (const r of ambiguous.sort((a, b) => a.plan.localeCompare(b.plan)))
      console.log(`  · ${r.plan.padEnd(20)}   pista: ${r.hint}`);
    console.log(`\n${COMMIT ? 'APLICADO' : 'PREVIEW'}: match ${matched.length} (setear ${willSet}, ya ok ${unchanged}), sin match ${noMatch}`);
    if (!COMMIT) console.log('Corre con --commit para aplicar solo los match exactos.');
  } finally {
    await my.end();
    await prisma.$disconnect();
  }
})().catch((e) => { console.error(e); process.exit(1); });
