/**
 * Comprobación en vivo de dos cosas que se pidieron a la vez:
 *  1. el sistema no muestra nombres de usuario, solo el nombre completo;
 *  2. los funcionarios inhabilitados no salen por ninguna parte.
 *
 * Solo lee: no crea ni cambia nada. Se corre con
 *   QA_ADMIN_EMAIL=... QA_ADMIN_PASS=... npx ts-node scripts/smoke-solo-activos.ts
 */
// Sin un import/export el archivo es un script global y su `const API` choca con el de
// prisma/seed-inventory-modules.ts (mismo ámbito), lo que rompe el build entero.
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

const get = async (tok: string, path: string) => {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`${path} respondió ${r.status}`);
  return r.json() as any;
};

let fallos = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) fallos++;
};

(async () => {
  const tok = await login(
    process.env.QA_ADMIN_EMAIL ?? 'admin@bhdc.dev',
    process.env.QA_ADMIN_PASS ?? 'admin123',
  );

  console.log('\n── Empleados ─────────────────────────────────────────');
  const lista = await get(tok, '/staff?pageSize=100');
  check(lista.items.length > 0, `la lista trae ${lista.total} empleados`);
  check(lista.items.every((e: any) => !e.banned), 'ninguno viene inhabilitado');
  check(lista.items.every((e: any) => e.username === undefined), 'las filas ya no traen nombre de usuario');
  const stats = await get(tok, '/staff/stats');
  check(stats.total === lista.total, `el resumen (${stats.total}) cuadra con la lista (${lista.total})`);
  check(stats.inhabilitados === undefined, 'el resumen ya no habla de inhabilitados');

  const soloInhabilitados = await get(tok, '/staff?pageSize=100&inhabilitados=1');
  check(
    soloInhabilitados.items.every((e: any) => e.banned),
    `la puerta del superusuario muestra los ${soloInhabilitados.total} inhabilitados, y solo esos`,
  );

  console.log('\n── Órdenes de servicio ───────────────────────────────');
  const tickets = await get(tok, '/support/tickets?pageSize=50&all=1');
  const conTecnico = tickets.items.filter((t: any) => t.assigned);
  check(conTecnico.length > 0, `${conTecnico.length} de ${tickets.items.length} órdenes traen técnico`);
  // Un username del legacy no lleva espacios ('NaimeSistemas'); un nombre sí.
  const sinTraducir = conTecnico.filter((t: any) => !String(t.assigned).includes(' '));
  check(sinTraducir.length === 0, `todos los técnicos salen con nombre completo${sinTraducir.length ? ` (crudos: ${[...new Set(sinTraducir.map((t: any) => t.assigned))].join(', ')})` : ''}`);

  const stSoporte = await get(tok, '/support/stats');
  const crudos = (stSoporte.topTechs ?? []).filter((t: any) => !String(t.tec).includes(' '));
  check(stSoporte.topTechs.length > 0, `el filtro de técnico ofrece ${stSoporte.topTechs.length} opciones`);
  // Estos NO son un fallo: son usernames de gente cuya ficha ya no existe en la
  // base, así que no hay nombre al que traducirlos. Se dejan tal cual porque
  // alguien hizo esas órdenes y borrarle el técnico a 6.000 órdenes es peor.
  if (crudos.length) {
    const total = crudos.reduce((s: number, t: any) => s + t.count, 0);
    console.log(`  · sin ficha que traducir (se muestran crudos): ${crudos.map((t: any) => t.tec).join(', ')} — ${total} órdenes`);
  }

  const tec = stSoporte.topTechs?.[0]?.tec;
  if (tec) {
    const filtrado = await get(tok, `/support/tickets?pageSize=5&all=1&tec=${encodeURIComponent(tec)}`);
    check(filtrado.total > 0, `filtrar por "${tec}" encuentra sus ${filtrado.total} órdenes (incluidas las viejas)`);
  }

  console.log('\n── Selectores ────────────────────────────────────────');
  const tecnicos = await get(tok, '/support/technicians');
  check(tecnicos.length > 0 && tecnicos.every((t: any) => t.username === undefined), `los ${tecnicos.length} técnicos asignables van sin nombre de usuario`);

  console.log(fallos ? `\n${fallos} comprobación(es) fallaron.` : '\nTodo en orden.');
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
