/**
 * Agenda del día para el TÉCNICO DE PRUEBA: clientes de demostración y sus visitas.
 *
 *   npx ts-node prisma/seed-ordenes-tecnico-prueba.ts [YYYY-MM-DD]
 *
 * Complementa a `seed-tecnico-prueba.ts`, que deja la cuenta y la ficha pero con las
 * pantallas vacías. Aquí se le pone trabajo encima para poder recorrer de verdad su
 * agenda del día (verla entera, abrir la que elija, cerrarla o marcarla "no se pudo
 * atender").
 *
 * DOS DECISIONES QUE IMPORTAN, Y POR QUÉ:
 *
 * 1. **No se le reasigna trabajo real.** Colgarle al técnico de prueba órdenes de
 *    Miguel o de Omar se las QUITA a ellos —agendar asigna, ver `agenda.service.ts`—
 *    y encima ensucia su tablero de rendimiento. Se crean órdenes nuevas.
 *
 * 2. **Los clientes de demostración nacen SIN `legacyId`, y eso es lo que impide que
 *    esto salga del sistema nuevo.** El writeback empuja al MySQL del legacy las
 *    órdenes nacidas aquí (`LEGACY_WRITEBACK_TICKETS_LIVE=true`), pero sólo las que
 *    tienen abonado con `legacyId`: allá `tickets.cid` es NOT NULL. Y los clientes
 *    nuevos no viajan porque esa parte del writeback sigue en seco
 *    (`LEGACY_WRITEBACK_LIVE=false`). Resultado: cliente sin legacyId ⇒ su orden se
 *    queda aquí. Si algún día se abre el gate de clientes, ESTO YA NO ES CIERTO y
 *    estas órdenes empezarían a aparecerle al personal en el legacy.
 *
 * Las órdenes se crean por la API (no a pelo en la base) para que pasen por las
 * mismas reglas que una orden de verdad: consecutivo propio de nexus (desde 500.000),
 * clase del catálogo, asignación con su sello de hora y agendado por `AgendaService`,
 * que es quien renumera la cola. Se entra como `prueba.administracion`, que es quien
 * repartiría el trabajo en la vida real.
 *
 * Idempotente: los clientes se reconocen por su documento `PRUEBA-0x` y las órdenes
 * ya agendadas para ese día no se duplican.
 *
 * Para deshacerlo:
 *   DELETE FROM "Ticket" WHERE "assigned" = 'PRUEBA · Técnico de campo';
 *   DELETE FROM "Subscriber" WHERE "docNumber" LIKE 'PRUEBA-%';
 */
import { PrismaClient, SubscriberStatus } from '@prisma/client';
import { nextTid, TID_SEQ } from '../src/common/tid';

const prisma = new PrismaClient();

const API = `http://127.0.0.1:${process.env.PORT || 3061}/api`;
/** Quien reparte el trabajo. Mismo usuario y clave del seed de perfiles de prueba. */
const CAJERA = { email: 'prueba.administracion@vestel.com.co', password: 'Prueba2026*' };
/** Tal cual está en `Staff.name`: es lo que viaja en `Ticket.assigned`. */
const TECNICO = 'PRUEBA · Técnico de campo';
/** Sede Yopal (`Branch.legacyId` = 2). */
const SEDE = 2;

/** Clientes de demostración. El documento `PRUEBA-0x` es la llave para no duplicarlos. */
const CLIENTES = [
  {
    doc: 'PRUEBA-01', firstName: 'DEMO', lastName1: 'INSTALACIÓN', status: SubscriberStatus.INSTALAR,
    address: 'Cra 20 # 12-34, Barrio El Centro', lat: '5.33780', lng: '-72.39590', phone: '3000000001',
  },
  {
    doc: 'PRUEBA-02', firstName: 'DEMO', lastName1: 'FALLA INTERNET', status: SubscriberStatus.ACTIVO,
    address: 'Calle 8 # 23-15, Barrio La Campiña', lat: '5.34410', lng: '-72.40120', phone: '3000000002',
  },
  {
    doc: 'PRUEBA-03', firstName: 'DEMO', lastName1: 'CAMBIO DE EQUIPO', status: SubscriberStatus.ACTIVO,
    address: 'Cra 27 # 40-08, Barrio Bella Vista', lat: '5.33010', lng: '-72.38870', phone: '3000000003',
  },
  {
    doc: 'PRUEBA-04', firstName: 'DEMO', lastName1: 'TRASLADO', status: SubscriberStatus.ACTIVO,
    address: 'Calle 30 # 14-52, Barrio El Triunfo', lat: '5.34990', lng: '-72.39210', phone: '3000000004',
  },
];

