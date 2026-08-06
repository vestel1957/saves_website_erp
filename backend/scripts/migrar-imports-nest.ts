/**
 * Codemod: quita `@nestjs/common` de los ficheros que NO son controladores.
 *
 * Son 227 ficheros y 802 lanzamientos de excepción. A mano es inviable y, sobre todo,
 * es donde se cuela el error tonto que nadie ve. Aquí se hace con el AST: se leen los
 * símbolos que cada fichero importa de Nest, se clasifican, y se reescribe SÓLO la
 * línea del import.
 *
 * Que esto sea un simple cambio de import es consecuencia de una decisión de diseño:
 * `core/http/errores.ts` replica la firma de las excepciones de Nest, así que los 802
 * `throw new NotFoundException(...)` no se tocan.
 *
 * REGLA DE ORO: lo que el codemod no sepa clasificar NO se toca, y se reporta. Es
 * preferible una lista de pendientes a un fichero corrompido en silencio.
 *
 * Uso:
 *   npx ts-node --transpile-only scripts/migrar-imports-nest.ts            # simulacro
 *   npx ts-node --transpile-only scripts/migrar-imports-nest.ts --aplicar  # escribe
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC = path.join(__dirname, '..', 'src');
const APLICAR = process.argv.includes('--aplicar');

/** Símbolos que se sirven desde `core/http/errores`. */
const A_ERRORES = new Set([
  'HttpException',
  'HttpStatus',
  'BadRequestException',
  'UnauthorizedException',
  'ForbiddenException',
  'NotFoundException',
  'ConflictException',
  'PayloadTooLargeException',
  'UnprocessableEntityException',
  'InternalServerErrorException',
  'ServiceUnavailableException',
]);

/** Símbolos que se sirven desde `core/logger`. */
const A_LOGGER = new Set(['Logger']);

/**
 * Símbolos que simplemente DESAPARECEN porque su función la cumple ahora la
 * estructura del código y no un decorador:
 *  - `Injectable`/`Module`/`Global`: las dependencias se cablean en el contenedor.
 *  - Ganchos de ciclo de vida: los llama el arranque explícitamente.
 */
const A_BORRAR = new Set([
  'Injectable',
  'Module',
  'Global',
  'OnModuleInit',
  'OnModuleDestroy',
  'OnApplicationBootstrap',
  'OnApplicationShutdown',
  'INestApplication',
]);

/** Ficheros que se reescriben a mano y que el codemod debe dejar en paz. */
const EXCLUIDOS = [
  '.controller.ts',
  '.guard.ts',
  '.module.ts',
  'current-user.decorator.ts',
  'require-area.decorator.ts',
  'require-permissions.decorator.ts',
  'all-exceptions.filter.ts',
  'audit.interceptor.ts',
  path.join('src', 'core', path.sep),
  'main.ts',
];

function ficherosTs(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) ficherosTs(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/** Ruta relativa desde un fichero a un módulo de `src/core`, en formato de import. */
function rutaACore(fichero: string, modulo: string): string {
  const rel = path.relative(path.dirname(fichero), path.join(SRC, 'core', modulo));
  const conBarras = rel.split(path.sep).join('/');
  return conBarras.startsWith('.') ? conBarras : `./${conBarras}`;
}

interface Resultado {
  fichero: string;
  cambiado: boolean;
  sinClasificar: string[];
}

const resultados: Resultado[] = [];

for (const fichero of ficherosTs(SRC)) {
  if (EXCLUIDOS.some((x) => fichero.includes(x))) continue;

  let texto = fs.readFileSync(fichero, 'utf8');
  if (!texto.includes('@nestjs/common')) continue;

  const sf = ts.createSourceFile(fichero, texto, ts.ScriptTarget.Latest, true);
  const sinClasificar: string[] = [];

  // Se recogen los reemplazos y se aplican de atrás hacia delante, para que los
  // desplazamientos de texto no invaliden las posiciones aún sin procesar.
  const reemplazos: Array<{ inicio: number; fin: number; texto: string }> = [];

  for (const sentencia of sf.statements) {
    if (!ts.isImportDeclaration(sentencia)) continue;
    const desde = (sentencia.moduleSpecifier as ts.StringLiteral).text;
    if (desde !== '@nestjs/common') continue;

    const enlaces = sentencia.importClause?.namedBindings;
    if (!enlaces || !ts.isNamedImports(enlaces)) continue;

    const aErrores: string[] = [];
    const aLogger: string[] = [];

    for (const el of enlaces.elements) {
      // `import { type OnModuleInit }` -> el nombre está en propertyName si hay alias
      const nombre = (el.propertyName ?? el.name).getText();
      if (A_ERRORES.has(nombre)) aErrores.push(el.getText());
      else if (A_LOGGER.has(nombre)) aLogger.push(el.getText());
      else if (A_BORRAR.has(nombre)) continue;
      else sinClasificar.push(nombre);
    }

    // Si queda algo sin clasificar, este fichero necesita ojo humano: no se toca.
    if (sinClasificar.length) break;

    const nuevas: string[] = [];
    if (aErrores.length) {
      nuevas.push(`import { ${aErrores.join(', ')} } from '${rutaACore(fichero, 'http/errores')}';`);
    }
    if (aLogger.length) {
      nuevas.push(`import { ${aLogger.join(', ')} } from '${rutaACore(fichero, 'logger')}';`);
    }

    reemplazos.push({
      inicio: sentencia.getStart(sf),
      fin: sentencia.getEnd(),
      // Sin símbolos que reubicar, el import entero desaparece. Se deja una cadena
      // vacía y luego se limpia la línea en blanco que queda.
      texto: nuevas.join('\n'),
    });
  }

  if (sinClasificar.length) {
    resultados.push({ fichero, cambiado: false, sinClasificar: [...new Set(sinClasificar)] });
    continue;
  }
  if (!reemplazos.length) continue;

  for (const r of reemplazos.sort((a, b) => b.inicio - a.inicio)) {
    texto = texto.slice(0, r.inicio) + r.texto + texto.slice(r.fin);
  }

  // Quitar el decorador `@Injectable()` / `@Global()` cuando ocupa su propia línea.
  texto = texto.replace(/^[ \t]*@(?:Injectable|Global)\(\)[ \t]*\r?\n/gm, '');

  // Un import que se quedó vacío deja una línea en blanco de más al principio.
  texto = texto.replace(/^\n+/, '');

  resultados.push({ fichero, cambiado: true, sinClasificar: [] });
  if (APLICAR) fs.writeFileSync(fichero, texto);
}

const cambiados = resultados.filter((r) => r.cambiado);
const pendientes = resultados.filter((r) => r.sinClasificar.length);

console.log(`${APLICAR ? 'APLICADO' : 'SIMULACRO'} — ${cambiados.length} ficheros migrados\n`);

if (pendientes.length) {
  console.log(`${pendientes.length} ficheros SIN TOCAR (símbolos que el codemod no clasifica):`);
  const porSimbolo = new Map<string, number>();
  for (const p of pendientes) {
    for (const s of p.sinClasificar) porSimbolo.set(s, (porSimbolo.get(s) ?? 0) + 1);
  }
  for (const [s, n] of [...porSimbolo].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${s.padEnd(28)} ${n} fichero(s)`);
  }
  console.log('\n  Ficheros:');
  for (const p of pendientes.slice(0, 20)) {
    console.log(`   ${path.relative(SRC, p.fichero).padEnd(58)} ${p.sinClasificar.join(', ')}`);
  }
  if (pendientes.length > 20) console.log(`   ... y ${pendientes.length - 20} más`);
}
