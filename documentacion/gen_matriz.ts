/**
 * Genera `documentacion/fuentes/_matriz-roles.md`: la matriz de roles, permisos y
 * pantallas del ERP, DERIVADA DEL CODIGO (no escrita a mano), para que no se
 * desactualice sola.
 *
 * Fuentes de verdad que cruza:
 *  · backend/src/auth/permissions.catalog.ts → roles, permisos y pantallas declaradas
 *  · frontend/src/lib/nav.ts                 → pantallas que REALMENTE tiene el menu
 *  · backend/src/**\/*.ts                     → donde se EXIGE cada permiso (@RequirePermissions)
 *  · base de datos (opcional)                → cuantos usuarios tiene cada rol
 *
 * Uso (desde la raiz del repo):
 *   backend/node_modules/.bin/ts-node --transpile-only -O '{"module":"commonjs"}' \
 *     documentacion/gen_matriz.ts
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  ALL_PERMISSIONS,
  ALL_ROLES,
  APP_PERMISSIONS,
  INV_PERMISSIONS,
  PAYROLL_PERMISSIONS,
  SCREENS,
  SST_PERMISSIONS,
  screenKey,
} from '../backend/src/auth/permissions.catalog';
import { navSections } from '../frontend/src/lib/nav';

const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'documentacion', 'fuentes', '_matriz-roles.md');

const AREAS = ['gerencia', 'administracion', 'contabilidad', 'tecnicos', 'sistemas', 'caja'] as const;
const AREA_LABEL: Record<string, string> = {
  gerencia: 'Ger.',
  administracion: 'Admin.',
  contabilidad: 'Cont.',
  tecnicos: 'Tec.',
  sistemas: 'Sist.',
  caja: 'Caja',
};

/**
 * Roles cuyo MODULO no existe todavia (no hay pantallas construidas para ellos),
 * a diferencia de los que si tienen modulo pero no traen sus llaves `screen.*`.
 * La distinción no se puede derivar del catalogo: se mantiene a mano aqui.
 *
 * Vacia desde el 2026-07-29: los seis roles que estaban aqui (mantenimiento,
 * nomina, autoservicio y los tres de SST) se retiraron precisamente por eso.
 * Si vuelve a crearse un rol antes que su modulo, va aqui.
 */
const SIN_MODULO = new Set<string>([]);

// ── utilidades ──────────────────────────────────────────────────────────────
const isScreen = (k: string) => k.startsWith('screen.');
const esc = (s: string) => s.replace(/\|/g, '\\|');
const SI = 'Sí';
const NO = '—';

/** Todos los .ts de un arbol, recursivo. */
function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

/** key → nombre de la constante, para resolver `APP_PERMISSIONS.X` a su llave. */
const CONST_TO_KEY = new Map<string, string>();
for (const [obj, name] of [
  [APP_PERMISSIONS, 'APP_PERMISSIONS'],
  [INV_PERMISSIONS, 'INV_PERMISSIONS'],
  [SST_PERMISSIONS, 'SST_PERMISSIONS'],
  [PAYROLL_PERMISSIONS, 'PAYROLL_PERMISSIONS'],
] as const) {
  for (const [prop, key] of Object.entries(obj as Record<string, string>)) {
    CONST_TO_KEY.set(`${name}.${prop}`, key);
  }
}

/** Permisos que el backend EXIGE de verdad en algun endpoint. */
function enforcedPermissions(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(join(ROOT, 'backend', 'src'))) {
    if (file.endsWith('permissions.catalog.ts')) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/RequirePermissions\(([^)]*)\)/g)) {
      for (const raw of m[1].split(',')) {
        const tok = raw.trim();
        if (!tok) continue;
        const lit = tok.match(/^['"`](.+)['"`]$/);
        if (lit) found.add(lit[1]);
        else if (CONST_TO_KEY.has(tok)) found.add(CONST_TO_KEY.get(tok)!);
      }
    }
  }
  return found;
}

/** Areas que el backend exige con @RequireArea(). */
function enforcedAreas(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(join(ROOT, 'backend', 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/RequireArea\(([^)]*)\)/g)) {
      for (const raw of m[1].split(',')) {
        const lit = raw.trim().match(/^['"`](.+)['"`]$/);
        if (lit) found.add(lit[1]);
      }
    }
  }
  return found;
}

