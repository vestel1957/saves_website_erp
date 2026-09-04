/**
 * Comprueba en vivo la regla del paz y salvo: el certificado sólo se expide si el
 * cliente está al día EN DINERO y ya devolvió el equipo.
 *
 * Busca en la base tres clientes reales —uno con deuda, uno al día pero con equipo a
 * su nombre, y uno limpio— y pide el PDF de cada uno por la API. Espera 400 en los dos
 * primeros (con el motivo escrito) y un PDF de verdad en el tercero.
 *
 * Solo lee: no crea ni cambia nada. Se corre con
 *   QA_ADMIN_EMAIL=... QA_ADMIN_PASS=... npx ts-node scripts/smoke-paz-y-salvo.ts
 */
export {};

const API = process.env.API_URL ?? 'http://127.0.0.1:3061/api';

async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const d: any = await r.json();
  if (!d.token) throw new Error(`Login de ${email} falló: ${d.message ?? r.status}`);
  return d.token;
}

let fallos = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) fallos++;
};

(async () => {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const tok = await login(
    process.env.QA_ADMIN_EMAIL ?? 'admin@bhdc.dev',
    process.env.QA_ADMIN_PASS ?? 'admin123',
  );

  const estado = async (id: string) => {
    const r = await fetch(`${API}/subscribers/${id}/statement`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) throw new Error(`statement respondió ${r.status}`);
    return r.json() as any;
  };
  const pdf = async (id: string) => {
    const r = await fetch(`${API}/subscribers/${id}/paz-y-salvo.pdf`, { headers: { Authorization: `Bearer ${tok}` } });
    const cuerpo = r.headers.get('content-type')?.includes('application/pdf')
      ? `${(await r.arrayBuffer()).byteLength} bytes de PDF`
      : ((await r.json().catch(() => ({}))) as any).message ?? '';
    return { status: r.status, cuerpo };
  };

  // Un cliente al que le queda equipo a su nombre (el caso que motivó la regla).
  const conEquipo = await prisma.equipment.findFirst({
    where: { subscriberId: { not: null } },
    select: { subscriberId: true, code: true },
  });
  // Uno cualquiera para tantear los otros dos casos: se recorren unos pocos hasta
  // encontrar uno con deuda y uno limpio. No se fabrica nada para no ensuciar datos.
  const candidatos = await prisma.subscriber.findMany({ select: { id: true }, take: 60 });

  let conDeuda: string | null = null, limpio: string | null = null;
  for (const c of candidatos) {
    const st = await estado(c.id);
    if (!conDeuda && !st.alDia) conDeuda = c.id;
    if (!limpio && st.puedeEmitirPazYSalvo) limpio = c.id;
    if (conDeuda && limpio) break;
  }

  console.log('\n── Con saldo pendiente ───────────────────────────────');
  if (conDeuda) {
    const st = await estado(conDeuda);
    const r = await pdf(conDeuda);
    check(st.puedeEmitirPazYSalvo === false, 'el estado de cuenta dice que NO se puede expedir');
    check(r.status === 400, `la ruta lo niega (${r.status})`);
    check(/saldo pendiente/i.test(r.cuerpo), `y dice por qué: "${r.cuerpo}"`);
  } else {
    console.log('  · sin caso a mano entre los primeros 60 clientes (no es un fallo)');
  }

  console.log('\n── Con equipo sin devolver ───────────────────────────');
  if (conEquipo?.subscriberId) {
    const st = await estado(conEquipo.subscriberId);
    const r = await pdf(conEquipo.subscriberId);
    check(st.equiposPendientes?.length > 0, `el estado de cuenta lista el equipo (código ${conEquipo.code})`);
    check(st.puedeEmitirPazYSalvo === false, 'no se puede expedir aunque el saldo estuviera en cero');
    check(r.status === 400, `la ruta lo niega (${r.status})`);
    check(/devuelto/i.test(r.cuerpo), `y dice por qué: "${r.cuerpo}"`);
  } else {
    console.log('  · ningún equipo asignado en la base (no es un fallo)');
  }

  console.log('\n── Al día y sin equipo ───────────────────────────────');
  if (limpio) {
    const r = await pdf(limpio);
    check(r.status === 200, `el certificado sí sale (${r.status})`);
    check(/bytes de PDF/.test(r.cuerpo), `y es un PDF: ${r.cuerpo}`);
  } else {
    console.log('  · sin caso a mano entre los primeros 60 clientes (no es un fallo)');
  }

  await prisma.$disconnect();
  console.log(`\n${fallos ? `✗ ${fallos} comprobación(es) fallaron` : '✓ todo en orden'}`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
