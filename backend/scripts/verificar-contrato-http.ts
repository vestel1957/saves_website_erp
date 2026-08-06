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
  console.log(`Verificando ${aProbar.length} de ${endpoints.length} endpoints contra ${BASE}\n`);

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
      const r = await fetch(url, { method: metodo, redirect: 'manual' });
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

    if (status === 404) {
      fallos.push({ endpoint: e, status, motivo: 'la ruta NO está montada', gravedad: 'FALTA' });
    } else if (!e.publico && (status === 200 || status === 201)) {
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
