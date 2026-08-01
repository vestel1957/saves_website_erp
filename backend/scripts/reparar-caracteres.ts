/**
 * Devuelve la Ñ (y las tildes) a los textos donde el legacy dejó un '?'.
 *
 * QUÉ PASÓ. En la base del legacy los nombres están guardados con un signo de
 * interrogación en el lugar del carácter especial: `HEX('PATI?O')` = 504154493F4F,
 * o sea un '?' de verdad (0x3F), no un problema de cómo se lee. Se perdió hace
 * años, al escribirlos por una conexión que no hablaba el juego de caracteres de
 * la tabla. Nuestra copia lo heredó tal cual: 13.207 filas en 21 columnas.
 *
 * CÓMO SE REPARA. No se puede adivinar a ciegas: el '?' tapa tanto una Ñ
 * ('MU?OZ') como una vocal con tilde ('Uni?n', 'cr?dito'). Así que se prueban los
 * doce caracteres posibles y se acepta el que forme una palabra QUE YA EXISTE
 * BIEN ESCRITA en la propia base (hay 93 clientes con Ñ de verdad, barrios con
 * tilde, notas correctas…). Lo que no case contra ese diccionario no se toca y
 * se lista al final: es preferible dejar un '?' que inventarle el apellido a
 * alguien.
 *
 * DÓNDE HAY QUE ESCRIBIR. Los nombres de clientes se comparan campo a campo
 * contra el legacy en cada pasada del sync (`sync-legacy-vivo.js` ▸
 * syncCustomers), así que arreglarlos solo en Postgres dura 15 minutos: hay que
 * arreglar el legacy, que es la fuente. El resto de tablas (notas de caja,
 * órdenes, barrios…) llega por sincronización incremental y no se vuelve a pisar,
 * así que con repararlas aquí basta. De paso, arreglar los nombres allá corta el
 * problema de raíz: las notas de caja ('Pago de la factura #124826 BLANCA
 * IBA?EZ') las escribe el legacy copiando el nombre del cliente.
 *
 * USO
 *   npx ts-node scripts/reparar-caracteres.ts                 → en seco, todo
 *   npx ts-node scripts/reparar-caracteres.ts --commit        → repara Postgres
 *   npx ts-node scripts/reparar-caracteres.ts --legacy        → en seco, el legacy
 *   npx ts-node scripts/reparar-caracteres.ts --legacy --commit  → repara el legacy
 *   ... --limite 20   cuántos ejemplos imprimir por columna
 */
export {};

import { PrismaClient } from '@prisma/client';
import { createConnection } from 'mysql2/promise';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

