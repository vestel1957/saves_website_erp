/**
 * Completa el PERFIL DE TÉCNICO DE PRUEBA para poder entrar al sistema "con los
 * ojos" de un técnico de campo.
 *
 *   npx ts-node prisma/seed-tecnico-prueba.ts
 *
 * `seed-usuarios-prueba.ts` ya crea la CUENTA (`prueba.tecnicos@vestel.com.co` con
 * el rol `area-tecnicos`), pero eso solo no alcanza: un técnico ve únicamente lo
 * suyo y lo suyo se resuelve por la FICHA DE EMPLEADO, que se casa con la cuenta
 * por CORREO (ver `src/common/tecnico-scope.ts`). Sin ficha entra, pero las tres
 * pantallas que le quedan salen vacías — el lado seguro, y lo que pasaba hasta hoy.
 *
 * Así que aquí se crea/actualiza, todo idempotente:
 *   1. la cuenta (rol único `area-tecnicos`, clave conocida),
 *   2. su ficha de empleado (`Staff`, cargo 2 = Técnico, sede Yopal),
 *   3. su bodega personal de material (`MaterialWarehouse.technicianRef`),
 *   4. tres equipos A SU NOMBRE, que es lo que le pinta "Mis equipos" en /red/bodegas
 *      (no hay bodega de equipos por técnico: lo suyo es `Equipment.assignedRaw`).
 *
 * Se deja el prefijo PRUEBA en el nombre a propósito: la ficha tiene que estar
 * activa y con cargo de técnico para que el sistema la trate como tal, y eso hace
 * que aparezca en el desplegable de "asignar técnico" de la cajera. Que se vea de
 * lejos que no es una persona.
 *
 * Para deshacerlo (borra ficha, bodega y cuenta de prueba del técnico):
 *   DELETE FROM "Equipment" WHERE "assignedRaw" = 'prueba.tecnico';
 *   DELETE FROM "MaterialWarehouse" WHERE "technicianRef" = 'prueba.tecnico';
 *   DELETE FROM "Staff" WHERE email = 'prueba.tecnicos@vestel.com.co';
 *   DELETE FROM "User"  WHERE email = 'prueba.tecnicos@vestel.com.co';
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/crypto.util';
import { CARGO_TECNICO } from '../src/staff/cargos-legacy';

const prisma = new PrismaClient();

const EMAIL = 'prueba.tecnicos@vestel.com.co';
const CLAVE = 'Prueba2026*';
/** Mismo nombre en la cuenta y en la ficha: así casan por correo Y por nombre. */
const NOMBRE = 'PRUEBA · Técnico de campo';
/** Lo que va en `Staff.username`, `MaterialWarehouse.technicianRef` y `Ticket.assigned`. */
const USUARIO = 'prueba.tecnico';
/** Sede Yopal (`Branch.legacyId` = 2), la de más movimiento. */
const SEDE = 2;

async function main() {
  const rol = await prisma.role.findUnique({ where: { key: 'area-tecnicos' } });
  if (!rol) throw new Error('No existe el rol area-tecnicos en la base.');

  // 1. La cuenta.
  const datos = {
    name: NOMBRE,
    passwordHash: hashPassword(CLAVE),
    isActive: true,
    sedesAccede: [SEDE],
  };
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: datos,
    create: { email: EMAIL, ...datos },
  });
  // Un solo rol: con otro encima ya no representa al técnico.
  await prisma.userRole.deleteMany({ where: { userId: user.id, roleId: { not: rol.id } } });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: rol.id } },
    update: {},
    create: { userId: user.id, roleId: rol.id },
  });
  console.log(`✓ Cuenta      ${EMAIL} · rol ${rol.name}`);

  // 2. La ficha de empleado. `Staff.email` no es único, así que se busca a mano.
  const ficha = {
    name: NOMBRE,
    username: USUARIO,
    email: EMAIL,
    role: CARGO_TECNICO,
    areaLegacy: 2, // Operativa
    banned: false,
    sedeAccede: `-${SEDE}-`,
  };
  const existente = await prisma.staff.findFirst({ where: { email: EMAIL } });
  const staff = existente
    ? await prisma.staff.update({ where: { id: existente.id }, data: ficha })
    : await prisma.staff.create({ data: ficha });
  console.log(`✓ Ficha       ${staff.name} · cargo ${staff.role} · usuario ${staff.username}`);

  // 3. Su bodega personal de material (la que verá en /inventario/bodegas).
  const bodegaPrevia = await prisma.materialWarehouse.findFirst({ where: { technicianRef: USUARIO } });
  const bodega = bodegaPrevia
    ? await prisma.materialWarehouse.update({
        where: { id: bodegaPrevia.id },
        data: { title: 'PRUEBA · Bodega técnico' },
      })
    : await prisma.materialWarehouse.create({
        data: { title: 'PRUEBA · Bodega técnico', technicianRef: USUARIO },
      });
  console.log(`✓ Bodega      ${bodega.title}`);

  // 4. Equipos a su nombre. Se CREAN unidades nuevas en vez de reasignarle CPEs
  //    reales: mover un equipo de verdad se lo quita a su técnico y descuadra el
  //    inventario. Los códigos van en el rango 900.00x, lejos del contador real
  //    (hoy va por 311.608), para que no choquen con lo que llegue del legacy.
  const bodegaEquipos = await prisma.equipmentWarehouse.findFirst({ where: { branchLegacy: SEDE } });
  const EQUIPOS = [
    { code: 900001, brand: 'Bestcom', mac: '00:00:5E:00:53:01', serial: 'PRUEBA-ONT-001', installType: 'GPON' },
    { code: 900002, brand: 'ZTE', mac: '00:00:5E:00:53:02', serial: 'PRUEBA-ONT-002', installType: 'GPON' },
    { code: 900003, brand: 'Huawei', mac: '00:00:5E:00:53:03', serial: 'PRUEBA-ONT-003', installType: 'GPON' },
  ];
  for (const e of EQUIPOS) {
    // Las MAC son del rango de documentación (00:00:5E:00:53:xx, RFC 7042): no
    // pueden colisionar con un equipo real ni acabar en un router de verdad.
    await prisma.equipment.upsert({
      where: { code: e.code },
      update: { assignedRaw: USUARIO, status: 'Bueno' },
      create: {
        code: e.code, brand: e.brand, mac: e.mac, serial: e.serial, installType: e.installType,
        assignedRaw: USUARIO, status: 'Bueno', supplierLegacy: 0,
        warehouseId: bodegaEquipos?.id ?? null, warehouseLegacy: bodegaEquipos?.legacyId ?? 0,
        observation: 'Unidad de PRUEBA (perfil de técnico). No existe físicamente.',
      },
    });
  }
  console.log(`✓ Equipos     ${EQUIPOS.length} a nombre de ${USUARIO} (${EQUIPOS.map((e) => e.brand).join(', ')})`);

  const pantallas = await prisma.rolePermission.findMany({
    where: { roleId: rol.id, permission: { key: { startsWith: 'screen.' } } },
    select: { permission: { select: { key: true } } },
  });
  console.log(`\n✅ Listo. Entrar en https://app.saves.com.co con:`);
  console.log(`   Usuario:    ${EMAIL}`);
  console.log(`   Contraseña: ${CLAVE}`);
  console.log(`   Pantallas:  ${pantallas.map((p) => p.permission.key).join(', ')}`);
}

main()
  .catch((e) => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
