/**
 * Transferencias de equipos entre sedes: quién manda y quién firma (2026-07-30).
 * Idempotente.
 *
 * Concede `screen.red.transferencias` al rol **Jefe de bodega** (`warehouse-manager`):
 * desde este cambio es el ÚNICO que puede armar una transferencia de una sede a otra,
 * y sin la pantalla no podría. (Su 403 histórico en las rutas gateadas por área lo
 * resuelve el escape `@OrPermission(inventory.admin)` del AreaGuard.)
 *
 * Y reporta lo que hace falta para que el flujo funcione de verdad:
 *   · qué cajeras se quedan sin sede (no crean ni firman),
 *   · qué cajeras no tienen a dónde recibir el código,
 *   · y en qué modo están los gates de la firma.
 *
 * Correr:  npx ts-node prisma/migrate-transferencias-entre-sedes-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, screenKey } from '../src/auth/permissions.catalog';
import { SIGN_OTP_LIVE_KEY, SIGN_OTP_REQUIRED_KEY } from '../src/common/signature/signature-otp.service';

const prisma = new PrismaClient();

const PANTALLA = '/red/transferencias';

async function main() {
  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key: p.key }, update: { label: p.label }, create: { key: p.key, label: p.label } });
  }

  // ── 1. La pantalla para el Jefe de bodega ────────────────────────────────────
  const key = screenKey(PANTALLA);
  const permiso = await prisma.permission.findUnique({ where: { key }, select: { id: true } });
  const rol = await prisma.role.findUnique({ where: { key: 'warehouse-manager' }, select: { id: true, name: true } });
  if (!permiso) {
    console.error(`✗ No existe el permiso ${key}.`);
    process.exitCode = 1;
    return;
  }
  if (!rol) {
    console.log('  ⚠ No existe el rol "warehouse-manager": nada que conceder.');
  } else {
    const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
    if (ya) console.log(`  + ${key.padEnd(30)} "${rol.name}" ya la tenía`);
    else {
      await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
      console.log(`  + ${key.padEnd(30)} CONCEDIDA a "${rol.name}"`);
    }
    const cuantos = await prisma.userRole.count({ where: { roleId: rol.id } });
    console.log(`    ℹ ${cuantos} usuario(s) tienen ese rol hoy.`);
    if (!cuantos) {
      console.log('    ⚠ Nadie lo tiene: hoy solo los superusuarios pueden mandar equipo entre sedes.');
    }
  }

  // ── 2. ¿Está todo listo para firmar? ────────────────────────────────────────
  const ajustes = await prisma.appSetting.findMany({ where: { key: { in: [SIGN_OTP_LIVE_KEY, SIGN_OTP_REQUIRED_KEY] } } });
  const val = (k: string) => ajustes.find((a) => a.key === k)?.value ?? null;
  const live = val(SIGN_OTP_LIVE_KEY) ?? (process.env.SIGN_OTP_LIVE === 'true' ? 'true (env)' : 'false (por defecto)');
  const required = val(SIGN_OTP_REQUIRED_KEY) ?? (process.env.SIGN_OTP_REQUIRED !== 'false' ? 'true (por defecto)' : 'false (env)');
  console.log(`\n  Firma con código: exigida=${required} · envío real por WhatsApp=${live}`);
  if (String(live).startsWith('false')) {
    console.log(`    ℹ En simulación el código NO sale por WhatsApp: se muestra en pantalla a quien lo pide.`);
    console.log(`      Para enviarlo de verdad: ajuste "${SIGN_OTP_LIVE_KEY}" = true y la plantilla "codigo_firma" aprobada en Meta.`);
  }

  // ── 3. Quién puede firmar de verdad ─────────────────────────────────────────
  const cajeras = await prisma.user.findMany({
    where: { isActive: true, roles: { some: { role: { key: 'area-caja' } } } },
    select: { name: true, email: true, whatsappPhone: true, signaturePhone: true, cajaLegacyId: true, sedesAccede: true },
  });
  const cuentas = await prisma.cashAccount.findMany({ select: { legacyId: true, branchLegacy: true } });
  const sedeDeCaja = new Map(cuentas.filter((c) => c.legacyId != null).map((c) => [c.legacyId as number, c.branchLegacy]));
  const sedes = new Map((await prisma.branch.findMany({ select: { legacyId: true, name: true } })).map((b) => [b.legacyId, b.name]));

  const problemas: string[] = [];
  console.log(`\n  Cajeras activas: ${cajeras.length}`);
  for (const c of cajeras) {
    const propias = new Set<number>(c.sedesAccede ?? []);
    const suya = c.cajaLegacyId != null ? sedeDeCaja.get(c.cajaLegacyId) : null;
    if (suya != null && suya > 0) propias.add(suya);
    const tel = c.signaturePhone ?? c.whatsappPhone;
    const falta = [!propias.size ? 'SIN SEDE' : null, !tel ? 'SIN CELULAR' : null].filter(Boolean).join(' + ');
    if (falta) problemas.push(`${falta.padEnd(22)} ${c.name} <${c.email}>`);
    else console.log(`    ✓ ${c.name.padEnd(32)} sedes: ${[...propias].map((s) => sedes.get(s) ?? s).join(', ')}`);
  }
  if (problemas.length) {
    console.log(`\n  ⚠ ${problemas.length} cajera(s) NO pueden firmar todavía:`);
    for (const p of problemas) console.log(`    · ${p}`);
    console.log('\n    SIN SEDE    → asígnale la sede (o su caja) en el usuario.');
    console.log('    SIN CELULAR → que lo defina en Mi perfil ▸ Seguridad ▸ Código de firma,');
    console.log('                  o vincúlale el WhatsApp en Configuración ▸ Chatbot.');
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