try {
  for (const linea of readFileSync(join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
} catch {}

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const LEGACY = process.argv.includes('--legacy');
const LIMITE = Number(process.argv[process.argv.indexOf('--limite') + 1]) || 8;

/**
 * Columnas de Postgres a reparar.
 *
 * Fuera quedan a propósito `Subscriber.email` y `Subscriber.pppUsername`: un
 * correo y un usuario de router son identificadores técnicos, y "corregirle" la
 * ñ a `pequenito77@hotmail.com` sería dejar al cliente sin correo de contacto.
 */
const COLUMNAS: [tabla: string, columna: string][] = [
  ['Subscriber', 'firstName'], ['Subscriber', 'secondName'],
  ['Subscriber', 'lastName1'], ['Subscriber', 'lastName2'],
  ['Subscriber', 'companyName'], ['Subscriber', 'fullName'],
  ['Subscriber', 'addressLine'], ['Subscriber', 'netComment'],
  ['Neighborhood', 'name'],
  ['Transaction', 'note'], ['Transaction', 'payerName'],
  ['SubInvoice', 'notes'],
  ['Ticket', 'signatureName'], ['Ticket', 'section'], ['Ticket', 'problem'],
  ['TicketThread', 'message'],
  ['TodoTask', 'name'], ['TodoTask', 'description'],
  ['CalendarEvent', 'title'], ['CalendarEvent', 'description'],
  ['Voiding', 'reason'],
];

/** Columnas del legacy (tabla `customers`) que llevan texto de persona. */
const COLUMNAS_LEGACY = ['name', 'dosnombre', 'unoapellido', 'dosapellido', 'company'];

const ESPECIALES = ['Ñ', 'Á', 'É', 'Í', 'Ó', 'Ú', 'Ü'];
/** Una palabra está dañada si el '?' tiene letras a los dos lados: 'MU?OZ'. */
const DANADA = /\p{L}\?\p{L}/u;
const PALABRAS = /[\p{L}?]+/gu;

const sinTildes = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ñ/gi, (c) => (c === 'ñ' ? 'n' : 'N'));

/** Diccionario: palabra bien escrita (en minúsculas) → veces que aparece. */
const bueno = new Map<string, number>();

function aprender(texto: string | null | undefined) {
  if (!texto) return;
  for (const palabra of texto.match(PALABRAS) ?? []) {
    if (palabra.includes('?')) continue;
    if (!/[ÑñÁÉÍÓÚÜáéíóúü]/.test(palabra)) continue;
    const k = palabra.toLowerCase();
    bueno.set(k, (bueno.get(k) ?? 0) + 1);
  }
}

/**
 * Repara una palabra probando los caracteres posibles en cada '?' y quedándose
 * con la que exista en el diccionario. La mayúscula/minúscula del carácter se
 * copia de la letra de al lado, que es lo que hace que salga 'MUÑOZ' y 'Unión'
 * de la misma regla.
 */
function repararPalabra(palabra: string): string | null {
  const posiciones = [...palabra].map((c, i) => (c === '?' ? i : -1)).filter((i) => i >= 0);
  if (!posiciones.length) return null;
  // Con más de dos '?' la combinatoria deja de ser fiable y no vale la pena forzarla.
  if (posiciones.length > 2) return null;

  const candidatos: string[] = [];
  const combinar = (parcial: string, idx: number) => {
    if (idx === posiciones.length) { candidatos.push(parcial); return; }
    const pos = posiciones[idx];
    const vecina = parcial[pos - 1] ?? parcial[pos + 1] ?? '';
    const mayuscula = vecina === vecina.toUpperCase() && vecina !== vecina.toLowerCase();
    for (const esp of ESPECIALES) {
      const ch = mayuscula ? esp : esp.toLowerCase();
      combinar(parcial.slice(0, pos) + ch + parcial.slice(pos + 1), idx + 1);
    }
  };
  combinar(palabra, 0);

  const aciertos = candidatos
    .map((c) => ({ c, n: bueno.get(c.toLowerCase()) ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  if (!aciertos.length) return null;
  // Empate real (dos palabras distintas igual de frecuentes): no se elige por sorteo.
  if (aciertos.length > 1 && aciertos[0].n === aciertos[1].n && sinTildes(aciertos[0].c) !== sinTildes(aciertos[1].c)) return null;
  return aciertos[0].c;
}

const sinResolver = new Map<string, number>();
/** Todo lo que se cambia queda anotado en disco antes de escribir: sin esto, deshacerlo sería a mano. */
const respaldo: { tabla: string; columna: string; id: string | number; antes: string; despues: string }[] = [];

/** Repara un texto completo; devuelve null si no cambió nada. */
function repararTexto(texto: string): string | null {
  if (!DANADA.test(texto)) return null;
  let cambio = false;
  const salida = texto.replace(PALABRAS, (palabra) => {
    if (!DANADA.test(palabra)) return palabra;
    const fija = repararPalabra(palabra);
    if (!fija) {
      sinResolver.set(palabra, (sinResolver.get(palabra) ?? 0) + 1);
      return palabra;
    }
    cambio = true;
    return fija;
  });
  return cambio ? salida : null;
}

async function main() {
  console.log(`\n╔══ Reparación de caracteres ${LEGACY ? 'en el LEGACY (MySQL)' : 'en Postgres'} · ${COMMIT ? 'ESCRIBIENDO' : 'EN SECO'} ══\n`);

  // 1) Diccionario: todo lo que ya está bien escrito en las mismas columnas.
  for (const [tabla, columna] of COLUMNAS) {
    const filas = await prisma.$queryRawUnsafe<{ v: string }[]>(
      `SELECT "${columna}" v FROM "${tabla}" WHERE "${columna}" ~ '[ÑñÁÉÍÓÚÜáéíóúü]'`);
    for (const f of filas) aprender(f.v);
  }
  console.log(`Diccionario: ${bueno.size} palabras bien escritas aprendidas de la propia base.`);

  const my = LEGACY
    ? await createConnection({
        host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT || 3306),
        user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD,
        database: process.env.LEGACY_DB_NAME, charset: 'utf8mb4',
      })
    : null;

  // El legacy también enseña: allá hay 93 apellidos con la Ñ intacta.
  if (my) {
    const [filas] = await my.query<any[]>(`SELECT ${COLUMNAS_LEGACY.join(',')} FROM customers`);
    for (const f of filas) for (const c of COLUMNAS_LEGACY) aprender(f[c]);
    console.log(`Diccionario tras leer el legacy: ${bueno.size} palabras.`);
  }

  let totalFilas = 0, totalCambios = 0;

  if (!LEGACY) {
    for (const [tabla, columna] of COLUMNAS) {
      const filas = await prisma.$queryRawUnsafe<{ id: string; v: string }[]>(
        `SELECT id, "${columna}" v FROM "${tabla}" WHERE "${columna}" ~ '\\?'`);
      const cambios = filas
        .map((f) => ({ id: f.id, antes: f.v, despues: repararTexto(f.v) }))
        .filter((c): c is { id: string; antes: string; despues: string } => !!c.despues);
      if (!cambios.length) continue;
      totalFilas += filas.length; totalCambios += cambios.length;
      console.log(`\n── ${tabla}.${columna}: ${cambios.length} de ${filas.length} filas con '?' ──`);
      for (const c of cambios.slice(0, LIMITE)) {
        console.log(`   ${c.antes.slice(0, 70).replace(/\n/g, ' ')}`);
        console.log(`   → ${c.despues.slice(0, 70).replace(/\n/g, ' ')}`);
      }
      for (const c of cambios) respaldo.push({ tabla, columna, id: c.id, antes: c.antes, despues: c.despues });
      if (COMMIT) {
        for (const c of cambios) {
          await prisma.$executeRawUnsafe(`UPDATE "${tabla}" SET "${columna}" = $1 WHERE id = $2`, c.despues, c.id);
        }
        console.log(`   ✔ ${cambios.length} filas actualizadas.`);
      }
    }
  } else {
    const [filas] = await my!.query<any[]>(`SELECT id, ${COLUMNAS_LEGACY.join(',')} FROM customers`);
    const cambios: { id: number; sets: Record<string, string>; muestra: string }[] = [];
    for (const f of filas) {
      const sets: Record<string, string> = {};
      for (const c of COLUMNAS_LEGACY) {
        const v = f[c];
        if (typeof v !== 'string' || !v.includes('?')) continue;
        const nuevo = repararTexto(v);
        if (nuevo) sets[c] = nuevo;
      }
      if (Object.keys(sets).length) {
        cambios.push({ id: f.id, sets, muestra: Object.entries(sets).map(([k, v]) => `${f[k]} → ${v}`).join(' · ') });
      }
    }
    totalCambios = cambios.length;
    console.log(`\n── customers (legacy): ${cambios.length} clientes a corregir ──`);
    for (const c of cambios.slice(0, LIMITE)) console.log(`   #${c.id}  ${c.muestra}`);
    for (const c of cambios) {
      for (const [col, val] of Object.entries(c.sets)) {
        respaldo.push({ tabla: 'customers', columna: col, id: c.id, antes: filas.find((f: any) => f.id === c.id)[col], despues: val });
      }
    }
    if (COMMIT) {
      for (const c of cambios) {
        const cols = Object.keys(c.sets);
        await my!.execute(
          `UPDATE customers SET ${cols.map((k) => `\`${k}\`=?`).join(', ')} WHERE id = ?`,
          [...cols.map((k) => c.sets[k]), c.id],
        );
      }
      console.log(`   ✔ ${cambios.length} clientes actualizados en el legacy.`);
    }
  }

  // El respaldo se escribe SIEMPRE, también en seco: así se puede revisar el
  // detalle completo antes de decidir, y deshacerlo después si algo salió torcido.
  const archivo = join(__dirname, `_respaldo-caracteres-${LEGACY ? 'legacy' : 'pg'}.json`);
  writeFileSync(archivo, JSON.stringify(respaldo, null, 1));
  console.log(`\nRespaldo del antes/después: ${archivo} (${respaldo.length} campos)`);

  const pendientes = [...sinResolver.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n╚══ ${totalCambios} textos reparables${LEGACY ? '' : ` (de ${totalFilas} con '?')`} ══`);
  if (pendientes.length) {
    console.log(`\nSin resolver (${pendientes.length} palabras distintas): no cazan con ninguna palabra bien escrita de la base, así que se dejan como están.`);
    for (const [p, n] of pendientes.slice(0, 20)) console.log(`   ${p}  ×${n}`);
  }
  if (!COMMIT) console.log('\n(en seco: no se escribió nada; agrega --commit)');

  await my?.end();
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
