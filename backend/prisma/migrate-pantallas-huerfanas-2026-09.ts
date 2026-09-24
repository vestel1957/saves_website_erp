/**
 * Pantallas que estaban en el MENÚ pero no en el catálogo de permisos (2026-09-19).
 * Idempotente.
 *
 * El síntoma con el que llegó: Cristhian Dueñas (redes@, área Administración) no
 * podía entrar a las VLANs ni al mapa. No era un permiso denegado — era que la
 * llave no existía: `frontend/src/lib/nav.ts` le pide a cada hoja del menú el
 * permiso `screenKey(href)`, y si ese permiso no está en `SCREENS` nadie lo tiene,
 * así que `can()` sólo lo da por bueno a `system.admin`. Resultado: la entrada es
 * invisible para todo el mundo menos el superusuario — y quien prueba suele ser
 * superusuario, por eso no se cazó antes. Es la MISMA trampa que ya documenta el
 * comentario de `/red/naps` en el catálogo.
 *
 * Ocho entradas estaban así. Las áreas que se les conceden son exactamente las que
 * el gate de URL (`frontend/src/middleware.ts`) ya dejaba pasar: no se abre ninguna
 * puerta nueva, se deja de esconder la que ya era suya.
 *
 * `/documentacion` NO entra: lleva `public: true` en el nav a propósito (los
 * manuales los ve cualquiera) y por eso no se le deriva llave.
 *
 * Correr:  npx ts-node prisma/migrate-pantallas-huerfanas-2026-09.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

/** Las ocho hojas del menú que no tenían llave. Se leen del catálogo, no se repiten aquí. */
const PANTALLAS = [
  '/clientes/grupos',
  '/mapa',
  '/soporte/geocerca',
  '/red/vlans',
  '/configuracion/categorias',
  '/configuracion/contratos',
  '/configuracion/promociones',
  '/configuracion/whatsapp/plantillas',
];

/** Área del catálogo -> rol que la empaqueta (`ALL_ROLES`). */
const ROL_DE_AREA: Record<string, string> = {
  gerencia: 'area-gerencia',
  administracion: 'area-administracion',
  contabilidad: 'area-contabilidad',
  tecnicos: 'area-tecnicos',
  sistemas: 'area-sistemas',
  caja: 'area-caja',
};

async function main() {
  // 1) Sembrar el catálogo entero (las ocho llaves nuevas nacen aquí).
  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { label: p.label },
      create: { key: p.key, label: p.label },
    });
  }

  let concedidas = 0;
  let yaEstaban = 0;

  for (const href of PANTALLAS) {
    const def = SCREENS.find((s) => s.href === href);
    if (!def) {
      console.error(`✗ ${href} no está en SCREENS — el catálogo y este script no concuerdan.`);
      process.exitCode = 1;
      return;
    }
    const llave = screenKey(href);
    const permiso = await prisma.permission.findUnique({ where: { key: llave }, select: { id: true } });
    if (!permiso) {
      console.error(`✗ No se sembró el permiso ${llave}.`);
      process.exitCode = 1;
      return;
    }

    console.log(`\n${llave}  (${def.label})`);
    for (const area of def.areas) {
      const rolKey = ROL_DE_AREA[area];
      if (!rolKey) { console.log(`    · área '${area}' sin rol empaquetado — se salta`); continue; }
      const rol = await prisma.role.findUnique({ where: { key: rolKey }, select: { id: true, name: true } });
      if (!rol) { console.log(`    · rol ${rolKey} no existe en esta base — se salta`); continue; }

      const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
      if (ya) { yaEstaban++; console.log(`    · ${rol.name.padEnd(16)} ya la tenía`); continue; }
      await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
      concedidas++;
      console.log(`    + ${rol.name.padEnd(16)} CONCEDIDA`);
    }
  }

  console.log(`\n✓ ${concedidas} concesión(es) nueva(s), ${yaEstaban} que ya estaban.`);

  // 2) Comprobación en vivo sobre el caso que lo destapó: el área de Administración
  //    tiene que ver VLANs y Mapa. Un DENY personal seguiría ganando (es lo correcto),
  //    así que se avisa si alguien lo tiene.
  for (const href of ['/red/vlans', '/mapa']) {
    const llave = screenKey(href);
    const denies = await prisma.userPermission.findMany({
      where: { effect: 'DENY', permission: { key: llave } },
      select: { user: { select: { email: true, name: true } } },
    });
    if (denies.length) {
      console.log(`\n  ⚠ ${llave} está DENEGADA a mano a: ${denies.map((d) => d.user.email).join(', ')}`);
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
