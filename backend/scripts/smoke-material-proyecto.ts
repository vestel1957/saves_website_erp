/**
 * Smoke del material de proyecto, por HTTP: ver bodegas → recorrer una → asignar
 * → verlo en la ficha → quitarlo. Lo que se comprueba de verdad es que el stock baja al asignar y
 * VUELVE al quitar; un cargo que no devuelve deja la bodega descuadrada y nadie
 * se entera hasta el inventario.
 *
 *   npx ts-node --transpile-only scripts/smoke-material-proyecto.ts
 */
export {};

const API = process.env.API_URL ?? 'http://127.0.0.1:3061/api';

async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const d: any = await r.json();
  if (!d.token) throw new Error(`Login de ${email} falló: ${d.message ?? r.status}`);
  return d.token;
}

let fallos = 0;
function comprobar(ok: boolean, texto: string) {
  console.log(`${ok ? '  ok  ' : 'FALLO '} ${texto}`);
  if (!ok) fallos++;
}

(async () => {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const tok = await login(
    process.env.QA_ADMIN_EMAIL ?? 'admin@bhdc.dev',
    process.env.QA_ADMIN_PASS ?? 'admin123',
  );
  const auth = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };

  const proyecto = await prisma.project.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true, name: true } });
  if (!proyecto) throw new Error('No hay proyectos con los que probar');
  console.log(`Proyecto: ${proyecto.name}`);

  // 1. Las bodegas: el selector entra por el estante, no por una caja de texto.
  const rBodegas = await fetch(`${API}/projects/materials/warehouses`, { headers: auth });
  comprobar(rBodegas.ok, `GET /projects/materials/warehouses -> ${rBodegas.status}`);
  const bodegas: any[] = await rBodegas.json();
  comprobar(bodegas.length > 0, `${bodegas.length} bodega(s) con material`);
  comprobar(bodegas.every((b) => b.items > 0 && b.units > 0), 'ninguna bodega vacía en la lista');
  const bodega = bodegas[0];

  // 2. El material DE ESA bodega, paginado y con las categorías del filtro.
  const rBusca = await fetch(`${API}/projects/materials/search?warehouseId=${bodega.id}&page=1&pageSize=25`, { headers: auth });
  comprobar(rBusca.ok, `GET /projects/materials/search?warehouseId= -> ${rBusca.status}`);
  const pagina: any = await rBusca.json();
  comprobar(Array.isArray(pagina.rows) && pagina.total >= pagina.rows.length, `bodega "${bodega.title}": ${pagina.total} referencias, página de ${pagina.rows.length}`);
  comprobar(pagina.rows.every((m: any) => m.warehouseId === bodega.id), 'todo lo que sale es de la bodega pedida');
  comprobar(Array.isArray(pagina.categories), `${pagina.categories?.length ?? 0} categoría(s) para los chips`);

  // Filtrar por una categoría no saca material de otra.
  if (pagina.categories?.length) {
    const cat = pagina.categories[0];
    // `page` no es opcional de adorno: sin él la respuesta sale como el ARRAY de
    // antes (compatibilidad con el móvil sin recargar, ver `respuestaMaterial`).
    const rCat = await fetch(`${API}/projects/materials/search?warehouseId=${bodega.id}&categoryId=${cat.id}&page=1`, { headers: auth });
    const porCat: any = await rCat.json();
    comprobar(porCat.rows.every((m: any) => m.categoryId === cat.id), `filtro por categoría "${cat.title}" (${porCat.total})`);
  }

  // El material de la prueba sale del buscador global (por si la 1ª bodega no tiene stock de 3).
  const rTodo = await fetch(`${API}/projects/materials/search?page=1&pageSize=100`, { headers: auth });
  const materiales: any[] = (await rTodo.json()).rows ?? [];
  const mat = materiales.find((m) => m.qty >= 3);
  if (!mat) throw new Error('Ningún material con stock suficiente para la prueba');
  const antes = mat.qty;

  // 3. Asignar 3 unidades descuenta stock.
  const rAlta = await fetch(`${API}/projects/${proyecto.id}/materials`, {
    method: 'POST', headers: auth, body: JSON.stringify({ items: [{ materialId: mat.id, qty: 3 }] }),
  });
  comprobar(rAlta.ok, `POST /projects/:id/materials -> ${rAlta.status}`);
  const tras = await prisma.material.findUnique({ where: { id: mat.id }, select: { qty: true, editedAt: true } });
  comprobar(tras!.qty === antes - 3, `stock de "${mat.name}": ${antes} -> ${tras!.qty} (esperado ${antes - 3})`);
  comprobar(tras!.editedAt != null, 'queda blindado con editedAt (el sync no lo revierte)');

  // 4. Sale en la ficha del proyecto, con su total.
  const ficha: any = await (await fetch(`${API}/projects/${proyecto.id}`, { headers: auth })).json();
  const linea = (ficha.materials ?? []).find((m: any) => m.materialId === mat.id && m.qty === 3);
  comprobar(Boolean(linea), 'el cargo aparece en la ficha del proyecto');
  comprobar(linea?.total === linea?.price * 3, `total de la línea = precio × cantidad (${linea?.total})`);
  comprobar((ficha.materialTotal ?? 0) >= (linea?.total ?? 0), `materialTotal del proyecto: ${ficha.materialTotal}`);

  // 5. Quitarlo devuelve las unidades a la bodega.
  const rBaja = await fetch(`${API}/projects/materials/${linea.id}`, { method: 'DELETE', headers: auth });
  comprobar(rBaja.ok, `DELETE /projects/materials/:mid -> ${rBaja.status}`);
  const final = await prisma.material.findUnique({ where: { id: mat.id }, select: { qty: true } });
  comprobar(final!.qty === antes, `stock devuelto: ${tras!.qty} -> ${final!.qty} (esperado ${antes})`);

  // 6. Stock insuficiente se rechaza (y no descuenta nada).
  const rTope = await fetch(`${API}/projects/${proyecto.id}/materials`, {
    method: 'POST', headers: auth, body: JSON.stringify({ items: [{ materialId: mat.id, qty: antes + 1000 }] }),
  });
  const intacto = await prisma.material.findUnique({ where: { id: mat.id }, select: { qty: true } });
  comprobar(rTope.status === 400, `pedir más de lo que hay -> ${rTope.status} (esperado 400)`);
  comprobar(intacto!.qty === antes, 'el rechazo no tocó el stock');

  await prisma.$disconnect();
  console.log(fallos ? `\n${fallos} comprobación(es) FALLARON` : '\nTodo OK');
  process.exit(fallos ? 1 : 0);
})();
