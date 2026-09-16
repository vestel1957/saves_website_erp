/**
 * El técnico trabaja por AGENDA DIARIA (2026-09-10). Idempotente.
 *
 * Los dos datos que el código nuevo no puede cambiar por su cuenta, del paquete de
 * requerimientos que pidió el usuario para los técnicos:
 *
 * 1. **Fuera el Panel de Tareas del perfil del técnico** («eliminar el módulo Panel
 *    de Tareas, ya que las actividades de los técnicos se gestionan mediante el
 *    agendamiento diario»). El permiso `screen.tareas` está CONCEDIDO al rol
 *    `area-tecnicos` en la base: quitarlo del catálogo y de las rutas no se lo quita
 *    a quien ya lo tiene, y el enlace le seguiría saliendo en el menú. El módulo NO
 *    se toca para administración, gerencia y caja, que lo usan para lo suyo.
 *
 * 2. **La geo-cerca pasa a `exigir`** («la orden debe cerrarse desde la ubicación del
 *    usuario»). Llevaba desde el 2026-07-20 en `observar` —anotaba los cierres fuera
 *    de rango pero no frenaba ninguno—, y el modo vive en `AppSetting`
 *    (`tickets.geofence.mode`), así que cambiar el valor por defecto del código no
 *    habría hecho nada: el ajuste guardado manda sobre él.
 *
 * Lo que NO hace, a propósito: tocar el radio (100 m) ni la lista de tipos de campo.
 * La cerca sólo aplica a las visitas a domicilio —el 13% de los cierres—; aplicarla a
 * cortes y reconexiones pararía la operación (ver `geofence.policy.ts`).
 *
 * Correr:  npx ts-node --transpile-only prisma/migrate-tecnico-agenda-diaria-2026-09.ts [--dry]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY = process.argv.includes('--dry');

const ROL_TECNICOS = 'area-tecnicos';
const PANTALLA_TAREAS = 'screen.tareas';
const K_MODO = 'tickets.geofence.mode';
const MODO = 'exigir';

/** 1) El Panel de Tareas deja de ser del técnico. */
async function quitarTareasAlTecnico() {
  const rol = await prisma.role.findUnique({ where: { key: ROL_TECNICOS }, select: { id: true, name: true } });
  if (!rol) { console.log(`· rol ${ROL_TECNICOS}: no existe, nada que hacer`); return; }

  const permiso = await prisma.permission.findUnique({ where: { key: PANTALLA_TAREAS }, select: { id: true } });
  if (!permiso) { console.log(`· permiso ${PANTALLA_TAREAS}: no existe, nada que hacer`); return; }

  const tiene = await prisma.rolePermission.findFirst({
    where: { roleId: rol.id, permissionId: permiso.id },
    select: { roleId: true },
  });
  if (!tiene) { console.log(`· ${rol.name} ya no tiene ${PANTALLA_TAREAS}`); return; }

  if (DRY) { console.log(`· ${rol.name}: se le quitaría ${PANTALLA_TAREAS} (SECO)`); return; }
  await prisma.rolePermission.deleteMany({ where: { roleId: rol.id, permissionId: permiso.id } });
  console.log(`· ${rol.name}: ${PANTALLA_TAREAS} retirado`);
}

/** 2) La geo-cerca del cierre pasa a exigir. */
async function cercaExigir() {
  const actual = await prisma.appSetting.findUnique({ where: { key: K_MODO }, select: { value: true } });
  if (actual?.value === MODO) { console.log(`· ${K_MODO} ya está en '${MODO}'`); return; }
  if (DRY) { console.log(`· ${K_MODO}: '${actual?.value ?? '(sin poner)'}' → '${MODO}' (SECO)`); return; }
  await prisma.appSetting.upsert({
    where: { key: K_MODO },
    update: { value: MODO },
    // `group` a 'tickets' como el resto de los ajustes de órdenes: la pantalla de
    // configuración los agrupa por ahí (la fila ya existe hoy, así que en la
    // práctica se toma la rama del update).
    create: { key: K_MODO, value: MODO, group: 'tickets' },
  });
  console.log(`· ${K_MODO}: '${actual?.value ?? '(sin poner)'}' → '${MODO}'`);
}

async function main() {
  console.log(DRY ? '— SECO: no se escribe nada —' : '— aplicando —');
  await quitarTareasAlTecnico();
  await cercaExigir();
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
