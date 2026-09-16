/**
 * El candado del otro fallo mudo de las rutas: el handler que existe en el
 * controlador pero al que NADIE puede llegar.
 *
 * `contrato-http.json` es la fuente de la que salen los routers
 * (`scripts/generar-routers.ts`). Un método nuevo en un controlador NO se cablea
 * solo: si no se le añade su entrada al contrato, compila, pasa los tests y en
 * producción responde 404 — que en el frontend se lee como "no hay datos", no
 * como "esa ruta no existe". Así se quedó el técnico sin material en la orden
 * (`GET support/materials/warehouses`), sin su historial (`support/mi-historial`)
 * y la ventanilla sin motivos al facturar (`billing/motivos`).
 *
 * Se comprueba contra el fichero fuente, no contra los routers ya generados: lo
 * que se vigila es justo el hueco entre el controlador y el contrato.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

type Entrada = { controlador: string; fichero: string; handler: string };

const RAIZ = join(__dirname, '..', '..', '..');
const contrato: Entrada[] = JSON.parse(readFileSync(join(RAIZ, 'contrato-http.json'), 'utf8'));

/** Palabras que un `nombre(` puede ser sin ser un método. */
const NO_METODOS = new Set(['constructor', 'if', 'for', 'while', 'switch', 'catch', 'return']);

/**
 * Métodos públicos por clase de un fichero de controlador. Un fichero puede
 * declarar dos (`promotions.controller.ts` lleva PromotionsController y
 * MyPromotionsController), así que se trocea por `class X` antes de leer los
 * métodos, o los de uno se le atribuyen al otro.
 */
function metodosPorClase(src: string): Map<string, Set<string>> {
  const clases = new Map<string, Set<string>>();
  const trozos = src.split(/^export (?:abstract )?class /m).slice(1);
  for (const trozo of trozos) {
    const nombre = trozo.match(/^(\w+)/)?.[1];
    if (!nombre) continue;
    const metodos = new Set<string>();
    for (const [, m] of trozo.matchAll(/^ {2}(?:async )?(\w+)\s*\(/gm)) {
      if (!NO_METODOS.has(m)) metodos.add(m);
    }
    clases.set(nombre, metodos);
  }
  return clases;
}

/**
 * Handlers que a propósito no tienen ruta. Cada uno con su razón: la lista es
 * corta o deja de ser un candado.
 */
const SIN_RUTA_A_PROPOSITO: Record<string, string> = {};

describe('handlers sin ruta en el contrato', () => {
  const porControlador = new Map<string, { fichero: string; handlers: Set<string> }>();
  for (const e of contrato) {
    const ficha = porControlador.get(e.controlador) ?? { fichero: e.fichero, handlers: new Set<string>() };
    ficha.handlers.add(e.handler);
    porControlador.set(e.controlador, ficha);
  }

  it('todo método público de un controlador tiene su entrada en el contrato', () => {
    const huerfanos: string[] = [];
    const leidos = new Map<string, Map<string, Set<string>>>();

    for (const [controlador, { fichero, handlers }] of porControlador) {
      const ruta = join(RAIZ, fichero);
      if (!existsSync(ruta)) throw new Error(`El contrato apunta a un fichero que no existe: ${fichero}`);
      if (!leidos.has(fichero)) leidos.set(fichero, metodosPorClase(readFileSync(ruta, 'utf8')));
      const metodos = leidos.get(fichero)!.get(controlador);
      if (!metodos) throw new Error(`No se encontró la clase ${controlador} en ${fichero}`);

      for (const m of metodos) {
        const clave = `${controlador}.${m}`;
        if (!handlers.has(m) && !(clave in SIN_RUTA_A_PROPOSITO)) huerfanos.push(clave);
      }
    }

    expect(huerfanos.sort()).toEqual([]);
  });
});
