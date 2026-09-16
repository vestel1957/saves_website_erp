/**
 * PlayHub en ventanilla para la cajera (2026-09-04). Idempotente.
 *
 * La cajera veía la pestaña PlayHub en la ficha del cliente pero no funcionaba
 * NADA: los 11 endpoints exigían `administracion|tecnicos|gerencia|sistemas` y su
 * rol sólo trae `area.caja`, así que todo respondía 403. Y como el panel se traga
 * los errores, lo que le salía era "PlayHub no configurado" — parecía una avería.
 *
 * Se le abre PlayHub como trabajo de mostrador: consultar, suscribir, cancelar y
 * sincronizar. Lo que ve NO es lo mismo que ve administración:
 *   · las operaciones por cliente pasan por `exigirSedeSuscriptor`: sólo abonados
 *     de SU sede (cambiar el id de la URL da 403);
 *   · el reporte /playhub va acotado a su sede, totales incluidos
 *     (`ExtrasService.playhub`);
 *   · la BARRIDA MASIVA (`/playhub/sync-all`, `/playhub/sync-status`) sigue fuera
 *     de caja: es mantenimiento de todo el parque, no ventanilla.
 *
 * La regla de negocio no cambia: PlayHub sigue exigiendo el mínimo de Megas
 * (`PLAYHUB_MIN_MEGAS`), que se comprueba en el servicio y no depende del rol.
 *
 * Ni conceder ni revocar se puede hacer sólo en el catálogo (`SCREENS`): la
 * concesión vive en `RolePermission`. Los overrides por usuario se reportan y NO se
 * tocan.
 *
 * Correr:  npx ts-node prisma/migrate-cajera-playhub-2026-09.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const ROL = 'area-caja';
const DAR = ['/playhub'];

async function main() {
  // Coherencia con el catálogo: si no coincide, el próximo seed desharía esto.
  const malQuitadas = SCREENS.filter((s) => DAR.includes(s.href) && !s.areas.includes('caja'));
  if (malQuitadas.length) {
    console.error('✗ El catálogo no concuerda con este script. Revisa SCREENS.');
    process.exitCode = 1;
    return;
  }

  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key: p.key }, update: { label: p.label }, create: { key: p.key, label: p.label } });
  }

  const rol = await prisma.role.findUnique({ where: { key: ROL }, select: { id: true, name: true } });
  if (!rol) { console.error(`✗ No existe el rol "${ROL}".`); process.exitCode = 1; return; }

  for (const href of DAR) {
    const key = screenKey(href);
    const permiso = await prisma.permission.findUnique({ where: { key }, select: { id: true } });
    if (!permiso) { console.error(`  + ${key} no se creó`); continue; }
    const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
    if (ya) { console.log(`  + ${key.padEnd(30)} ya la tenía`); continue; }
    await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
    console.log(`  + ${key.padEnd(30)} CONCEDIDA`);
    const overrides = await prisma.userPermission.findMany({
      where: { permissionId: permiso.id },
      select: { effect: true, user: { select: { name: true, email: true } } },
    });
    for (const o of overrides) console.log(`      ⚠ override por usuario: ${o.user.name} <${o.user.email}> (${o.effect}) — sin tocar`);
  }

  const cajeras = await prisma.user.count({ where: { isActive: true, roles: { some: { role: { key: ROL } } } } });
  console.log(`\n  ℹ ${cajeras} usuario(s) activo(s) con el rol "${rol.name}".`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
