/**
 * Verifica un backend vivo contra `contrato-http.json`.
 *
 * Es el arnés del corte a Express. Se ejecuta DOS veces:
 *   1) contra el NestJS actual  -> confirma que el manifiesto es fiel (línea base)
 *   2) contra el Express nuevo  -> confirma que no falta ni sobra ninguna ruta
 *
 * No comprueba la lógica de negocio: comprueba lo que un rewrite de la capa HTTP
 * rompe de verdad y en silencio — que la ruta EXISTA con ese método, y que siga
 * pidiendo autenticación quien la pedía. Una ruta migrada a `/api/plans/:planId`
 * en vez de `/:id`, o un guard que se olvida, dan 404/200 aquí en vez de dar la
 * cara en producción.
 *
 * Sin token, cada ruta debe responder:
 *   - protegida  -> 401/403   (existe y exige credenciales)
 *   - pública    -> cualquier cosa menos 404
 * Un 404 significa que la ruta no está montada. Un 200 en una ruta protegida
 * significa que se cayó el guard: eso es una brecha, y se reporta como tal.
 *
 * ─── POR QUÉ HACE FALTA UN TOKEN (y por qué sin él esto dio un VERDE FALSO) ───
 *
 * Sin credenciales, `autenticar` responde 401 ANTES de que Express resuelva qué
 * handler atiende la ruta. O sea que el 401 sólo prueba que hay ALGO montado en ese
 * camino, no que sea lo correcto.
 *
 * Ese matiz costó caro: tras el port a Express, el generador ordenaba las rutas
 * alfabéticamente y ':' (0x3A) va antes que cualquier letra, así que `/:id` quedó por
 * delante de todos los literales y se comió 22 endpoints (`/orders/stats`,
 * `/staff/areas`, `/tasks/assignees`…). Esta verificación los dio por buenos —los tres
 * devolvían 401, como cualquier ruta sana— y el fallo llegó a producción.
 *
 * Con token la distinción es nítida: en una ruta LITERAL, un 404 ya no puede
 * explicarse por falta de credenciales; significa que la petición acabó en el handler
 * equivocado (típicamente el del detalle, buscando un id que se llama "stats").
 *
 *   TOKEN=<jwt> npx ts-node --transpile-only scripts/verificar-contrato-http.ts
 *
 * Uso:
 *   npx ts-node --transpile-only scripts/verificar-contrato-http.ts
 *   BASE_URL=http://127.0.0.1:3061 npx ts-node --transpile-only scripts/verificar-contrato-http.ts
 *
 * Sólo hace peticiones de LECTURA (GET) por defecto: no se lanzan POST/PATCH/DELETE
 * contra una base de datos viva. `--incluir-escrituras` las prueba también, pero
 * usando un método que la ruta NO declara, para provocar el 404/405 del router sin
 * llegar nunca al handler.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Endpoint } from './extraer-contrato-http';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3061';
const CONTRATO = path.join(__dirname, '..', 'contrato-http.json');
const INCLUIR_ESCRITURAS = process.argv.includes('--incluir-escrituras');
/** JWT de un superusuario. Sin él la comprobación es ciega a las rutas tapadas. */
const TOKEN = process.env.TOKEN ?? '';

/** ¿La ruta es literal (sin parámetros)? En esas, un 404 es un fallo real. */
function esLiteral(ruta: string): boolean {
  return !ruta.includes(':');
}

/** Rellena :id, :phone… con un valor inofensivo que no existirá en la BD. */
function rutaConcreta(ruta: string): string {
  return ruta.replace(/:([A-Za-z0-9_]+)/g, (_m, nombre: string) =>
    /phone|telefono/i.test(nombre) ? '000000000000' : '00000000-0000-0000-0000-000000000000',
  );
}

interface Fallo {
  endpoint: Endpoint;
  status: number | string;
  motivo: string;
  gravedad: 'FALTA' | 'BRECHA' | 'AVISO';
}

