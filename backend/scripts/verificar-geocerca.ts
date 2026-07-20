/**
 * Verificación de extremo a extremo de la geo-cerca de cierres.
 *
 *   npx ts-node scripts/verificar-geocerca.ts
 *
 * Pega contra la API de verdad (HTTP + guards + validación + base de datos), que
 * es la única forma de comprobar que la regla se aplica donde importa: en el
 * servidor. Los tests unitarios de `geofence.policy.ts` ya cubren la lógica; lo
 * que aquí se prueba es que esté bien enchufada.
 *
 * SEGURIDAD — esto se escribió después de que una prueba manual disparara una
 * reconexión real en un Mikrotik de producción. Tres candados:
 *
 *   1. Se crea un abonado propio, marcado, SIN PPPoE y SIN sede. Aunque algo
 *      cascadeara, no tiene router contra el que actuar.
 *   2. Solo se usan tipos de orden que NO disparan cascada. La lista de tipos
 *      peligrosos se comprueba al arrancar: si alguien la cambia, esto falla
 *      antes de tocar nada.
 *   3. Todo se borra en el `finally`, incluido el modo de la cerca, aunque un
 *      caso reviente a mitad.
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/crypto.util';

const API = process.env.API_URL ?? 'http://127.0.0.1:3061/api';
const prisma = new PrismaClient();

/** Palabras que disparan la cascada de cierre (ver applyCloseCascade). */
const CASCADA = ['retiro', 'suspens', 'corte', 'instalac', 'reconex', 'activ', 'megas', 'plan', 'perfil', 'traslado'];

/** Domicilio de la prueba y dos puntos alrededor. */
const CASA = { lat: 5.3407689, lng: -72.369472 };
const EN_LA_PUERTA = { lat: 5.3413, lng: -72.369472 }; // ~60 m
const OFICINA = { lat: 5.3378, lng: -72.3959 }; // ~2,9 km

const TIPO_CAMPO = 'Revision de Internet';
const TIPO_REMOTO = 'Cambio de clave';
const MARCA = 'ZZZ-PRUEBA-GEOCERCA';

let fallos = 0;
let pasados = 0;

function comprobar(nombre: string, ok: boolean, detalle = '') {
  if (ok) {
    pasados++;
    console.log(`  ✓ ${nombre}`);
  } else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const d = (await r.json()) as { token?: string; message?: string };
  if (!d.token) throw new Error(`Login de ${email} falló: ${d.message ?? r.status}`);
  return d.token;
}