/**
 * Permisos que la INTERFAZ verifica citandolos literalmente (`can("...")`, gates
 * de ruta, etc.). Las llaves `screen.*` no se cuentan aqui porque el frontend las
 * deriva de la ruta (`screenKey(href)`) y nunca aparecen escritas.
 */
function usedInFrontend(allKeys: string[]): Set<string> {
  const found = new Set<string>();
  const corpus = walk(join(ROOT, 'frontend', 'src'))
    .filter((f) => !f.endsWith(join('lib', 'auth.ts'))) // solo declara el catalogo espejo
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  for (const key of allKeys) {
    if (isScreen(key)) continue;
    if (corpus.includes(`"${key}"`) || corpus.includes(`'${key}'`)) found.add(key);
  }
  return found;
}

/** Hojas del menu real (href + etiqueta + seccion). */
function navLeaves(): { href: string; label: string; section: string }[] {
  const out: { href: string; label: string; section: string }[] = [];
  const rec = (items: any[], section: string) => {
    for (const it of items) {
      if (it.children?.length) rec(it.children, section);
      else if (it.href) out.push({ href: it.href, label: it.label, section });
    }
  };
  for (const s of navSections) rec(s.items as any[], s.title);
  return out;
}

interface DbRole {
  key: string;
  name: string;
  description: string | null;
  users: number;
  screens: number;
  actions: string[];
}

/** Roles y usuarios tal como estan EN LA BASE (incluye los creados desde la UI). */
async function dbRoles(): Promise<DbRole[] | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaClient } = require(join(ROOT, 'backend', 'node_modules', '@prisma', 'client'));
    const prisma = new PrismaClient();
    const rows = await prisma.role.findMany({
      select: {
        key: true,
        name: true,
        description: true,
        _count: { select: { users: true } },
        permissions: { select: { permission: { select: { key: true } } } },
      },
    });
    await prisma.$disconnect();
    return rows.map((r: any) => {
      const keys: string[] = r.permissions.map((rp: any) => rp.permission.key);
      return {
        key: r.key,
        name: r.name,
        description: r.description,
        users: r._count.users,
        screens: keys.filter(isScreen).length,
        actions: keys.filter((k) => !isScreen(k)),
      };
    });
  } catch {
    return null;
  }
}

