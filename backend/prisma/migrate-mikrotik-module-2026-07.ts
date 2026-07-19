/**
 * Migración puntual: módulo Mikrotik propio (2026-07-15).
 * Idempotente — seguro de correr varias veces.
 *
 *  - Renombra la llave de pantalla `screen.red.masivo` → `screen.mikrotik.masivo`
 *    porque /red/masivo se movió a /mikrotik/masivo. Se hace con UPDATE sobre
 *    `Permission.key` (no borrar+crear) para CONSERVAR las concesiones: tanto
 *    `RolePermission` como `UserPermission` apuntan a `permissionId`, no a la
 *    llave, así que el rename no toca a nadie.
 *
 * Después de esto hay que correr `migrate-roles-2026-06.ts`, que upserta los
 * permisos nuevos del catálogo (`screen.mikrotik`, `screen.mikrotik.ips`, y las
 * pantallas de red que faltaban: naps/olt/genieacs) y resincroniza los roles del
 * catálogo — `screensForArea('tecnicos')` se los concede solo a `area-tecnicos`.
 *
 * Correr:  npx ts-node prisma/migrate-mikrotik-module-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const RENAMES: [from: string, to: string][] = [
  ['screen.red.masivo', 'screen.mikrotik.masivo'],
];

async function main() {
  for (const [from, to] of RENAMES) {
    const old = await prisma.permission.findUnique({ where: { key: from } });
    if (!old) {
      console.log(`· ${from} no existe (ya migrado o nunca sembrado) — se omite`);
      continue;
    }
    // Si el destino ya existe, el rename chocaría con el @unique: se consolidan
    // las concesiones del viejo sobre el nuevo y se elimina el viejo.
    const existing = await prisma.permission.findUnique({ where: { key: to } });
    if (existing) {
      const roles = await prisma.rolePermission.findMany({ where: { permissionId: old.id } });
      for (const rp of roles) {
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: rp.roleId, permissionId: existing.id } },
          update: {},
          create: { roleId: rp.roleId, permissionId: existing.id },
        });
      }
      await prisma.rolePermission.deleteMany({ where: { permissionId: old.id } });
      await prisma.userPermission.deleteMany({ where: { permissionId: old.id } });
      await prisma.permission.delete({ where: { id: old.id } });
      console.log(`✓ ${from} consolidado sobre ${to} (${roles.length} rol(es))`);
      continue;
    }
    const grants = await prisma.rolePermission.count({ where: { permissionId: old.id } });
    await prisma.permission.update({
      where: { id: old.id },
      data: { key: to, label: 'Operaciones masivas' },
    });
    console.log(`✓ ${from} → ${to} (${grants} concesión(es) conservadas)`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
