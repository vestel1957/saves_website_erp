/**
 * Lee de los routers generados qué áreas y permisos exige cada handler.
 *
 * Antes esta información se sacaba con `Reflect.getMetadata(AREAS_KEY, ...)` sobre
 * los decoradores `@RequireArea`. Al migrar a Express esos decoradores desaparecen:
 * la exigencia vive ahora en la línea de la ruta, dentro del router
 * (`exigirArea('contabilidad', ...)`).
 *
 * Este módulo la recupera leyendo los routers con el AST. Es importante que la lea de
 * AHÍ y no del contrato congelado en `contrato-http.json`: el contrato es la foto de
 * cómo era la API con Nest, así que un cambio futuro que le abriera una ruta de más a
 * la cajera no se detectaría. Leyendo el código que de verdad se ejecuta, el smoke
 * test sigue vigilando hacia adelante, que es para lo que se escribió.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC = path.join(__dirname, '..', '..', 'src');

export interface ExigenciaDeRuta {
  areas: string[];
  orPermission: string[];
  permisos: string[];
}

function ficherosRouter(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) ficherosRouter(p, acc);
    else if (e.name.endsWith('.router.ts')) acc.push(p);
  }
  return acc;
}

/** Desenvuelve un literal de cadena; devuelve null si el argumento es una expresión. */
function comoCadena(n: ts.Expression): string | null {
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;
}

/**
 * Mapa `Controlador.metodo` -> lo que la ruta exige.
 *
 * Si un método aparece en varias rutas (raro, pero posible), se queda la PRIMERA:
 * el smoke test pregunta por un método concreto y todas sus rutas comparten guardas
 * en la práctica.
 */
export function exigenciasPorHandler(): Map<string, ExigenciaDeRuta> {
  const mapa = new Map<string, ExigenciaDeRuta>();

  for (const fichero of ficherosRouter(SRC)) {
    const texto = fs.readFileSync(fichero, 'utf8');
    const sf = ts.createSourceFile(fichero, texto, ts.ScriptTarget.Latest, true);

    // De `const treasury = new TreasuryController(...)` sale qué clase hay detrás de
    // la variable que usan los handlers.
    const claseDeVariable = new Map<string, string>();
    sf.forEachChild((n) => {
      if (!ts.isVariableStatement(n)) return;
      for (const d of n.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (ts.isNewExpression(d.initializer) && ts.isIdentifier(d.initializer.expression)) {
          claseDeVariable.set(d.name.text, d.initializer.expression.text);
        }
      }
    });

    // Cada `router.get('/x', autenticar, exigirArea(...), manejar(...))`.
    const visitar = (nodo: ts.Node) => {
      if (ts.isCallExpression(nodo) && ts.isPropertyAccessExpression(nodo.expression)) {
        const metodoHttp = nodo.expression.name.text;
        if (['get', 'post', 'put', 'patch', 'delete'].includes(metodoHttp)) {
          const exigencia: ExigenciaDeRuta = { areas: [], orPermission: [], permisos: [] };
          let clave: string | null = null;

          for (const arg of nodo.arguments) {
            if (!ts.isCallExpression(arg)) continue;
            const nombre = arg.expression.getText(sf);

            if (nombre === 'exigirArea') {
              for (const a of arg.arguments) {
                const s = comoCadena(a);
                if (s) exigencia.areas.push(s);
              }
            } else if (nombre === 'exigirAreaCon') {
              const obj = arg.arguments[0];
              if (obj && ts.isObjectLiteralExpression(obj)) {
                for (const prop of obj.properties) {
                  if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
                  if (!ts.isArrayLiteralExpression(prop.initializer)) continue;
                  const valores = prop.initializer.elements
                    .map((e) => comoCadena(e) ?? e.getText(sf))
                    .filter(Boolean);
                  if (prop.name.text === 'areas') exigencia.areas.push(...(valores as string[]));
                  if (prop.name.text === 'orPermission') {
                    exigencia.orPermission.push(...(valores as string[]));
                  }
                }
              }
            } else if (nombre === 'exigirPermisos') {
              for (const a of arg.arguments) exigencia.permisos.push(comoCadena(a) ?? a.getText(sf));
            } else if (nombre === 'manejar') {
              // `manejar((req) => treasury.editTx(...))` -> "TreasuryController.editTx"
              const texto = arg.getText(sf);
              const m = texto.match(/=>\s*([A-Za-z0-9_$]+)\.([A-Za-z0-9_$]+)\s*\(/);
              if (m) {
                const clase = claseDeVariable.get(m[1]);
                if (clase) clave = `${clase}.${m[2]}`;
              }
            }
          }

          if (clave && !mapa.has(clave)) mapa.set(clave, exigencia);
        }
      }
      nodo.forEachChild(visitar);
    };
    sf.forEachChild(visitar);
  }

  return mapa;
}
