/**
 * Repone los imports de `core/http/errores` y `core/logger` allí donde hacen falta.
 *
 * Al quitar los decoradores se borró también el `import ... from '@nestjs/common'`
 * de cada controlador — y esa línea traía, además de los decoradores, las
 * excepciones y el `Logger` que el cuerpo del método sigue usando. En vez de
 * intentar adivinar durante el borrado qué símbolo era decorador y cuál no, se
 * repone aquí: se mira qué nombres usa el fichero, cuáles no tiene declarados ni
 * importados, y se añade el import que falta.
 *
 * Uso: npx ts-node --transpile-only scripts/reponer-imports-core.ts [--aplicar]
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC = path.join(__dirname, '..', 'src');
const APLICAR = process.argv.includes('--aplicar');

const DE_ERRORES = [
  'HttpException', 'HttpStatus', 'BadRequestException', 'UnauthorizedException',
  'ForbiddenException', 'NotFoundException', 'ConflictException',
  'PayloadTooLargeException', 'UnprocessableEntityException',
  'InternalServerErrorException', 'ServiceUnavailableException',
];
const DE_LOGGER = ['Logger'];

function ficherosTs(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) ficherosTs(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

const rel = (fichero: string, destino: string) => {
  const r = path.relative(path.dirname(fichero), path.join(SRC, destino)).split(path.sep).join('/');
  return r.startsWith('.') ? r : `./${r}`;
};

let tocados = 0;
for (const fichero of ficherosTs(SRC)) {
  if (fichero.includes(`${path.sep}core${path.sep}`)) continue;
  const texto = fs.readFileSync(fichero, 'utf8');
  const sf = ts.createSourceFile(fichero, texto, ts.ScriptTarget.Latest, true);

  // Nombres ya importados o declarados en el fichero: esos no hay que reponerlos.
  const yaDisponibles = new Set<string>();
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s)) {
      const b = s.importClause?.namedBindings;
      if (b && ts.isNamedImports(b)) for (const el of b.elements) yaDisponibles.add(el.name.text);
      if (s.importClause?.name) yaDisponibles.add(s.importClause.name.text);
    }
    if (ts.isClassDeclaration(s) && s.name) yaDisponibles.add(s.name.text);
  }

  const usa = (n: string) => new RegExp(`\\b${n}\\b`).test(texto) && !yaDisponibles.has(n);
  const errores = DE_ERRORES.filter(usa);
  const logger = DE_LOGGER.filter(usa);
  if (!errores.length && !logger.length) continue;

  const nuevas: string[] = [];
  if (errores.length) nuevas.push(`import { ${errores.join(', ')} } from '${rel(fichero, 'core/http/errores')}';`);
  if (logger.length) nuevas.push(`import { ${logger.join(', ')} } from '${rel(fichero, 'core/logger')}';`);

  tocados++;
  console.log(`   ${path.relative(SRC, fichero).padEnd(52)} + ${[...errores, ...logger].join(', ')}`);
  if (APLICAR) fs.writeFileSync(fichero, `${nuevas.join('\n')}\n${texto}`);
}
console.log(`\n${APLICAR ? 'APLICADO' : 'SIMULACRO'}: ${tocados} ficheros`);
