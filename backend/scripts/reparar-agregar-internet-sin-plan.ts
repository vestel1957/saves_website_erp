import 'reflect-metadata';
/**
 * Rescate de las órdenes 'AgregarInternet' que se cerraron SIN montarle el internet
 * al cliente.
 *
 * Entre el 01 y el 07 de septiembre de 2026 se cerraron tres de estas órdenes y no
 * pasó nada: el formulario no pedía el plan de internet y 'AgregarInternet' no caía
 * en ninguna rama de `applyCloseCascade`. El cliente se quedó con la televisión
 * sola, sin `SubscriberService` de internet —o sea invisible para la corrida
 * mensual— y, en la #505503, con los 30.000 del cargo ya facturados.
 *
 * Lo que hace, cliente por cliente, es exactamente lo que hace hoy el cierre:
 * pone el plan en la orden (`planToId`) y vuelve a cerrarla, que es lo que dispara
 * la cascada arreglada. No se reimplementa nada aquí a propósito — si el rescate
 * pasara por otro camino que el cierre normal, probaría otra cosa distinta de la
 * que va a correr mañana.
 *
 * Uso:  npx ts-node scripts/reparar-agregar-internet-sin-plan.ts [--aplicar]
 * Sin `--aplicar` sólo dice qué haría.
 */
import { prismaService, supportWriteService } from '../src/core/contenedor';
import type { AuthUser } from '../src/auth/current-user.decorator';

/** Qué plan le corresponde a cada orden, decidido con el usuario. */
const RESCATE: Array<{ code: number; plan: string; porque: string }> = [
  { code: 505503, plan: '300 Megas --', porque: 'la observación pide 300 Mg; plan activo del catálogo (decisión del usuario)' },
  // El legacy (`temporales`) dice 900Megas26F y la observación dice "facturando
  // 140.000": 113.500 + 25.210 de su televisión = 138.710. Manda la orden, no el
  // perfil 100Megas que el técnico dejó puesto en el router — ése se corrige al
  // aplicar el plan.
  { code: 325755, plan: '900Megas26F', porque: 'lo que pide la orden en el legacy y lo que cuadra con los 140.000 de la observación (decisión del usuario)' },
  // El legacy pide '100 Megas F' ($68.250), que nunca se importó al catálogo (allá
  // está sin marcar como internet). Se deja en el plan de 100 que se vende hoy.
  { code: 505127, plan: '100 MEGAS --', porque: 'el «100 Megas F» del legacy no está en el catálogo; se deja en el de 100 activo (decisión del usuario)' },
];

/**
 * Quien firma la reparación. Va con nombre y no como 'Sistema' porque el cambio de
 * plan y el cobro quedan auditados y tiene que poder preguntarse quién los hizo.
 */
const USUARIO: AuthUser = {
  id: 'script-rescate', name: 'Rescate AgregarInternet', email: 'soporte@vestel.com.co',
  areas: [], sedes: [], superuser: true,
} as unknown as AuthUser;

const APLICAR = process.argv.includes('--aplicar');

async function main() {
  for (const r of RESCATE) {
    const t = await prismaService.ticket.findFirst({
      where: { code: r.code },
      select: { id: true, code: true, type: true, status: true, subscriberId: true, planToId: true, planAppliedAt: true },
    });
    if (!t) { console.log(`❌ #${r.code}: no existe`); continue; }
    if (!t.subscriberId) { console.log(`❌ #${r.code}: sin cliente`); continue; }

    const plan = await prismaService.plan.findFirst({
      where: { name: r.plan, kind: 'INTERNET' },
      select: { id: true, name: true, megas: true, price: true, active: true },
    });
    if (!plan) { console.log(`❌ #${r.code}: no existe el plan «${r.plan}»`); continue; }

    const s = await prismaService.subscriber.findUnique({
      where: { id: t.subscriberId },
      select: { abonado: true, fullName: true, pppUsername: true, pppProfile: true },
    });
    const yaTiene = await prismaService.subscriberService.count({ where: { subscriberId: t.subscriberId, kind: 'INTERNET' } });

    console.log(`\n── #${t.code} · ${s?.fullName ?? 'sin nombre'} (abonado ${s?.abonado}) · ${t.type} · ${t.status}`);
    console.log(`   plan → «${plan.name}»${plan.megas != null ? ` (${plan.megas} Megas)` : ''} · $${Number(plan.price).toLocaleString('es-CO')} · ${plan.active ? 'activo' : 'OCULTO'}`);
    console.log(`   motivo: ${r.porque}`);
    console.log(`   hoy: ppp "${s?.pppUsername}" perfil "${s?.pppProfile}" · servicio de internet: ${yaTiene ? 'YA LO TIENE (no se toca)' : 'ninguno'}`);
    if (yaTiene) continue;
    if (!APLICAR) { console.log('   (en seco: no se escribió nada)'); continue; }

    // 1) La orden pasa a decir con qué plan queda el cliente.
    //
    // Un plan OCULTO no pasa por `updateTicket`, y está bien que no pase: allí se
    // está vendiendo velocidad nueva y un plan retirado del catálogo no se le vende
    // a nadie. Pero esto no es una venta nueva: es escribir en la orden el plan que
    // el cliente YA compró (y que sigue vigente en el legacy). Por eso, y sólo para
    // los ocultos, se escriben las mismas columnas a mano; el cierre después los
    // aplica con `allowInactive`, igual que "asignar servicio" desde la factura.
    if (plan.active) {
      const editada = await supportWriteService.updateTicket(t.id, { planToId: plan.id } as any, USUARIO);
      console.log('   ✏', (editada as any).cambios?.join(' · ') || 'sin cambios');
    } else {
      await prismaService.ticket.update({
        where: { id: t.id },
        data: { planToId: plan.id, planToName: plan.name, planToMegas: plan.megas, planAppliedAt: null },
      });
      console.log(`   ✏ plan destino escrito a mano: «${plan.name}» (oculto en el catálogo)`);
    }

    // 2) Y se vuelve a cerrar: eso dispara la cascada, que es la que monta el
    // servicio, crea el secret y cobra los días que quedan del mes.
    const cerrada = await supportWriteService.updateStatus(t.id, { status: 'RESUELTO' } as any, USUARIO);
    console.log('   ✅', (cerrada as any).cascade?.mensaje ?? (cerrada as any).mensaje ?? JSON.stringify(cerrada));
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prismaService.$disconnect());
