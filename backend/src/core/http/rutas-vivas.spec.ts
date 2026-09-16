/**
 * Los otros dos candados de la misma familia que `rutas-tapadas`: que la ruta
 * EXISTA, y que exista donde alguien la llama.
 *
 * EL FALLO QUE ESTO IMPIDE
 * ------------------------
 * El 10/9 el técnico abría "Registrar material consumido" y veía la lista vacía.
 * No era stock ni permisos: `GET support/materials/warehouses` no existía. El
 * método estaba escrito en `SupportController`, pero sin entrada en
 * `contrato-http.json` —de donde salen los routers— no hay ruta que llame a ese
 * método. Con la misma piedra estaban caídos el historial del técnico, los
 * motivos de "Nueva factura", el material de /proyectos y la venta de combos.
 *
 * Nada lo delataba: compila, arranca, los tests del servicio pasan, y el 404 que
 * responde llega al navegador como una lista vacía. Se ve en producción, semanas
 * después, y en boca de quien no puede trabajar.
 *
 * DOS COMPROBACIONES
 * ------------------
 *  1. El contrato y lo que Express monta de verdad dicen lo mismo. Cubre el hueco
 *     en los dos sentidos: la entrada que nadie regeneró (ruta que no existe) y el
 *     router editado a mano que se perdería en el próximo `generar:routers`.
 *  2. Toda URL que el frontend pide con `authFetch` tiene ruta en el backend. Es
 *     la que habría cazado el fallo el día que se escribió el modal, porque mira
 *     el consumo real y no sólo la coherencia interna del backend.
 *
 * Ver también `handlers-sin-ruta.spec.ts` (el eslabón controlador → contrato).
 */
// Importar los routers arrastra DTOs con decoradores de class-validator.
import 'reflect-metadata';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { RUTAS } from '../rutas';
import { rutasDe } from './ruta';

const RAIZ = join(__dirname, '..', '..', '..');
const FRONTEND = join(RAIZ, '..', 'frontend', 'src');

type Entrada = { metodo: string; ruta: string };
const contrato: Entrada[] = JSON.parse(readFileSync(join(RAIZ, 'contrato-http.json'), 'utf8'));

/** Lo que Express monta de verdad: prefijo del índice + ruta del router. */
const montadas = RUTAS.flatMap(({ prefijo, router }) =>
  rutasDe(router).map((r) => ({
    metodo: r.metodo.toUpperCase(),
    ruta: `/api/${prefijo}${r.ruta === '/' ? '' : r.ruta}`.replace(/\/+$/, ''),
  })),
);

const clave = (e: Entrada) => `${e.metodo} ${e.ruta}`;

/**
 * Routers escritos a mano: no salen del contrato y por eso no se les exige estar
 * en él. La lista es la prueba de que son una decisión y no un descuido — ver
 * `scripts/generar-routers.ts`.
 */
const A_MANO = ['/api/plan-bundles'];

describe('el contrato y las rutas montadas dicen lo mismo', () => {
  it('toda entrada del contrato está montada (si no, es un 404 con el handler escrito)', () => {
    const montado = new Set(montadas.map(clave));
    expect(contrato.map(clave).filter((k) => !montado.has(k)).sort()).toEqual([]);
  });

  it('toda ruta montada está en el contrato (si no, la borra el próximo generar:routers)', () => {
    const enContrato = new Set(contrato.map(clave));
    const huerfanas = montadas
      .filter((r) => !enContrato.has(clave(r)) && !A_MANO.some((p) => r.ruta === p || r.ruta.startsWith(`${p}/`)))
      .map(clave);
    expect(huerfanas.sort()).toEqual([]);
  });
});

/** Un segmento interpolado en el frontend casa con cualquiera del backend. */
function existeEnBackend(url: string): boolean {
  const partes = url.split('/').filter(Boolean);
  return montadas.some(({ ruta }) => {
    const patron = ruta.replace(/^\/api/, '').split('/').filter(Boolean);
    if (patron.length !== partes.length) return false;
    return patron.every((seg, i) => seg.startsWith(':') || partes[i].includes(':p') || seg === partes[i]);
  });
}

/**
 * El primer argumento de cada llamada a la API, con las interpolaciones (que
 * pueden llevar llaves anidadas: `${a ? `${b}` : ''}`) reducidas a `:p`.
 *
 * `authFetch` es la puerta de casi todas, pero el login, el "olvidé mi contraseña"
 * y el portal salen por un `fetch(`${API_URL}…`)` a pelo — que es justo donde un
 * 404 deja a alguien sin poder entrar.
 */
function urlsDe(src: string): string[] {
  const urls: string[] = [];
  const re = /\b(?:authFetch|fetch)\(\s*([`"'])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const comilla = m[1];
    let texto = '';
    let profundidad = 0;
    for (let i = re.lastIndex; i < src.length; i++) {
      const c = src[i];
      if (profundidad === 0 && c === comilla) break;
      if (c === '$' && src[i + 1] === '{') { profundidad++; i++; texto += '${'; continue; }
      if (profundidad > 0) {
        if (c === '{') profundidad++;
        if (c === '}') profundidad--;
      }
      texto += c;
    }
    urls.push(texto);
  }
  return urls;
}

function ficherosDel(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? ficherosDel(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('las URL que llama el frontend existen en el backend', () => {
  it('ninguna llamada del frontend apunta a una ruta que no existe', () => {
    const rotas = new Map<string, Set<string>>();
    for (const fichero of ficherosDel(FRONTEND)) {
      for (const cruda of urlsDe(readFileSync(fichero, 'utf8'))) {
        const url = cruda
          .replace(/^\$\{API_URL\}/, '')
          .replace(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, ':p')
          .split('?')[0]
          .replace(/\/+$/, '');
        // Sólo las absolutas de la API: las relativas las arma quien llama.
        if (!url.startsWith('/') || existeEnBackend(url)) continue;
        rotas.set(url, (rotas.get(url) ?? new Set()).add(relative(FRONTEND, fichero)));
      }
    }
    expect([...rotas].map(([url, ff]) => `${url} ← ${[...ff].join(', ')}`).sort()).toEqual([]);
  });
});