/** Las visitas del día, EN EL ORDEN en que se le van a pintar (1..5). */
const VISITAS = [
  { doc: 'PRUEBA-01', subject: 'servicio', type: 'Instalacion', priority: 'Alta',
    problem: 'Instalación nueva: fibra hasta el apartamento, dejar router y probar velocidad.' },
  { doc: 'PRUEBA-02', subject: 'reclamo', type: 'Revision de Internet', priority: 'Alta',
    problem: 'El cliente reporta internet intermitente desde ayer; se cae cada media hora.' },
  { doc: 'PRUEBA-03', subject: 'servicio', type: 'Cambio de equipo', priority: 'Media',
    problem: 'ONT con puerto LAN dañado. Llevar equipo de repuesto y descontarlo de la bodega.' },
  { doc: 'PRUEBA-02', subject: 'servicio', type: 'Subir megas', priority: 'Media',
    problem: 'Pasa de 300 a 600 megas. Aplicar velocidad en la OLT y verificar con el cliente.' },
  { doc: 'PRUEBA-04', subject: 'servicio', type: 'Traslado', priority: 'Baja',
    problem: 'Traslado a la misma cuadra (Calle 30 # 14-52). Verificar NAP disponible.' },
];

/** `fetch` que revienta con el mensaje del servidor y no con un `undefined` a secas. */
async function api<T>(ruta: string, opciones: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...init } = opciones;
  const res = await fetch(`${API}${ruta}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const cuerpo = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${ruta} → ${res.status} ${JSON.stringify(cuerpo)}`);
  return cuerpo as T;
}

/** Hoy en Colombia (UTC-5) como 'YYYY-MM-DD'. */
function hoyBogota(): string {
  const ahora = new Date(Date.now() - 5 * 60 * 60 * 1000);
  return ahora.toISOString().slice(0, 10);
}

async function main() {
  const fecha = process.argv[2]?.trim() || hoyBogota();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('La fecha debe venir como YYYY-MM-DD.');

  const staff = await prisma.staff.findFirst({ where: { name: TECNICO, banned: false } });
  if (!staff) throw new Error(`No existe la ficha "${TECNICO}". Corre antes prisma/seed-tecnico-prueba.ts.`);
  const branch = await prisma.branch.findFirst({ where: { legacyId: SEDE } });

  // 1. Clientes de demostración.
  const porDoc = new Map<string, string>();
  for (const c of CLIENTES) {
    const previo = await prisma.subscriber.findFirst({ where: { docNumber: c.doc } });
    const datos = {
      firstName: c.firstName, lastName1: c.lastName1,
      fullName: `PRUEBA · ${c.firstName} ${c.lastName1}`,
      docType: 'CC', docNumber: c.doc, phone1: c.phone,
      addressLine: c.address, gpsLat: c.lat, gpsLng: c.lng,
      branchId: branch?.id ?? null, status: c.status,
    };
    const sub = previo
      ? await prisma.subscriber.update({ where: { id: previo.id }, data: datos })
      : await prisma.subscriber.create({
          data: { ...datos, abonado: await nextTid(prisma, TID_SEQ.subscriberAbonado) },
        });
    porDoc.set(c.doc, sub.id);
    console.log(`   ${previo ? '·' : '+'} Cliente ${sub.abonado} · ${sub.fullName} · ${c.status}`);
  }

  // 2. Sesión de quien reparte el trabajo.
  const { token } = await api<{ token: string }>('/auth/login', {
    method: 'POST', body: JSON.stringify(CAJERA),
  });

  // 3. Las visitas, en orden. `scheduledFor` + `assigned` hace las dos cosas de una
  //    vez: se la asigna y la mete al final de su columna de ese día.
  const yaAgendadas = await prisma.ticket.count({
    where: { assignedStaffId: staff.id, scheduledFor: new Date(`${fecha}T00:00:00.000Z`) },
  });
  if (yaAgendadas) {
    console.log(`\n⏭  Ya tiene ${yaAgendadas} visita(s) agendadas para el ${fecha}: no se crean más.`);
  } else {
    console.log('');
    for (const v of VISITAS) {
      const creada = await api<{ id: string; code: number }>('/support/tickets', {
        method: 'POST', token,
        body: JSON.stringify({
          subscriberId: porDoc.get(v.doc), subject: v.subject, type: v.type,
          priority: v.priority, problem: v.problem, assigned: TECNICO, scheduledFor: fecha,
        }),
      });
      console.log(`   + Orden #${creada.code} · ${v.type} (${v.priority})`);
    }
  }

  // 4. Comprobación con los ojos del técnico: su agenda tiene que salir numerada.
  const sesionTecnico = await api<{ token: string }>('/auth/login', {
    method: 'POST', body: JSON.stringify({ email: 'prueba.tecnicos@vestel.com.co', password: 'Prueba2026*' }),
  });
  const agenda = await api<any>(`/support/mi-agenda?fecha=${fecha}`, { token: sesionTecnico.token });
  const ordenes: any[] = agenda?.ordenes ?? [];
  console.log(`\n✅ Agenda del ${fecha} para ${TECNICO}: ${ordenes.length} visita(s).`);
  for (const o of ordenes) {
    console.log(`   ${o.puesto}. #${o.code} ${o.type} · ${o.cliente} · ${o.direccion}`);
  }
}

main()
  .catch((e) => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
