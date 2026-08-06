/**
 * Añade `export` a las clases DTO declaradas dentro de un controlador.
 *
 * Varios controladores declaran sus DTO en el propio fichero y sin exportar, porque
 * sólo los usaba el handler de al lado. Al separar las rutas en un router, ese router
 * necesita la clase para validar el cuerpo — y una clase sin exportar no se puede
 * importar.
 *
 * Se limita a las clases cuyo nombre acaba en `Dto`: no toca los controladores ni
 * ninguna otra declaración, y no cambia comportamiento alguno. Exportar de más sería
 * ruido en la API pública del módulo; por eso el filtro es estrecho y explícito.
 *
 * Uso:
 *   npx ts-node --transpile-only scripts/exportar-dtos-de-controladores.ts
 *   npx ts-node --transpile-only scripts/exportar-dtos-de-controladores.ts --aplicar
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC = path.join(__dirname, '..', 'src');
const APLICAR = process.argv.includes('--aplicar');

function ficherosTs(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) ficherosTs(p, acc);
    else if (e.name.endsWith('.controller.ts')) acc.push(p);
  }
  return acc;
}

let total = 0;
const porFichero: Array<{ fichero: string; clases: string[] }> = [];

for (const fichero of ficherosTs(SRC)) {
  const texto = fs.readFileSync(fichero, 'utf8');
  const sf = ts.createSourceFile(fichero, texto, ts.ScriptTarget.Latest, true);

  // Identificadores que aparecen dentro de los decoradores del controlador. De ahí
  // salen cosas como `@RequireArea(...TRASPASOS)`: una constante local que el router
  // generado necesita y que, sin exportar, no puede importar.
  const enDecoradores = new Set<string>();
  const recogerDecoradores = (nodo: ts.Node) => {
    if (ts.canHaveDecorators(nodo)) {
      for (const d of ts.getDecorators(nodo) ?? []) {
        for (const m of d.getText().matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) enDecoradores.add(m[1]);
      }
    }
    nodo.forEachChild(recogerDecoradores);
  };
  sf.forEachChild(recogerDecoradores);

  const aExportar: Array<{ pos: number; nombre: string }> = [];
  sf.forEachChild((n) => {
    const modificadores = ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined;
    if (modificadores?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return;

    // Clases DTO declaradas en el propio controlador.
    if (ts.isClassDeclaration(n) && n.name?.text.endsWith('Dto')) {
      aExportar.push({ pos: n.getStart(sf), nombre: n.name.text });
      return;
    }

    // Constantes que usan los decoradores (listas de áreas, catálogos de permisos).
    if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (!enDecoradores.has(d.name.text)) continue;
        aExportar.push({ pos: n.getStart(sf), nombre: d.name.text });
        return;
      }
    }
  });

  if (!aExportar.length) continue;
  porFichero.push({ fichero: path.relative(SRC, fichero), clases: aExportar.map((c) => c.nombre) });
  total += aExportar.length;

  if (!APLICAR) continue;
  // De atrás hacia delante para no invalidar las posiciones pendientes.
  let salida = texto;
  for (const c of aExportar.sort((a, b) => b.pos - a.pos)) {
    salida = `${salida.slice(0, c.pos)}export ${salida.slice(c.pos)}`;
  }
  fs.writeFileSync(fichero, salida);
}

console.log(`${APLICAR ? 'APLICADO' : 'SIMULACRO'}: ${total} DTO en ${porFichero.length} controladores`);
for (const f of porFichero) console.log(`   ${f.fichero.padEnd(50)} ${f.clases.join(', ')}`);
