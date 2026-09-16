/**
 * Documentar una TAREA igual que se documenta una orden. Contra la API viva.
 *
 * Recorre el camino entero de la pantalla nueva `/tareas/[id]`:
 *
 *  1. crear la tarea deja ya su primer renglón de seguimiento ("Tarea creada.");
 *  2. documentar a mano guarda texto + etapa, firmado con nombre y hora;
 *  3. documentar con FOTO sube la imagen, la geo-etiqueta y la sirve de vuelta;
 *  4. cambiar estado/responsable/fecha se anota SOLO en la bitácora;
 *  5. el listado dice cuántos renglones lleva cada tarea;
 *  6. borrar la tarea se lleva por delante sus notas (cascada) y su foto queda
 *     huérfana en disco, que es lo mismo que hacen los demás módulos.
 *
 * Crea una tarea de prueba y la BORRA al final: no deja rastro en la base.
 *
 * Uso: npx ts-node --transpile-only scripts/smoke-tarea-seguimiento.ts [correo]
 */
import { PrismaClient } from '@prisma/client';
import { signToken } from '../src/auth/crypto.util';
import { APP_PERMISSIONS } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();
const API = `http://127.0.0.1:${process.env.PORT ?? 3061}/api`;
const CORREO = process.argv[2] ?? 'soporte@vestel.com.co';

let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra: unknown = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg}`, extra); }
};

/** PNG de 1x1 transparente: la foto más pequeña que el filtro de MIME acepta. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function main() {
  const user = await prisma.user.findFirst({
    where: { email: { equals: CORREO, mode: 'insensitive' } },
    select: { id: true, name: true, email: true },
  });
  if (!user) { console.log(`No existe usuario ${CORREO}`); process.exitCode = 1; return; }
  console.log(`\nDocumentando como ${user.name} <${user.email}>\n`);

  const token = signToken(user, { areas: ['administracion', 'gerencia', 'tecnicos', 'caja'], sa: true });
  const H = { Authorization: `Bearer ${token}` };
  const json = async (metodo: string, ruta: string, body?: unknown) => {
    const res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { ...H, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };

  // 1. Nace documentada.
  const creada = await json('POST', '/tasks', {
    name: 'SMOKE seguimiento de tarea (borrar)',
    description: 'Tarea de prueba del smoke; se borra al final.',
    priority: 'HIGH',
  });
  assert(creada.status < 400 && !!creada.body?.id, 'POST /tasks crea la tarea', creada.status);
  const id: string = creada.body?.id;
  if (!id) { console.log('\nSin tarea no hay nada que documentar.'); process.exitCode = 1; return; }

  let detalle = await json('GET', `/tasks/${id}`);
  const primera = detalle.body?.notes?.[0];
  assert(detalle.body?.notes?.length === 1, 'la tarea nace con un renglón de seguimiento', detalle.body?.notes);
  assert(primera?.auto === true && primera?.message === 'Tarea creada.', 'ese renglón es el del sistema', primera);
  assert(!!primera?.author, 'y va firmado con quien la creó', primera?.author);

  // 2. Documentar a mano.
  const nota = await json('POST', `/tasks/${id}/notes`, {
    message: 'Llamé al proveedor; devuelven la cotización el lunes.',
    stage: 'A la espera de un tercero',
  });
  assert(nota.status < 400, 'POST /tasks/:id/notes documenta', nota.status);
  assert(nota.body?.stage === 'A la espera de un tercero', 'guarda en qué quedó', nota.body?.stage);
  assert(nota.body?.auto === false, 'y NO se marca como automático', nota.body);

  const vacia = await json('POST', `/tasks/${id}/notes`, {});
  assert(vacia.status === 400, 'un renglón sin texto ni etapa se rechaza', vacia.status);
  const inventada = await json('POST', `/tasks/${id}/notes`, { message: 'x', stage: 'Lo que sea' });
  assert(inventada.status === 400, 'una etapa fuera de la lista se rechaza', inventada.status);

  // 3. Documentar con foto (y geo-etiquetado).
  const fd = new FormData();
  fd.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'evidencia.png');
  fd.append('message', 'Así quedó el tablero.');
  fd.append('lat', '5.3378');
  fd.append('lng', '-72.3959');
  const subida = await fetch(`${API}/tasks/${id}/notes/attach`, { method: 'POST', headers: H, body: fd });
  const subidaBody = await subida.json().catch(() => null) as any;
  assert(subida.status < 400, 'POST /tasks/:id/notes/attach sube la foto', subida.status);
  assert(subidaBody?.attach === 'evidencia.png', 'la nota conserva el nombre del fichero', subidaBody?.attach);
  assert(subidaBody?.geoLat === '5.3378' && subidaBody?.geoLng === '-72.3959', 'y las coordenadas', subidaBody);

  const foto = await fetch(`${API}/tasks/${id}/notes/${subidaBody?.id}/attachment`, { headers: H });
  const bytes = Buffer.from(await foto.arrayBuffer());
  assert(foto.status === 200, 'GET de la foto responde 200', foto.status);
  assert(bytes.equals(PNG_1X1), 'y devuelve la MISMA imagen que se subió', `${bytes.length} bytes`);

  // Una nota de otra tarea no se puede leer desde ésta.
  const ajena = await fetch(`${API}/tasks/${id}/notes/no-existe/attachment`, { headers: H });
  assert(ajena.status === 404, 'una nota que no es de esta tarea da 404', ajena.status);

  // 4. Los cambios se anotan solos.
  const cambio = await json('PATCH', `/tasks/${id}`, { status: 'DONE', priority: 'LOW' });
  assert(cambio.status < 400, 'PATCH /tasks/:id guarda', cambio.status);
  detalle = await json('GET', `/tasks/${id}`);
  const ultima = detalle.body?.notes?.at(-1);
  assert(
    ultima?.auto === true && /estado: Pendiente → Hecha/.test(ultima?.message ?? ''),
    'el cambio de estado queda en la bitácora, en castellano',
    ultima?.message,
  );
  assert(/prioridad: Alta → Baja/.test(ultima?.message ?? ''), 'y el de prioridad con él', ultima?.message);

  const sinCambio = await json('PATCH', `/tasks/${id}`, { status: 'DONE' });
  const despues = await json('GET', `/tasks/${id}`);
  assert(
    sinCambio.status < 400 && despues.body?.notes?.length === detalle.body?.notes?.length,
    'guardar sin cambiar nada NO ensucia el seguimiento',
    despues.body?.notes?.length,
  );

  // 5. El listado cuenta los renglones.
  const lista = await json('GET', `/tasks?search=SMOKE%20seguimiento&pageSize=5`);
  const fila = (lista.body?.items ?? []).find((r: any) => r.id === id);
  assert(fila?.notes === despues.body?.notes?.length, 'la lista trae el nº de entradas de seguimiento', fila?.notes);

  // 6. Limpieza: la tarea se lleva sus notas.
  const borrada = await json('DELETE', `/tasks/${id}`);
  assert(borrada.status < 400, 'DELETE /tasks/:id borra la tarea de prueba', borrada.status);
  const quedan = await prisma.todoTaskNote.count({ where: { taskId: id } });
  assert(quedan === 0, 'y sus renglones de seguimiento se van en cascada', quedan);

  console.log(`\n${ok} OK · ${fail} fallos\n`);
  if (fail) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
