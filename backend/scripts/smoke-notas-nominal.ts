/**
 * Smoke del candado nominal de notas crédito/débito (2026-09-10) contra la API VIVA.
 *
 * Lo que comprueba, con dos cuentas reales y sin escribir un solo peso:
 *   1. Contabilidad —que hasta ayer emitía— recibe 403 en las TRES puertas: nota
 *      suelta, lote de cartera y nota crédito DIAN.
 *   2. Con el permiso concedido, la misma cuenta PASA el candado: ya no responde
 *      403 sino 404 "esa factura no existe", que es la comprobación siguiente.
 *
 * Por eso se usa un id de factura inventado: el guard corta ANTES de tocar la BD,
 * así que un 403 prueba el candado y un 404 prueba que se pasó de largo. No se
 * emite ninguna nota real.
 *
 * El permiso prestado se retira al terminar, pase lo que pase.
 *
 * Correr:  npx ts-node scripts/smoke-notas-nominal.ts
 */
import { PrismaClient } from '@prisma/client';
import { APP_PERMISSIONS } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();
const API = process.env.SMOKE_API ?? 'http://127.0.0.1:3061/api';
const CUENTA = { email: 'prueba.contabilidad@vestel.com.co', password: 'Prueba2026*' };
/** El caso que hace útil todo esto: `system.admin` NO abre esta puerta. */
const SUPERUSUARIO = { email: 'prueba.superusuario@vestel.com.co', password: 'Prueba2026*' };
const FACTURA_INVENTADA = 'no-existe-esta-factura';

let fallos = 0;
function comprobar(que: string, real: number, esperado: number) {
  const ok = real === esperado;
  if (!ok) fallos++;
  console.log(`  ${ok ? '✓' : '✗'} ${que}: ${real}${ok ? '' : ` (se esperaba ${esperado})`}`);
}

async function entrar(cuenta = CUENTA) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuenta),
  });
  if (!res.ok) throw new Error(`login falló (${res.status}): ¿está arriba saves-backend?`);
  return (await res.json()).token as string;
}

const post = (token: string, ruta: string, cuerpo: unknown) =>
  fetch(`${API}${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(cuerpo),
  }).then((r) => r.status);

const NOTA_SUELTA = { type: 'CREDITO', amount: 1000, description: 'smoke del candado nominal' };
const NOTA_LOTE = {
  type: 'CREDITO',
  description: 'smoke del candado nominal',
  items: [{ invoiceId: FACTURA_INVENTADA, amount: 1000 }],
};
const NOTA_DIAN = { reason: 'smoke del candado nominal', cause: 2 };

async function main() {
  const perm = await prisma.permission.findUnique({ where: { key: APP_PERMISSIONS.BILLING_NOTES_EMIT } });
  if (!perm) throw new Error('El permiso billing.notes.emit no está en la BD: corre antes prisma/migrate-notas-emisor-2026-09.ts');

  const user = await prisma.user.findFirst({ where: { email: CUENTA.email }, select: { id: true, name: true } });
  if (!user) throw new Error(`No existe la cuenta de prueba ${CUENTA.email}`);

  const prestado = await prisma.userPermission.findUnique({
    where: { userId_permissionId: { userId: user.id, permissionId: perm.id } },
  });
  if (prestado) throw new Error(`${user.name} ya tiene el permiso concedido; este smoke necesita una cuenta que NO lo tenga.`);

  console.log(`Sin el permiso (${user.name}):`);
  let token = await entrar();
  comprobar('nota suelta', await post(token, `/billing/invoices/${FACTURA_INVENTADA}/notes`, NOTA_SUELTA), 403);
  comprobar('lote de cartera', await post(token, '/billing/notes', NOTA_LOTE), 403);
  comprobar('nota crédito DIAN', await post(token, `/einvoice/credit-note/${FACTURA_INVENTADA}`, NOTA_DIAN), 403);

  // El superusuario sin el permiso tampoco emite: si esto diera 404 en vez de 403,
  // el candado no estaría cerrado para los trece `system.admin` y no habría nada.
  console.log('\nSuperusuario SIN el permiso:');
  const tokenSa = await entrar(SUPERUSUARIO);
  comprobar('nota suelta', await post(tokenSa, `/billing/invoices/${FACTURA_INVENTADA}/notes`, NOTA_SUELTA), 403);
  comprobar('lote de cartera', await post(tokenSa, '/billing/notes', NOTA_LOTE), 403);
  comprobar('nota crédito DIAN', await post(tokenSa, `/einvoice/credit-note/${FACTURA_INVENTADA}`, NOTA_DIAN), 403);

  try {
    await prisma.userPermission.create({ data: { userId: user.id, permissionId: perm.id, effect: 'ALLOW' } });
    console.log('\nCon el permiso concedido (prestado durante el smoke):');
    token = await entrar(); // el permiso se resuelve por petición, pero se re-entra para no depender de eso
    comprobar('nota suelta pasa el candado y muere en "no existe"', await post(token, `/billing/invoices/${FACTURA_INVENTADA}/notes`, NOTA_SUELTA), 404);
    comprobar('lote pasa el candado y muere en "no existe"', await post(token, '/billing/notes', NOTA_LOTE), 404);
    comprobar('nota DIAN pasa el candado y muere en "no existe"', await post(token, `/einvoice/credit-note/${FACTURA_INVENTADA}`, NOTA_DIAN), 404);
  } finally {
    await prisma.userPermission.deleteMany({ where: { userId: user.id, permissionId: perm.id } });
    console.log('\n(permiso prestado retirado)');
  }

  console.log(fallos ? `\n${fallos} comprobación(es) fallaron.` : '\nTodo bien: emitir notas es nominal.');
  process.exitCode = fallos ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