// ── construccion del documento ──────────────────────────────────────────────
async function main() {
  const enforced = enforcedPermissions();
  const areasEnforced = enforcedAreas();
  // Los permisos de area no se exigen con @RequirePermissions sino con
  // @RequireArea('slug'): sin esto se reportarian como "declarados sin uso".
  for (const slug of areasEnforced) enforced.add(`area.${slug}`);
  // Y hay permisos que solo gatean botones/pantallas en la interfaz.
  for (const k of usedInFrontend(ALL_PERMISSIONS.map((x) => x.key))) enforced.add(k);
  const leaves = navLeaves();
  const db = await dbRoles();
  const counts = db ? new Map(db.map((r) => [r.key, r.users])) : null;

  const catalogScreens = new Set(SCREENS.map((s) => s.href));
  const navHrefs = new Set(leaves.map((l) => l.href));
  const permLabel = new Map(ALL_PERMISSIONS.map((p) => [p.key, p.label]));

  const L: string[] = [];
  const p = (s = '') => L.push(s);

  p('# Matriz de Roles y Permisos');
  p();
  p('Este documento es la **referencia técnica** del control de acceso de SAVES: qué roles existen,');
  p('qué permisos trae cada uno y a qué pantallas llega. Se **genera del código**');
  p('(`permissions.catalog.ts` y `nav.ts`), no se escribe a mano, para que no se desactualice.');
  p();
  p('Los manuales por rol explican *cómo trabajar*. Este documento responde *quién puede qué*, y es');
  p('el que se usa para asignar accesos, para una auditoría o para revisar un incidente.');
  p();

  // ── Como funciona el acceso ──
  p('## Cómo funciona el acceso');
  p();
  p('El acceso de una persona se arma con **tres capas** que se suman:');
  p();
  p('| Capa | Qué controla | Ejemplo |');
  p('|---|---|---|');
  p('| **Área** | Qué sección del menú ve | `area.tecnicos` habilita la operación de red |');
  p('| **Pantalla** | Cada opción concreta del menú | `screen.red.olt` habilita "Gestión OLT" |');
  p('| **Acción** | Operaciones delicadas, aparte del área | `network.cut` permite cortar servicio |');
  p();
  p('Reglas que conviene tener presentes:');
  p();
  p('- **`system.admin` (Superadministrador) pasa cualquier verificación.** Es el único acceso total.');
  p('- **`inventory.admin` (Jefe de bodega) es superusuario solo del inventario**: pasa las');
  p('  verificaciones `inventory.*` y ninguna otra.');
  p('- **Cada opción del menú exige su propia llave `screen.*`**, derivada de su ruta');
  p('  (`/facturacion/notas` → `screen.facturacion.notas`). Un rol sin llaves `screen.*` deja el');
  p('  menú vacío aunque traiga permisos de acción.');
  p('- Las **acciones destructivas** se conceden **aparte del área**, a propósito: así se puede');
  p('  tener un técnico que ve la red pero no corta el servicio.');
  p('- Los permisos por **empleado** (ficha del empleado → Permisos y accesos) se suman al rol.');
  p('  Solo el Superadministrador puede otorgarlos.');
  p();

  // ── Tabla A: roles ──
  p('## Los roles del sistema');
  p();
  p('Un rol es una **plantilla de permisos**. La columna *Pantallas* dice cuántas opciones de menú');
  p('abre por sí solo: si dice 0, el rol necesita que se le habiliten pantallas aparte para que la');
  p('persona pueda trabajar.');
  p();
  const head = counts
    ? '| Rol | Grupo | Permisos | Pantallas | Usuarios | Estado |'
    : '| Rol | Grupo | Permisos | Pantallas | Estado |';
  p(head);
  p(counts ? '|---|---|---:|---:|---:|---|' : '|---|---|---:|---:|---|');

  const roleRows = ALL_ROLES.map((r) => {
    const screens = r.permissions.filter(isScreen).length;
    const isSuper = r.permissions.includes(APP_PERMISSIONS.SYSTEM_ADMIN);
    let estado: string;
    if (isSuper) estado = 'Acceso total';
    else if (screens > 0) estado = 'Operativo';
    else if (SIN_MODULO.has(r.key)) estado = 'Sin operación: módulo sin pantallas';
    else estado = 'Requiere habilitar pantallas';
    return { r, screens, perms: r.permissions.length, estado };
  });

  for (const { r, screens, perms, estado } of roleRows) {
    const u = counts ? ` ${counts.get(r.key) ?? 0} |` : '';
    p(`| **${esc(r.name)}** | ${esc(r.area)} | ${perms} | ${screens} |${u} ${estado} |`);
  }
  p();
  p('Los tres estados significan cosas distintas:');
  p();
  p('| Estado | Qué quiere decir | Qué hacer |');
  p('|---|---|---|');
  p('| **Operativo** | El rol abre por sí solo las pantallas de su trabajo | Asignarlo y listo |');
  p('| **Requiere habilitar pantallas** | El módulo existe, pero el rol no trae sus llaves `screen.*`: quien lo tenga entra y ve el menú vacío | Concederle las pantallas en la ficha del empleado, o sumarle un rol de área |');
  p('| **Sin operación: módulo sin pantallas** | Los permisos existen pero el módulo aún no se ha construido | Nada por ahora; el rol todavía no sirve |');
  p();
  p('> **Ojo con los roles de 0 pantallas.** Es la causa más frecuente de "no puedo entrar" o "no veo');
  p('> nada": la persona está bien autenticada y con su rol correcto, pero ningún permiso de pantalla');
  p('> le abre el menú. No es un problema de contraseña.');
  p();

  // ── Roles personalizados creados desde la interfaz ──
  if (db) {
    const catalogKeys = new Set(ALL_ROLES.map((r) => r.key));
    const custom = db.filter((r) => !catalogKeys.has(r.key)).sort((a, b) => a.name.localeCompare(b.name));
    p('### Roles personalizados');
    p();
    if (custom.length) {
      p('Roles creados desde *Configuración → Usuarios y roles* con el constructor de roles. No están');
      p('en el catálogo del código: viven solo en la base de datos y se editan desde la interfaz.');
      p();
      p('| Rol | Pantallas | Permisos de acción | Usuarios |');
      p('|---|---:|---:|---:|');
      for (const r of custom) {
        p(`| **${esc(r.name)}** | ${r.screens} | ${r.actions.length} | ${r.users} |`);
      }
      p();
      p('> Los roles del catálogo son de **solo lectura** en la interfaz (se pueden clonar, no editar);');
      p('> los personalizados sí se editan y se borran. Al clonar un rol del sistema se obtiene un');
      p('> personalizado con los mismos permisos, listo para ajustar.');
    } else {
      p('No hay roles personalizados: todos los roles de la base vienen del catálogo del sistema.');
    }
    p();
  }

  // ── Tabla B: pantallas x area ──
  p('## Qué pantalla ve cada área');
  p();
  p('Las seis áreas de Vestel y las pantallas que cada una trae por defecto.');
  p();
  p(`| Pantalla | Ruta | ${AREAS.map((a) => AREA_LABEL[a]).join(' | ')} |`);
  p(`|---|---|${AREAS.map(() => ':-:').join('|')}|`);
  const byModule = new Map<string, typeof SCREENS>();
  for (const s of SCREENS) {
    if (!byModule.has(s.module)) byModule.set(s.module, [] as any);
    (byModule.get(s.module) as any).push(s);
  }
  for (const [mod, screens] of byModule) {
    p(`| **${esc(mod)}** | | ${AREAS.map(() => '').join(' | ')} |`);
    for (const s of screens) {
      const cells = AREAS.map((a) => (s.areas.includes(a) ? SI : NO));
      p(`| ${esc(s.label)} | \`${s.href}\` | ${cells.join(' | ')} |`);
    }
  }
  p();
  p('> El **Superadministrador** ve todas las pantallas por su acceso total (`system.admin`); no');
  p('> aparece como columna porque no depende de esta tabla.');
  p();

  // ── Tabla C: permisos de accion ──
  p('## Permisos de acción y operaciones críticas');
  p();
  p('Estos permisos no habilitan pantallas: habilitan **operaciones**. La columna *Se exige* dice si');
  p('el sistema lo verifica hoy al ejecutar la operación; los que dicen "—" están declarados pero');
  p('todavía no protegen nada (el módulo correspondiente no existe o no los usa).');
  p();
  p('| Permiso | Qué habilita | Se exige | Roles que lo traen |');
  p('|---|---|:-:|---|');
  const actionKeys = ALL_PERMISSIONS.filter((x) => !isScreen(x.key)).map((x) => x.key);
  const critical = [
    APP_PERMISSIONS.SYSTEM_ADMIN,
    APP_PERMISSIONS.USERS_MANAGE,
    APP_PERMISSIONS.WHATSAPP_MANAGE,
    APP_PERMISSIONS.NETWORK_CUT,
    APP_PERMISSIONS.NETWORK_RECONNECT,
    APP_PERMISSIONS.NETWORK_ROUTERS_MANAGE,
    APP_PERMISSIONS.NETWORK_OLT_MANAGE,
    APP_PERMISSIONS.CRON_RUN,
    APP_PERMISSIONS.PURCHASES_APPROVE,
    INV_PERMISSIONS.ADMIN,
    INV_PERMISSIONS.ASSETS_ASSIGN,
    APP_PERMISSIONS.HR_ACCESS_MANAGE,
    APP_PERMISSIONS.HR_EMPLOYEES_WRITE,
    APP_PERMISSIONS.ACCOUNTING_MANAGE,
    APP_PERMISSIONS.DASHBOARD_VIEW,
  ].filter((k) => actionKeys.includes(k));
  for (const key of critical) {
    const holders = ALL_ROLES.filter((r) => r.permissions.includes(key)).map((r) => r.name);
    const shown =
      holders.length > 6 ? `${holders.slice(0, 5).join(', ')} y ${holders.length - 5} más` : holders.join(', ');
    p(
      `| \`${key}\` | ${esc(permLabel.get(key) ?? '')} | ${enforced.has(key) ? SI : NO} | ${esc(shown || NO)} |`,
    );
  }
  p();
  p('**Áreas que el sistema verifica hoy del lado del servidor:** ' +
    (areasEnforced.size ? [...areasEnforced].sort().map((a) => `\`${a}\``).join(', ') : 'ninguna') + '.');
  p();

  // ── Tabla D/E: coherencia catalogo vs menu ──
  const missingInCatalog = leaves.filter((l) => !catalogScreens.has(l.href));
  const orphanInCatalog = SCREENS.filter((s) => !navHrefs.has(s.href));

  p('## Coherencia entre el menú y el catálogo');
  p();
  p('El catálogo de pantallas debe ser el espejo del menú. Cuando una opción del menú **no** está en');
  p('el catálogo, no existe la llave `screen.*` que permitiría concederla: esa opción queda visible');
  p('**solo para el Superadministrador**, y no hay forma de dársela a nadie más sin tocar el código.');
  p();
  if (missingInCatalog.length) {
    p(`**Opciones del menú sin llave en el catálogo (${missingInCatalog.length}):** hoy solo las ve el Superadministrador.`);
    p();
    p('| Sección del menú | Opción | Ruta |');
    p('|---|---|---|');
    for (const l of missingInCatalog) p(`| ${esc(l.section)} | ${esc(l.label)} | \`${l.href}\` |`);
    p();
    p('> Esta tabla es una **lista de pendientes**, no una descripción de cómo debería ser. Cada fila');
    p('> es una pantalla que su área no puede ver: mientras la llave no exista, quien la necesita');
    p('> tiene que pedirle a un Superadministrador que haga esa operación por él.');
    p();
  } else {
    p('**Todas las opciones del menú tienen su llave en el catálogo.** Nada queda restringido al');
    p('Superadministrador por omisión.');
    p();
  }
  if (orphanInCatalog.length) {
    p(`**Llaves del catálogo que ya no están en el menú (${orphanInCatalog.length}):** son permisos que se pueden`);
    p('conceder pero no llevan a ninguna opción visible.');
    p();
    p('| Pantalla | Ruta |');
    p('|---|---|');
    for (const s of orphanInCatalog) p(`| ${esc(s.label)} | \`${s.href}\` |`);
    p();
  }

  // ── Anexo: detalle por rol ──
  p('## Anexo: detalle de cada rol');
  p();
  p('Los permisos de **acción** de cada rol, uno por uno. Las llaves `screen.*` se resumen en el');
  p('total de pantallas para no alargar la lista.');
  p();
  p('La marca *(declarado, aún sin uso)* señala un permiso que existe en el catálogo pero que');
  p('todavía no protege ninguna operación: concederlo o quitarlo hoy no cambia nada.');
  p();
  for (const { r, screens } of roleRows) {
    p(`### ${r.name}`);
    p();
    p(`*Llave:* \`${r.key}\` · *Grupo:* ${r.area}${counts ? ` · *Usuarios:* ${counts.get(r.key) ?? 0}` : ''}`);
    p();
    p(r.description + '.');
    p();
    const actions = r.permissions.filter((k) => !isScreen(k));
    if (r.permissions.includes(APP_PERMISSIONS.SYSTEM_ADMIN)) {
      p('**Permisos:** todos los del sistema (acceso total por `system.admin`).');
    } else {
      p(`**Pantallas que abre:** ${screens}.`);
      p();
      if (actions.length) {
        p('**Permisos de acción:**');
        p();
        for (const k of actions) {
          p(`- \`${k}\` — ${permLabel.get(k) ?? 'sin etiqueta'}${enforced.has(k) ? '' : ' *(declarado, aún sin uso)*'}`);
        }
      } else {
        p('**Permisos de acción:** ninguno.');
      }
    }
    p();
  }

  writeFileSync(OUT, L.join('\n') + '\n', 'utf8');
  const stats = {
    roles: ALL_ROLES.length,
    permisos: ALL_PERMISSIONS.length,
    pantallasCatalogo: SCREENS.length,
    pantallasMenu: leaves.length,
    sinLlave: missingInCatalog.length,
    huerfanas: orphanInCatalog.length,
    usuariosBD: counts ? 'si' : 'no disponible',
  };
  console.log(`  OK ${OUT}`);
  console.log(`  ${JSON.stringify(stats)}`);
}

void main();