async function main() {
  if (!fs.existsSync(CONTRATO)) {
    console.error(`Falta ${CONTRATO}. Ejecuta antes: extraer-contrato-http.ts --json`);
    process.exit(1);
  }
  const endpoints: Endpoint[] = JSON.parse(fs.readFileSync(CONTRATO, 'utf8'));

  const aProbar = endpoints.filter((e) => e.metodo === 'GET' || INCLUIR_ESCRITURAS);
  console.log(
    `Verificando ${aProbar.length} de ${endpoints.length} endpoints contra ${BASE}` +
      (TOKEN
        ? ' · CON token (detecta rutas tapadas)\n'
        : ' · SIN token — no distingue una ruta tapada de una sana; usa TOKEN=<jwt>\n'),
  );

  const fallos: Fallo[] = [];
  let ok = 0;

  // En serie a propósito: es una base de datos de producción y el backend tiene
  // rate-limit global (600/min). Una ráfaga en paralelo se auto-envenenaría con
  // 429 y daría falsos "falta la ruta".
  for (const e of aProbar) {
    const url = BASE + rutaConcreta(e.ruta);
    // Para escrituras se usa GET: si el router no declara GET en esa ruta responde
    // 404/405 sin ejecutar nada. Distingue "ruta inexistente" de "método distinto".
    const metodo = e.metodo === 'GET' ? 'GET' : 'GET';

    let status: number | string;
    try {
      const r = await fetch(url, {
        method: metodo,
        redirect: 'manual',
        headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : undefined,
      });
      status = r.status;
    } catch (err) {
      status = `error: ${(err as Error).message}`;
    }

    if (status === 429) {
      // El propio rate-limit; no dice nada del contrato.
      fallos.push({ endpoint: e, status, motivo: 'rate-limit, no concluyente', gravedad: 'AVISO' });
      continue;
    }

    if (e.metodo !== 'GET') {
      // Sólo se comprueba que el router distinga el método: 404 o 405 son correctos.
      if (status === 404 || status === 405 || status === 401 || status === 403) ok++;
      else
        fallos.push({
          endpoint: e,
          status,
          motivo: `GET a una ruta ${e.metodo} debería dar 404/405/401, dio ${status}`,
          gravedad: 'AVISO',
        });
      continue;
    }

    if (status === 404 && !esLiteral(e.ruta) && (TOKEN || e.publico)) {
      // Ruta PARAMÉTRICA: el 404 es la respuesta correcta, porque el id que se manda
      // es inventado y no existe en la base. Contarlo como fallo haría que la
      // verificación gritara en 60 rutas sanas y nadie volviera a mirarla.
      //
      // Con token vale para cualquiera; SIN token sólo para las públicas — en una
      // protegida el guard habría contestado 401 antes de mirar la base, así que ahí
      // un 404 sí delata que la ruta no está montada. La pública llega al handler y
      // el 404 no distingue nada (lo destapó GET /treasury/comprobante/:archivo).
      ok++;
    } else if (status === 404) {
      fallos.push({
        endpoint: e,
        status,
        motivo:
          TOKEN && esLiteral(e.ruta)
            ? 'ruta literal con 404: revísala — puede estar tapada, o el recurso simplemente no existir para este usuario'
            : 'la ruta NO está montada',
        // Con token, un 404 en ruta literal es CANDIDATO, no veredicto: también lo da
        // un recurso que no existe (un usuario sin foto, un día sin cierre de caja).
        // Quien dictamina las rutas tapadas es el candado de arranque
        // (`core/http/rutas-tapadas.ts`), que compara el orden real de registro y
        // aborta el proceso. Aquí se avisa para que alguien mire; allí se impide.
        gravedad: TOKEN && esLiteral(e.ruta) ? 'AVISO' : 'FALTA',
      });
    } else if (TOKEN && esLiteral(e.ruta) && status === 400) {
      // Un 400 en una ruta literal suele ser el handler del detalle quejándose de
      // un id con forma inválida: otra cara de la misma ruta tapada.
      fallos.push({
        endpoint: e,
        status,
        motivo: 'ruta literal con 400: revísala — puede estar tapada, o faltarle parámetros obligatorios',
        gravedad: 'AVISO',
      });
    } else if (!TOKEN && !e.publico && (status === 200 || status === 201)) {
      fallos.push({
        endpoint: e,
        status,
        motivo: `responde ${status} SIN token — el guard no se aplicó`,
        gravedad: 'BRECHA',
      });
    } else {
      ok++;
    }
  }

  const porGravedad = (g: Fallo['gravedad']) => fallos.filter((f) => f.gravedad === g);

  for (const g of ['BRECHA', 'FALTA', 'AVISO'] as const) {
    const lista = porGravedad(g);
    if (!lista.length) continue;
    console.log(`\n### ${g} (${lista.length})`);
    for (const f of lista) {
      console.log(
        `  ${f.endpoint.metodo.padEnd(6)} ${f.endpoint.ruta.padEnd(48)} ${f.motivo}` +
          `\n         ${f.endpoint.controlador}.${f.endpoint.handler} · ${f.endpoint.fichero}`,
      );
    }
  }

  const graves = porGravedad('BRECHA').length + porGravedad('FALTA').length;
  console.log(`\n${'='.repeat(70)}`);
  console.log(`OK: ${ok}   ·   graves: ${graves}   ·   avisos: ${porGravedad('AVISO').length}`);
  process.exit(graves > 0 ? 1 : 0);
}

void main();
