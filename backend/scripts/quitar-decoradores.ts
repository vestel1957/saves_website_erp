/**
 * Quita los decoradores de Nest de controladores y servicios.
 *
 * Es el último paso de la migración: para entonces, todo lo que esos decoradores
 * declaraban ya vive en otro sitio y de forma explícita —las rutas y sus guardas en
 * los routers generados, las suscripciones en `core/suscripciones.ts`, los horarios
 * en `core/tareas.ts`—. Aquí sólo se retira el andamio.
 *
 * Se trabaja con el AST y no con expresiones regulares porque estos decoradores
 * ocupan varias líneas y llevan objetos dentro (las opciones de multer, por ejemplo).
 * Un `sed` los cortaría por la mitad y el destrozo sería silencioso.
 *
 * Los CUERPOS de los métodos no se tocan: la lógica de negocio no entra en esta
 * migración.
 *
 * Uso:
 *   npx ts-node --transpile-only scripts/quitar-decoradores.ts
 *   npx ts-node --transpile-only scripts/quitar-decoradores.ts --aplicar
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC = path.join(__dirname, '..', 'src');
const APLICAR = process.argv.includes('--aplicar');

/** Decoradores que se retiran esté donde esté (clase, método o parámetro). */
const DECORADORES = new Set([
  // Rutas y HTTP
  'Controller', 'Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'HttpCode',
  // Guardas y metadatos de autorización
  'UseGuards', 'RequireArea', 'RequirePermissions', 'OrPermission', 'RequireScopes',
  'AbiertoAlTecnico', 'SetMetadata',
  // Parámetros
  'Body', 'Param', 'Query', 'Res', 'Req', 'Ip', 'Headers', 'Session',
  'CurrentUser', 'CurrentSubscriber', 'UploadedFile', 'UploadedFiles',
  // Interceptores y ciclo de vida del framework
  'UseInterceptors', 'Injectable', 'Global', 'Catch',
  // Eventos y planificación
  'OnEvent', 'Cron', 'Interval', 'Timeout',
]);

/** Símbolos que dejan de existir y hay que sacar de los imports. */
const IMPORTS_MUERTOS = new Set([
  ...DECORADORES,
  'FileInterceptor', 'FilesInterceptor', 'AnyFilesInterceptor',
  'JwtAuthGuard', 'AreaGuard', 'PermissionsGuard', 'LoginThrottleGuard',
  'ModuloRedGuard', 'SubscriberAuthGuard', 'ApiKeyGuard',
  'CronExpression', 'Reflector', 'CanActivate', 'ExecutionContext',
  'NestInterceptor', 'CallHandler', 'ArgumentsHost', 'ExceptionFilter',
  'ValidationPipe', 'createParamDecorator',
]);

/** Módulos cuyos imports se eliminan por completo si se quedan vacíos. */
const MODULOS_MUERTOS = [
  '@nestjs/common', '@nestjs/core', '@nestjs/platform-express',
  '@nestjs/event-emitter', '@nestjs/schedule', '@nestjs/throttler', '@nestjs/config',
];

function ficherosTs(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) ficherosTs(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

interface Corte {
  inicio: number;
  fin: number;
  texto: string;
}

let tocados = 0;
let decoradoresQuitados = 0;
const detalle: string[] = [];

for (const fichero of ficherosTs(SRC)) {
  if (fichero.includes(`${path.sep}core${path.sep}`)) continue;

  const original = fs.readFileSync(fichero, 'utf8');
  const sf = ts.createSourceFile(fichero, original, ts.ScriptTarget.Latest, true);
  const cortes: Corte[] = [];
  let quitadosAqui = 0;

  // --- 1. Decoradores -------------------------------------------------------
  const visitar = (nodo: ts.Node) => {
    if (ts.canHaveDecorators(nodo)) {
      for (const d of ts.getDecorators(nodo) ?? []) {
        const expr = d.expression;
        const nombre = ts.isCallExpression(expr) ? expr.expression.getText(sf) : expr.getText(sf);
        if (!DECORADORES.has(nombre)) continue;

        // Se come también el espacio en blanco que sigue, para no dejar sangrías
        // huérfanas ni líneas en blanco donde estaba el decorador.
        let fin = d.getEnd();
        while (fin < original.length && (original[fin] === ' ' || original[fin] === '\t')) fin++;
        if (original[fin] === '\r') fin++;
        if (original[fin] === '\n') {
          // Si el decorador ocupaba su línea entera, se borra la línea completa.
          const inicioLinea = original.lastIndexOf('\n', d.getStart(sf)) + 1;
          const soloEspacios = original.slice(inicioLinea, d.getStart(sf)).trim() === '';
          if (soloEspacios) {
            cortes.push({ inicio: inicioLinea, fin: fin + 1, texto: '' });
            quitadosAqui++;
            continue;
          }
        }
        cortes.push({ inicio: d.getStart(sf), fin, texto: '' });
        quitadosAqui++;
      }
    }
    nodo.forEachChild(visitar);
  };
  sf.forEachChild(visitar);

  // --- 2. Imports que se quedan sin sentido ---------------------------------
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s)) continue;
    const desde = (s.moduleSpecifier as ts.StringLiteral).text;
    const enlaces = s.importClause?.namedBindings;
    if (!enlaces || !ts.isNamedImports(enlaces)) continue;

    const esModuloMuerto = MODULOS_MUERTOS.some((m) => desde === m);
    const esFicheroBorrado =
      /\.guard'?$/.test(desde) ||
      desde.includes('require-area.decorator') ||
      desde.includes('require-permissions.decorator');

    const sobreviven = enlaces.elements.filter((el) => {
      const nombre = (el.propertyName ?? el.name).getText(sf);
      if (IMPORTS_MUERTOS.has(nombre)) return false;
      // De un módulo de Nest no sobrevive nada, aunque no esté en la lista.
      return !esModuloMuerto && !esFicheroBorrado;
    });

    if (sobreviven.length === enlaces.elements.length) continue;

    if (sobreviven.length === 0) {
      // Import entero fuera, incluida su línea.
      const inicioLinea = original.lastIndexOf('\n', s.getStart(sf)) + 1;
      let fin = s.getEnd();
      if (original[fin] === '\r') fin++;
      if (original[fin] === '\n') fin++;
      cortes.push({ inicio: inicioLinea, fin, texto: '' });
    } else {
      const tipo = s.importClause?.isTypeOnly ? 'import type' : 'import';
      cortes.push({
        inicio: s.getStart(sf),
        fin: s.getEnd(),
        texto: `${tipo} { ${sobreviven.map((e) => e.getText(sf)).join(', ')} } from '${desde}';`,
      });
    }
  }

  if (!cortes.length) continue;

  let salida = original;
  for (const c of cortes.sort((a, b) => b.inicio - a.inicio)) {
    salida = salida.slice(0, c.inicio) + c.texto + salida.slice(c.fin);
  }

  tocados++;
  decoradoresQuitados += quitadosAqui;
  detalle.push(`${path.relative(SRC, fichero).padEnd(56)} ${quitadosAqui} decorador(es)`);
  if (APLICAR) fs.writeFileSync(fichero, salida);
}

console.log(
  `${APLICAR ? 'APLICADO' : 'SIMULACRO'}: ${decoradoresQuitados} decoradores en ${tocados} ficheros\n`,
);
for (const d of detalle.slice(0, 25)) console.log(`   ${d}`);
if (detalle.length > 25) console.log(`   ... y ${detalle.length - 25} ficheros más`);
