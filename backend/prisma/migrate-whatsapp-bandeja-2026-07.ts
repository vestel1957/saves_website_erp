/**
 * Migración puntual: bandeja de WhatsApp (2026-07-29).
 * Idempotente — seguro de correr varias veces.
 *
 *  - Da de alta los permisos nuevos: `whatsapp.inbox` (atender la bandeja) y
 *    `screen.whatsapp` (ver el módulo en el menú).
 *  - Se los concede a los roles que atienden clientes: administración, caja y
 *    sistemas (el superusuario no los necesita: los cumple por el bypass del guard,
 *    pero se le conceden igual para que el árbol de permisos se vea completo).
 *  - Rellena `WhatsappConversation` con el historial que ya existe en
 *    `WhatsappMessage`. Sin esto la bandeja abre vacía el primer día y parece rota:
 *    las conversaciones solo aparecerían a medida que alguien volviera a escribir.
 *
 * NO se usa `migrate-roles-2026-06.ts` a propósito: ese resincroniza TODOS los roles
 * del catálogo contra el código y hoy revertiría 6 concesiones hechas a mano en la BD
 * (los permisos de red de `area-administracion`, entre otros). Añadir un módulo no
 * puede quitarle acceso a nadie, así que aquí solo se AÑADE.
 *
 * Correr:  npx ts-node prisma/migrate-whatsapp-bandeja-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { APP_PERMISSIONS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const NUEVOS: { key: string; label: string }[] = [
  { key: APP_PERMISSIONS.WHATSAPP_INBOX, label: 'Atender la bandeja de WhatsApp (ver y responder chats)' },
  { key: screenKey('/whatsapp'), label: 'Bandeja de WhatsApp (chats)' },
];

/** Roles que atienden clientes por WhatsApp. */
const ROLES = ['area-administracion', 'area-caja', 'area-sistemas', 'super-admin'];

async function main() {
  const permisos = [];
  for (const p of NUEVOS) {
    const perm = await prisma.permission.upsert({
      where: { key: p.key },
      update: { label: p.label },
      create: { key: p.key, label: p.label },
    });
    permisos.push(perm);
    console.log(`✓ permiso ${p.key}`);
  }

  for (const key of ROLES) {
    const role = await prisma.role.findUnique({ where: { key } });
    if (!role) {
      console.log(`· rol ${key} no existe — se omite`);
      continue;
    }
    for (const perm of permisos) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
    console.log(`✓ ${key} puede atender la bandeja`);
  }

  await rellenarConversaciones();

  console.log('\n✅ Bandeja de WhatsApp habilitada.');
}

/**
 * Crea una conversación por cada teléfono que ya tenga mensajes registrados.
 *
 * `unread` se deja en 0 a propósito: son mensajes de antes de que existiera la
 * bandeja, y arrancar con 200 "sin leer" que nadie va a leer entrena a la gente a
 * ignorar el contador. El estado sale del bot: si la conversación está escalada
 * (`ChatbotSession.handoffAt`), entra como PENDIENTE — esa gente SÍ está esperando.
 */
async function rellenarConversaciones() {
  const ultimos = await prisma.$queryRaw<
    { phone: string; body: string; direction: string; createdAt: Date; subscriberId: string | null }[]
  >`SELECT DISTINCT ON (phone) phone, body, direction, "createdAt", "subscriberId"
      FROM "WhatsappMessage" ORDER BY phone, "createdAt" DESC`;
  const entrantes = await prisma.$queryRaw<{ phone: string; createdAt: Date }[]>`
    SELECT DISTINCT ON (phone) phone, "createdAt"
      FROM "WhatsappMessage" WHERE direction = 'IN' ORDER BY phone, "createdAt" DESC`;
  const ultimoEntrante = new Map(entrantes.map((e) => [e.phone, e.createdAt]));

  const escalados = await prisma.chatbotSession.findMany({
    where: { handoffAt: { not: null } },
    select: { convKey: true, handoffReason: true },
  });
  const colaPorTelefono = new Map(
    escalados.map((s) => [s.convKey.replace(/\D/g, '').slice(-10), s.handoffReason]),
  );

  let creadas = 0;
  for (const u of ultimos) {
    const existe = await prisma.whatsappConversation.findUnique({ where: { phone: u.phone } });
    if (existe) continue;
    const motivo = colaPorTelefono.get(u.phone.slice(-10));
    await prisma.whatsappConversation.create({
      data: {
        phone: u.phone,
        subscriberId: u.subscriberId,
        status: motivo !== undefined ? 'PENDIENTE' : 'BOT',
        handoffReason: motivo ?? null,
        preview: (u.body || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        lastDirection: u.direction,
        lastMessageAt: u.createdAt,
        lastInboundAt: ultimoEntrante.get(u.phone) ?? null,
        unread: 0,
      },
    });
    creadas++;
  }
  console.log(`✓ ${creadas} conversación(es) creadas desde el historial (${ultimos.length} teléfono(s) con mensajes)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
