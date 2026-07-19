/**
 * Verifica que una cajera sólo ve SU caja y que el resto de roles ven todas.
 * Usa la cajera de demo (caja@vestel.dev), le asigna una caja, comprueba y lo deja como estaba.
 *
 * Uso: npx ts-node --transpile-only scripts/smoke-caja-scope.ts
 */
import { PrismaClient } from '@prisma/client';
import { alcanceDe, cajasPermitidas, esCajera, exigirAcceso, puedeVer } from '../src/treasury/caja-scope';
import { AuthUser } from '../src/auth/current-user.decorator';

const prisma = new PrismaClient();
let ok = 0, fail = 0;
const assert = (c: boolean, m: string, extra = '') => {
  if (c) { ok++; console.log(`  OK    ${m}`); } else { fail++; console.log(`  FALLO ${m} ${extra}`); }
};

const authDe = (u: { id: string; email: string; name: string }, permissions: string[]): AuthUser =>
  ({ ...u, roles: [], permissions });

async function main() {
  const cajera = await prisma.user.findUnique({ where: { email: 'caja@vestel.dev' } });
  if (!cajera) { console.log('No existe caja@vestel.dev; siembra los usuarios demo.'); process.exit(1); }
  const previo = { caja: cajera.cajaLegacyId, sedes: cajera.sedesAccede };

  try {
    // Mireya: caja 1 (Villanueva), sede 3 — el caso real del legacy.
    await prisma.user.update({ where: { id: cajera.id }, data: { cajaLegacyId: 1, sedesAccede: [3] } });

    const uCajera = authDe(cajera, ['area.caja', 'accounting.view']);
    const uConta = authDe(cajera, ['area.contabilidad']);
    const uAdmin = authDe(cajera, ['system.admin']);
    const uMixta = authDe(cajera, ['area.caja', 'area.contabilidad']);

    console.log('\n¿Quién es cajera?');
    assert(esCajera(uCajera), 'area.caja sola -> es cajera (va acotada)');
    assert(!esCajera(uConta), 'contabilidad -> NO es cajera (ve todas)');
    assert(!esCajera(uAdmin), 'system.admin -> NO es cajera (bypass)');
    assert(!esCajera(uMixta), 'area.caja + contabilidad -> manda contabilidad, ve todas');

    console.log('\nAlcance de la cajera (caja 1 Villanueva, sede 3):');
    const a = await alcanceDe(prisma as any, uCajera);
    assert(a.todas === false && a.caja === 1, 'su caja es la 1');

    // branchLegacy: Villanueva=3, Yopal=2, Monterrey=4, WOMPI=0 (banco)
    assert(puedeVer(a, 1, 3), 've SU caja (Villanueva)');
    assert(!puedeVer(a, 3, 2), 'NO ve Yopal');
    assert(!puedeVer(a, 5, 4), 'NO ve Monterrey');
    assert(!puedeVer(a, 10, 3), 'NO ve villanueva 2 (misma sede, otra caja)');
    assert(puedeVer(a, 23, 0), 'SÍ ve WOMPI (banco, sede 0) — lo necesita para consolidar');
    assert(puedeVer(a, 6, 0), 'SÍ ve BANCOLOMBIA TV (banco)');

    const permitidas = await cajasPermitidas(prisma as any, uCajera);
    assert(!!permitidas && permitidas.includes(1), 'la lista permitida incluye su caja');
    assert(!!permitidas && !permitidas.includes(5), 'la lista permitida NO incluye Monterrey');

    console.log('\nEl 403 de verdad:');
    let bloqueado = false;
    try { await exigirAcceso(prisma as any, uCajera, 5); } catch { bloqueado = true; }
    assert(bloqueado, 'pedir el cierre de Monterrey -> 403');
    let paso = true;
    try { await exigirAcceso(prisma as any, uCajera, 1); } catch { paso = false; }
    assert(paso, 'pedir el cierre de SU caja -> pasa');

    // OJO: `sedesAccede` acota a CUALQUIERA, tenga el rol que tenga (es el otro eje, y es
    // la semántica del legacy). Gerencia/admin lo tienen en '0' = todas -> [] aquí. Hay
    // que limpiarlo para probar al contable, si no hereda el [3] de la cajera de arriba.
    await prisma.user.update({ where: { id: cajera.id }, data: { sedesAccede: [] } });

    console.log('\nContabilidad ve todas (sedesAccede vacío = todas):');
    const ac = await alcanceDe(prisma as any, uConta);
    assert(ac.todas === true, 'alcance.todas = true');
    assert((await cajasPermitidas(prisma as any, uConta)) === null, 'sin límite (null = no filtrar)');
    assert(puedeVer(ac, 5, 4) && puedeVer(ac, 3, 2), 've Monterrey y Yopal');

    console.log('\nUn contable ACOTADO a la sede 3 (sedesAccede corta a cualquier rol):');
    await prisma.user.update({ where: { id: cajera.id }, data: { sedesAccede: [3] } });
    const acotado = await alcanceDe(prisma as any, uConta);
    assert(puedeVer(acotado, 1, 3), 've las cajas de la sede 3');
    assert(!puedeVer(acotado, 5, 4), 'NO ve Monterrey (sede 4, fuera de su alcance)');

    console.log('\nCajera SIN caja asignada (como el legacy: sólo bancos):');
    await prisma.user.update({ where: { id: cajera.id }, data: { cajaLegacyId: null, sedesAccede: [] } });
    const sin = await alcanceDe(prisma as any, uCajera);
    assert(!puedeVer(sin, 1, 3), 'no ve ninguna caja de sede');
    assert(puedeVer(sin, 23, 0), 'sólo ve los bancos');
  } finally {
    await prisma.user.update({
      where: { id: cajera.id },
      data: { cajaLegacyId: previo.caja, sedesAccede: previo.sedes },
    });
    console.log('\nRestaurado el usuario de demo a como estaba.');
  }

  console.log(`\n${ok} OK · ${fail} fallos`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
