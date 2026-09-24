/**
 * DATOS DEL CLIENTE ANTES DE EMPEZAR (2026-09-18), contra la API viva y SIN ESCRIBIR
 * NADA: comprueba que `requisitosInicio` viaja en el detalle de la orden y que dice
 * exactamente lo que dice la base (coordenada del abonado y fotos `kind=VIVIENDA`).
 *
 * Se hace con un técnico REAL y sus propias órdenes porque el alcance del técnico
 * —sólo lo suyo y sólo hoy— es parte de lo que hay que ver funcionando: si la
 * pantalla que tiene que pintar el aviso no puede leer la orden, el aviso no existe.
 *
 *   AUTH_SECRET=… npx ts-node --transpile-only scripts/smoke-datos-cliente-inicio.ts
 */
import { PrismaClient } from '@prisma/client';
import { signToken } from '../src/auth/crypto.util';

const prisma = new PrismaClient();
const API = `http://127.0.0.1:${process.env.PORT ?? 3061}/api`;
const CAMPO = ['Instalacion', 'Revision de Internet', 'Revision de television', 'Revision tv e internet', 'Traslado', 'Cambio de equipo', 'Migracion', 'Retiro voluntario'];

async function main() {
  let ok = 0, fail = 0, leidas = 0;

  const tecnicos = await prisma.staff.findMany({
    where: { email: { not: null }, tickets: { some: { status: 'PENDIENTE', type: { in: CAMPO } } } },
    select: { id: true, email: true, username: true },
    take: 8,
  });

  for (const tec of tecnicos) {
    const user = await prisma.user.findFirst({
      where: { email: tec.email! },
      select: {
        id: true, email: true, name: true,
        roles: { select: { role: { select: { permissions: { select: { permission: { select: { key: true } } } } } } } },
      },
    });
    if (!user) continue;
    /**
     * SÓLO AL TÉCNICO DE CAMPO (2026-09-18): a quien no lo es —superusuario, gerencia,
     * administración, contabilidad, jefe de bodega— el detalle tiene que decirle que
     * el requisito NI SIQUIERA APLICA. Se comprueba en vez de saltárselo, que es la
     * mitad del arreglo que pidió el usuario. Misma regla que `esTecnicoDeCampo`.
     */
    const permisos = new Set(user.roles.flatMap((r) => r.role.permissions.map((x) => x.permission.key)));
    const mando = ['area.gerencia', 'area.administracion', 'area.contabilidad'].some((a) => permisos.has(a));
    const esTecnicoDeCampo =
      permisos.has('area.tecnicos') && !permisos.has('system.admin') && !permisos.has('inventory.admin') && !mando;
    const token = signToken({ id: user.id, email: user.email, name: user.name ?? tec.username ?? 'tec' }, { areas: ['tecnicos'] });

    const ordenes = await prisma.ticket.findMany({
      where: { assignedStaffId: tec.id, status: 'PENDIENTE', type: { in: CAMPO }, subscriberId: { not: null } },
      select: { id: true, code: true, type: true, subscriberId: true },
      orderBy: { created: 'desc' },
      take: 5,
    });

    for (const o of ordenes) {
      const r = await fetch(`${API}/support/tickets/${o.id}`, { headers: { authorization: `Bearer ${token}` } });
      // Fuera del día que le toca, su propia orden no se le abre: no es este smoke.
      if (r.status !== 200) continue;
      leidas++;
      const d: any = await r.json();
      const ri = d?.requisitosInicio;

      const sub = await prisma.subscriber.findUnique({ where: { id: o.subscriberId! }, select: { gpsLat: true, gpsLng: true } });
      const fotos = await prisma.subscriberFile.count({ where: { subscriberId: o.subscriberId!, kind: 'VIVIENDA' } });
      const esperado = esTecnicoDeCampo
        ? { aplica: true, ubicacion: !(sub?.gpsLat && sub?.gpsLng), foto: fotos === 0 }
        : { aplica: false, ubicacion: false, foto: false };

      const bien = ri?.aplica === esperado.aplica && ri.ubicacion === esperado.ubicacion && ri.foto === esperado.foto;
      if (bien) { ok++; console.log(`  OK    #${o.code} ${o.type} (${tec.username}${esTecnicoDeCampo ? '' : ', no es de campo'}) → aplica=${ri.aplica} falta ubicacion=${ri.ubicacion} foto=${ri.foto}`); }
      else { fail++; console.log(`  FALLO #${o.code} ${o.type} (${tec.username})`, JSON.stringify(ri), 'esperado', JSON.stringify(esperado)); }
    }
  }

  console.log(`\n${ok} OK · ${fail} fallos · ${leidas} órdenes leídas`);
  await prisma.$disconnect();
  process.exit(fail || !leidas ? 1 : 0);
}
main();