/** Intenta cerrar una orden y devuelve el estado HTTP + cuerpo. */
async function cerrar(
  token: string,
  ticketId: string,
  cuerpo: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${API}/support/tickets/${ticketId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: 'RESUELTO', ...cuerpo }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

async function setModo(valor: 'off' | 'observar' | 'exigir') {
  await prisma.appSetting.upsert({
    where: { key: 'tickets.geofence.mode' },
    create: { key: 'tickets.geofence.mode', value: valor, group: 'tickets' },
    update: { value: valor },
  });
}

async function main() {
  // --- Candado 2: los tipos elegidos no pueden cascadear ---
  for (const t of [TIPO_CAMPO, TIPO_REMOTO]) {
    const peligroso = CASCADA.find((k) => t.toLowerCase().includes(k));
    if (peligroso) {
      throw new Error(
        `El tipo "${t}" dispara la cascada de cierre (palabra "${peligroso}"). ` +
          `Elige otro: esta prueba NO puede tocar Mikrotik.`,
      );
    }
  }
  if (process.env.TICKET_GEOFENCE_MODE) {
    throw new Error(
      'TICKET_GEOFENCE_MODE está puesto en el entorno y gana sobre el ajuste de BD: ' +
        'quítalo del .env para poder probar los tres modos.',
    );
  }

  const modoOriginal = (await prisma.appSetting.findUnique({ where: { key: 'tickets.geofence.mode' } }))?.value ?? null;
  const creados = { subIds: [] as string[], ticketIds: [] as string[], userId: null as string | null };

  try {
    console.log('\n── Montando el escenario ─────────────────────────────');

    // Abonado de prueba CON coordenada, sin PPPoE ni sede (candado 1).
    const maxAb = await prisma.subscriber.aggregate({ _max: { abonado: true } });
    const base = (maxAb._max.abonado ?? 0) + 9000;
    const conGps = await prisma.subscriber.create({
      data: {
        abonado: base, fullName: `${MARCA} CON GPS`,
        gpsLat: String(CASA.lat), gpsLng: String(CASA.lng),
      },
    });
    const sinGps = await prisma.subscriber.create({
      data: { abonado: base + 1, fullName: `${MARCA} SIN GPS` },
    });
    creados.subIds.push(conGps.id, sinGps.id);
    console.log(`  abonados de prueba: #${conGps.abonado} (con GPS) y #${sinGps.abonado} (sin GPS)`);

    // Técnico de prueba: sin él no se puede comprobar nada, porque el
    // superusuario está exento por diseño.
    const permTecnicos = await prisma.permission.findFirst({ where: { key: 'area.tecnicos' } });
    if (!permTecnicos) throw new Error('No existe el permiso area.tecnicos');
    const tec = await prisma.user.upsert({
      where: { email: 'qa-geocerca@vestel.test' },
      create: { email: 'qa-geocerca@vestel.test', name: `${MARCA} Tecnico`, passwordHash: hashPassword('qa-geocerca') },
      update: { passwordHash: hashPassword('qa-geocerca') },
    });
    creados.userId = tec.id;
    await prisma.userPermission.upsert({
      where: { userId_permissionId: { userId: tec.id, permissionId: permTecnicos.id } },
      create: { userId: tec.id, permissionId: permTecnicos.id, effect: 'ALLOW' },
      update: { effect: 'ALLOW' },
    });

    const tokTec = await login('qa-geocerca@vestel.test', 'qa-geocerca');
    const tokAdmin = await login(
      process.env.QA_ADMIN_EMAIL ?? 'admin@bhdc.dev',
      process.env.QA_ADMIN_PASS ?? 'admin123',
    );
    console.log('  técnico de prueba y administrador autenticados');

    /** Crea una orden lista para cerrar (con firma, para no chocar con esa regla). */
    let seq = 0;
    const nuevaOrden = async (tipo: string, subscriberId: string) => {
      const t = await prisma.ticket.create({
        data: {
          subject: MARCA, type: tipo, created: new Date(), subscriberId,
          status: 'REALIZANDO', signatureName: 'QA', code: 900000 + seq++,
        },
      });
      creados.ticketIds.push(t.id);
      return t.id;
    };

    // ── Modo EXIGIR ────────────────────────────────────────────────────
    await setModo('exigir');
    console.log('\n── Modo EXIGIR: la cerca debe bloquear ───────────────');

    let id = await nuevaOrden(TIPO_CAMPO, conGps.id);
    let r = await cerrar(tokTec, id, {});
    comprobar(
      'sin mandar ubicación → 422 y la pide',
      r.status === 422 && r.body.razon === 'sin-ubicacion',
      `recibido ${r.status} ${JSON.stringify(r.body.razon ?? r.body.message)}`,
    );

    r = await cerrar(tokTec, id, { lat: OFICINA.lat, lng: OFICINA.lng, accuracyM: 10 });
    comprobar(
      'desde la oficina (2,9 km) → 422 con la distancia',
      r.status === 422 && r.body.code === 'GEOFENCE' && Math.round(Number(r.body.distanciaM)) > 2500,
      `recibido ${r.status} dist=${r.body.distanciaM}`,
    );

    r = await cerrar(tokTec, id, { lat: OFICINA.lat, lng: OFICINA.lng, accuracyM: 999999 });
    comprobar(
      'precisión inflada (±999999) NO abre la cerca',
      r.status === 422,
      `recibido ${r.status}`,
    );

    r = await cerrar(tokTec, id, { lat: OFICINA.lat, lng: OFICINA.lng, accuracyM: 10, justificacion: 'ya' });
    comprobar('justificación de 2 letras no vale', r.status === 422, `recibido ${r.status}`);

    r = await cerrar(tokTec, id, {
      lat: OFICINA.lat, lng: OFICINA.lng, accuracyM: 10,
      justificacion: 'El cliente confirmo por telefono que ya quedo el servicio.',
    });
    let t = await prisma.ticket.findUnique({ where: { id } });
    comprobar(
      'con justificación válida cierra y queda MARCADA',
      r.status < 300 && t?.status === 'RESUELTO' && t.closeGeoOk === false && !!t.closeGeoReason,
      `status=${r.status} geoOk=${t?.closeGeoOk} motivo=${t?.closeGeoReason ? 'sí' : 'no'}`,
    );

    id = await nuevaOrden(TIPO_CAMPO, conGps.id);
    r = await cerrar(tokTec, id, { lat: EN_LA_PUERTA.lat, lng: EN_LA_PUERTA.lng, accuracyM: 8 });
    t = await prisma.ticket.findUnique({ where: { id } });
    comprobar(
      'en la puerta (60 m) cierra limpio',
      r.status < 300 && t?.closeGeoOk === true,
      `status=${r.status} geoOk=${t?.closeGeoOk}`,
    );

    console.log('\n── Modo EXIGIR: cuándo NO debe estorbar ──────────────');

    id = await nuevaOrden(TIPO_REMOTO, conGps.id);
    r = await cerrar(tokTec, id, { lat: OFICINA.lat, lng: OFICINA.lng, accuracyM: 10 });
    t = await prisma.ticket.findUnique({ where: { id } });
    comprobar(
      `orden remota ("${TIPO_REMOTO}") se cierra desde la oficina`,
      r.status < 300 && t?.closeGeoOk === null,
      `status=${r.status} geoOk=${t?.closeGeoOk}`,
    );

    id = await nuevaOrden(TIPO_CAMPO, conGps.id);
    r = await cerrar(tokAdmin, id, { lat: OFICINA.lat, lng: OFICINA.lng, accuracyM: 10 });
    comprobar('el superusuario está exento', r.status < 300, `status=${r.status}`);

    id = await nuevaOrden(TIPO_CAMPO, sinGps.id);
    r = await cerrar(tokTec, id, { lat: EN_LA_PUERTA.lat, lng: EN_LA_PUERTA.lng, accuracyM: 9 });
    const sub = await prisma.subscriber.findUnique({ where: { id: sinGps.id } });
    comprobar(
      'cliente SIN coordenada: cierra Y se le guarda la del técnico',
      r.status < 300 && sub?.gpsLat === EN_LA_PUERTA.lat.toFixed(6),
      `status=${r.status} gps=${sub?.gpsLat}`,
    );

    id = await nuevaOrden(TIPO_CAMPO, conGps.id);
    r = await cerrar(tokTec, id, { status: 'ANULADA' });
    t = await prisma.ticket.findUnique({ where: { id } });
    comprobar(
      'ANULADA no pasa por la cerca (anular es decir que no se hizo)',
      r.status < 300 && t?.status === 'ANULADA',
      `status=${r.status} estado=${t?.status}`,
    );

    // ── Modo OBSERVAR ──────────────────────────────────────────────────
    await setModo('observar');
    console.log('\n── Modo OBSERVAR: registra pero no frena ─────────────');

    id = await nuevaOrden(TIPO_CAMPO, conGps.id);
    r = await cerrar(tokTec, id, { lat: OFICINA.lat, lng: OFICINA.lng, accuracyM: 10 });
    t = await prisma.ticket.findUnique({ where: { id } });
    comprobar(
      'desde la oficina cierra, pero queda marcada con la distancia',
      r.status < 300 && t?.closeGeoOk === false && Math.round(Number(t?.closeDistanceM)) > 2500,
      `status=${r.status} geoOk=${t?.closeGeoOk} dist=${t?.closeDistanceM}`,
    );

    const informe = await fetch(`${API}/support/geofence-report?dias=1`, {
      headers: { Authorization: `Bearer ${tokAdmin}` },
    }).then((x) => x.json() as Promise<{ resumen: { fuera: number }; casos: unknown[] }>);
    comprobar(
      'el informe recoge los cierres fuera de rango',
      informe.resumen.fuera >= 2,
      `fuera=${informe.resumen.fuera}`,
    );

    // ── Modo OFF ───────────────────────────────────────────────────────
    await setModo('off');
    console.log('\n── Modo OFF: la cerca no existe ──────────────────────');
    id = await nuevaOrden(TIPO_CAMPO, conGps.id);
    r = await cerrar(tokTec, id, {});
    comprobar('cierra sin ubicación y sin marcar', r.status < 300, `status=${r.status}`);
  } finally {
    console.log('\n── Limpiando ────────────────────────────────────────');
    await prisma.ticketThread.deleteMany({ where: { ticketCode: { gte: 900000, lt: 900100 } } });
    await prisma.geoPing.deleteMany({ where: { refId: { in: creados.ticketIds } } });
    await prisma.ticket.deleteMany({ where: { id: { in: creados.ticketIds } } });
    await prisma.subscriber.deleteMany({ where: { id: { in: creados.subIds } } });
    if (creados.userId) {
      await prisma.geoPing.deleteMany({ where: { userId: creados.userId } });
      await prisma.userPermission.deleteMany({ where: { userId: creados.userId } });
      await prisma.user.delete({ where: { id: creados.userId } }).catch(() => undefined);
    }
    // El modo vuelve a como estaba, pase lo que pase.
    if (modoOriginal) await setModo(modoOriginal as 'off' | 'observar' | 'exigir');
    else await prisma.appSetting.deleteMany({ where: { key: 'tickets.geofence.mode' } });
    console.log(`  escenario borrado · modo restaurado a "${modoOriginal ?? '(sin ajuste)'}"`);
    await prisma.$disconnect();
  }

  console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${pasados} correctos, ${fallos} fallidos\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n❌ La verificación se cayó:', (e as Error).message);
  await prisma.$disconnect();
  process.exit(1);
});
