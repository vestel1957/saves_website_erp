/**
 * Trae del legacy el vínculo usuario -> caja/sedes:
 *   - `asignaciones` (detalle='caja', colaborador=<id aauth_users>) -> `tipo`  => cajaLegacyId
 *   - `aauth_users.sede_accede` ('-2-,-3-,-4-'; '0' = TODAS)                   => sedesAccede
 *
 * El emparejamiento con los usuarios de Nexus es por NOMBRE (`aauth_users` no se migró y
 * `User` no tiene legacyId), que es el mismo recurso que ya usa `promotions.service.ts`
 * para mapear usuario -> Staff. Es aproximado a propósito: sólo aplica lo que casa exacto
 * y lista el resto para revisarlo a mano.
 *
 *   --aplicar  escribe (por defecto sólo muestra qué haría)
 */
import { PrismaClient } from '@prisma/client';
import * as mysql from 'mysql2/promise';

const prisma = new PrismaClient();
const APLICAR = process.argv.includes('--aplicar');

/**
 * '-2-,-3-,-4-' -> [2,3,4] · '0' y '-0-' -> [] (= TODAS, el convenio del legacy).
 *
 * OJO con el orden: el legacy (`Search.php:84-88`) quita los guiones ANTES de comparar
 * con '0', así que **`-0-` significa "todas las sedes"**, no "la sede 0". Comparar sin
 * limpiar primero deja a ese usuario viendo sólo los bancos — justo al revés.
 * (`-0-,-2-,-3-` sí filtra por [0,2,3], porque ya no es exactamente '0'.)
 */
function parseSedes(raw: string | null): number[] {
  const limpio = (raw ?? '').replace(/-/g, '').trim();
  if (!limpio || limpio === '0') return [];
  return [...new Set(limpio.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => !Number.isNaN(n)))];
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

async function main() {
  const my = await mysql.createConnection({
    host: 'localhost', user: 'admin_vestel', password: 'Vestel_2025!', database: 'admin_vestel',
  });

  const [legacy]: any = await my.query(`
    SELECT u.id, u.username, u.sede_accede, e.name AS nombre, a.tipo AS caja
    FROM aauth_users u
    LEFT JOIN employee_profile e ON e.id = u.id
    LEFT JOIN asignaciones a ON a.colaborador = u.id AND a.detalle = 'caja'
    WHERE a.tipo IS NOT NULL OR u.sede_accede <> '0'
  `);
  const usuarios = await prisma.user.findMany({ select: { id: true, name: true, email: true } });
  const porNombre = new Map(usuarios.map((u) => [norm(u.name), u]));

  const cajas = await prisma.cashAccount.findMany({ select: { legacyId: true, holder: true } });
  const holderDe = new Map(cajas.map((c) => [c.legacyId, c.holder]));

  console.log(`\nLegacy: ${legacy.length} usuarios con caja asignada o sedes acotadas.`);
  console.log(`Nexus : ${usuarios.length} usuarios.\n`);

  const casan: any[] = [];
  const huerfanos: any[] = [];
  for (const l of legacy) {
    const nombre = l.nombre ?? l.username;
    const u = porNombre.get(norm(nombre ?? ''));
    const sedes = parseSedes(l.sede_accede);
    // `asignaciones.tipo` es VARCHAR en el legacy: sin Number() no casa con el legacyId Int.
    const caja = l.caja == null ? null : Number(l.caja);
    const fila = { legacy: nombre, username: l.username, caja, cajaNombre: (caja != null && holderDe.get(caja)) || '?', sedes };
    if (u) casan.push({ ...fila, userId: u.id, email: u.email });
    else huerfanos.push(fila);
  }

  if (casan.length) {
    console.log('CASAN con un usuario de Nexus:');
    for (const c of casan) {
      console.log(`  ${c.legacy.padEnd(32)} -> ${c.email.padEnd(28)} caja=${c.caja ?? '-'} (${c.cajaNombre}) sedes=[${c.sedes}]`);
      if (APLICAR) {
        await prisma.user.update({
          where: { id: c.userId },
          data: { cajaLegacyId: c.caja ?? null, sedesAccede: c.sedes },
        });
      }
    }
  }

  console.log(`\nSIN usuario en Nexus (${huerfanos.length}) — se aplicará cuando migres las cajeras reales:`);
  for (const h of huerfanos.slice(0, 40)) {
    console.log(`  ${String(h.legacy).padEnd(32)} caja=${h.caja ?? '-'} (${h.cajaNombre}) sedes=[${h.sedes}]`);
  }

  console.log(APLICAR ? `\nAPLICADO a ${casan.length} usuario(s).` : '\n(simulacro: nada escrito. Añade --aplicar para escribir.)');
  await my.end();
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
