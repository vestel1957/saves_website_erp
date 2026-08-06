/**
 * Extrae el CONTRATO HTTP completo del backend NestJS.
 *
 * Existe por la migración a Express: el corte es todo-o-nada y no hay ni un solo
 * test de HTTP en el proyecto (los 34 specs son de lógica pura). Sin una lista
 * exacta de qué expone hoy la API, "ya está migrado" no se puede comprobar: 617
 * endpoints no se revisan a ojo.
 *
 * Lee los controladores con la API del compilador de TypeScript —no con regex,
 * que se traga los decoradores multilínea— y emite por cada endpoint: método,
 * ruta completa, guards, áreas, permisos, DTO del cuerpo, params y query.
 *
 * Uso:
 *   npx ts-node --transpile-only scripts/extraer-contrato-http.ts        # tabla
 *   npx ts-node --transpile-only scripts/extraer-contrato-http.ts --json # a fichero
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

// `SRC_CONTRATO` permite apuntar a otro árbol de fuentes. Se usa para reconstruir el
// contrato desde una copia anterior a la migración: una vez quitados los decoradores,
// el código migrado ya no tiene `@Controller` que leer — este script sólo entiende el
// código de Nest, y ese es justamente su cometido.
const SRC = process.env.SRC_CONTRATO
  ? path.resolve(process.env.SRC_CONTRATO)
  : path.join(__dirname, '..', 'src');
const SALIDA = path.join(__dirname, '..', 'contrato-http.json');

const METODOS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options'] as const;

export interface Parametro {
  /** Decorador que lo alimenta: Param, Query, Body, CurrentUser, Res, Req, Ip,
   *  UploadedFile, CurrentSubscriber… o 'ninguno' si no lleva. */
  clase: string;
  /** Argumento del decorador: `@Param('id')` -> "id". Vacío si es `@Body()`. */
  llave: string | null;
  /** Tipo declarado del parámetro, para saber si hay que validar contra un DTO. */
  tipo: string | null;
  /** Nombre del parámetro en la firma (sólo informativo, para los comentarios). */
  nombre: string;
}

export interface Endpoint {
  metodo: string;
  ruta: string;
  controlador: string;
  fichero: string;
  handler: string;
  guards: string[];
  areas: string[];
  permisos: string[];
  orPermission: string[];
  /** Los mismos, con el texto fuente exacto (comillas incluidas). Es lo que se emite
   *  al generar; los de arriba son para leer el informe. */
  areasFuente: string[];
  permisosFuente: string[];
  orPermissionFuente: string[];
  /** Scopes de `@RequireScopes` para las rutas de la API pública por clave. */
  scopesFuente: string[];
  /** Nombre de la clase DTO del @Body(), si la hay. */
  dto: string | null;
  params: string[];
  query: string[];
  /**
   * Parámetros del handler EN ORDEN, con su decorador y su tipo. Es lo que permite
   * generar la llamada: sin el orden no se sabe si el handler espera (id, dto) o
   * (dto, id), y equivocarse ahí compila igual de bien.
   */
  parametros: Parametro[];
  /** El handler escribe en la respuesta a mano (@Res): PDFs, Excel, streams. */
  usaRes: boolean;
  /** Sube fichero con Multer (@UseInterceptors(FileInterceptor)). */
  subeFichero: boolean;
  /**
   * Argumentos de `FileInterceptor(...)` tal cual están escritos: el nombre del campo
   * y el objeto de opciones (diskStorage, límites, fileFilter). Se capturan porque
   * viven DENTRO del decorador: al quitarlo se perderían, y con ellos la validación
   * de MIME y el tope de tamaño de los adjuntos.
   */
  subidaFuente: string | null;
  /** @HttpCode(xxx) explícito. */
  httpCode: number | null;
  publico: boolean;
}

/** Ficheros .ts bajo src/, recursivo. */
function ficherosTs(dir: string, acc: string[] = []): string[] {
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entrada.name);
    if (entrada.isDirectory()) ficherosTs(p, acc);
    else if (entrada.name.endsWith('.ts') && !entrada.name.endsWith('.spec.ts')) acc.push(p);
  }
  return acc;
}

function decoradores(nodo: ts.Node): ts.Decorator[] {
  return (ts.canHaveDecorators(nodo) ? ts.getDecorators(nodo) : undefined)?.slice() ?? [];
}

/** Nombre del decorador: @Get('x') -> "Get", @Get -> "Get". */
function nombreDecorador(dec: ts.Decorator): string {
  const e = dec.expression;
  if (ts.isCallExpression(e)) return e.expression.getText();
  return e.getText();
}

/** Argumentos literales de un decorador, ya desenvueltos de sus comillas. */
function argsLiteral(dec: ts.Decorator): string[] {
  const e = dec.expression;
  if (!ts.isCallExpression(e)) return [];
  return e.arguments.map((a) =>
    ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) ? a.text : a.getText(),
  );
}

/**
 * Argumentos TAL CUAL están escritos en el código, con sus comillas si las llevan.
 *
 * Hace falta además de `argsLiteral` porque los permisos se declaran de dos formas:
 * `@RequirePermissions('system.admin')` (literal) y
 * `@RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)` (expresión). Al generar hay
 * que emitir cada una como estaba: desenvolver el literal produce
 * `exigirPermisos(system.admin)` —un identificador inexistente— y poner comillas a la
 * expresión produce la cadena literal "APP_PERMISSIONS.X", que no coincide con ningún
 * permiso concedido. Lo primero no compila; lo segundo compila y deja la ruta
 * comprobando un permiso que nadie tiene jamás.
 */
function argsFuente(dec: ts.Decorator): string[] {
  const e = dec.expression;
  if (!ts.isCallExpression(e)) return [];
  return e.arguments.map((a) => a.getText());
}

function buscarDecorador(nodo: ts.Node, nombre: string): ts.Decorator | undefined {
  return decoradores(nodo).find((d) => nombreDecorador(d) === nombre);
}

/** Une prefijo de clase y ruta de método en una ruta limpia: /api/plans/:id */
function unirRuta(base: string, sufijo: string): string {
  const trozos = [base, sufijo]
    .filter((t) => t !== undefined && t !== null && t !== '')
    .join('/')
    .split('/')
    .filter(Boolean)
    // :id de Express en vez de :id de Nest (coinciden, pero normalizamos)
    .map((t) => t.trim());
  return '/api/' + trozos.join('/');
}

const endpoints: Endpoint[] = [];
const ficheros = ficherosTs(SRC);

for (const fichero of ficheros) {
  const código = fs.readFileSync(fichero, 'utf8');
  if (!código.includes('@Controller')) continue;

  const sf = ts.createSourceFile(fichero, código, ts.ScriptTarget.Latest, true);
  // SIEMPRE relativo a `src/` del proyecto, aunque se esté leyendo otro árbol con
  // SRC_CONTRATO. Si aquí se colara la ruta del árbol de origen, quien consume el
  // contrato (el generador de routers) escribiría los ficheros AHÍ en vez de en el
  // proyecto — y lo haría sin quejarse, que es lo peor de todo.
  const rel = path.join('src', path.relative(SRC, fichero));

  sf.forEachChild((nodo) => {
    if (!ts.isClassDeclaration(nodo) || !nodo.name) return;
    const decControlador = buscarDecorador(nodo, 'Controller');
    if (!decControlador) return;

    const base = argsLiteral(decControlador)[0] ?? '';
    const guardsClase = buscarDecorador(nodo, 'UseGuards');
    const áreasClase = buscarDecorador(nodo, 'RequireArea');
    const permisosClase = buscarDecorador(nodo, 'RequirePermissions');
    const orPermClase = buscarDecorador(nodo, 'OrPermission');

    for (const miembro of nodo.members) {
      if (!ts.isMethodDeclaration(miembro) || !miembro.name) continue;

      for (const decorador of decoradores(miembro)) {
        const nombre = nombreDecorador(decorador);
        if (!METODOS.includes(nombre as (typeof METODOS)[number])) continue;

        const sufijo = argsLiteral(decorador)[0] ?? '';

        // Los decoradores de método MANDAN sobre los de clase (semántica de
        // getAllAndOverride del Reflector: handler primero, luego clase).
        const áreasMétodo = buscarDecorador(miembro, 'RequireArea');
        const permisosMétodo = buscarDecorador(miembro, 'RequirePermissions');
        const orPermMétodo = buscarDecorador(miembro, 'OrPermission');
        const guardsMétodo = buscarDecorador(miembro, 'UseGuards');
        const httpCode = buscarDecorador(miembro, 'HttpCode');

        // Parámetros del handler: @Param('id'), @Query('x'), @Body() dto: Dto
        const params: string[] = [];
        const query: string[] = [];
        const parametros: Parametro[] = [];
        let dto: string | null = null;
        let usaRes = false;

        for (const p of miembro.parameters) {
          const decs = decoradores(p);
          const tipo = p.type?.getText() ?? null;
          const nombre = p.name.getText();

          if (decs.length === 0) {
            parametros.push({ clase: 'ninguno', llave: null, tipo, nombre });
            continue;
          }

          for (const dp of decs) {
            const n = nombreDecorador(dp);
            const arg = argsLiteral(dp)[0] ?? null;
            parametros.push({ clase: n, llave: arg, tipo, nombre });

            if (n === 'Param') params.push(arg ?? '(objeto)');
            else if (n === 'Query') query.push(arg ?? '(objeto)');
            else if (n === 'Res') usaRes = true;
            else if (n === 'Body') {
              if (tipo && !arg) dto = tipo;
              else if (arg) dto = `${tipo ?? 'any'} (campo "${arg}")`;
            }
          }
        }

        const interceptores = buscarDecorador(miembro, 'UseInterceptors');
        const textoInterceptores = interceptores?.getText() ?? '';

        // Ojo: se acumulan los guards de CLASE y de MÉTODO. @UseGuards no
        // sobreescribe como los metadatos de área/permisos — Nest ejecuta los dos
        // niveles. Tratarlo como override dejaría rutas sin autenticar.
        const guardsTexto = [guardsClase?.getText(), guardsMétodo?.getText()]
          .filter(Boolean)
          .join(' ');
        const guards = [
          ...new Set(
            [...guardsTexto.matchAll(/([A-Z][A-Za-z]*Guard)\b/g)]
              .map((m) => m[1])
              // 'UseGuards' contiene 'UseGuard': no es un guard, es el decorador.
              .filter((g) => g !== 'UseGuard'),
          ),
        ];

        endpoints.push({
          metodo: nombre.toUpperCase(),
          ruta: unirRuta(base, sufijo),
          controlador: nodo.name!.getText(),
          fichero: rel,
          handler: miembro.name.getText(),
          guards,
          areas: (áreasMétodo ?? áreasClase) ? argsLiteral((áreasMétodo ?? áreasClase)!) : [],
          permisos: (permisosMétodo ?? permisosClase)
            ? argsLiteral((permisosMétodo ?? permisosClase)!)
            : [],
          orPermission: (orPermMétodo ?? orPermClase)
            ? argsLiteral((orPermMétodo ?? orPermClase)!)
            : [],
          areasFuente: (áreasMétodo ?? áreasClase) ? argsFuente((áreasMétodo ?? áreasClase)!) : [],
          permisosFuente: (permisosMétodo ?? permisosClase)
            ? argsFuente((permisosMétodo ?? permisosClase)!)
            : [],
          orPermissionFuente: (orPermMétodo ?? orPermClase)
            ? argsFuente((orPermMétodo ?? orPermClase)!)
            : [],
          scopesFuente: (() => {
            const dec = buscarDecorador(miembro, 'RequireScopes') ?? buscarDecorador(nodo, 'RequireScopes');
            return dec ? argsFuente(dec) : [];
          })(),
          dto,
          params,
          query,
          parametros,
          usaRes,
          subeFichero: /FileInterceptor|FilesInterceptor|AnyFilesInterceptor/.test(
            textoInterceptores,
          ),
          subidaFuente: (() => {
            // Se extraen los argumentos de FileInterceptor(...) equilibrando
            // paréntesis: el objeto de opciones lleva funciones dentro (destination,
            // filename, fileFilter) y una regex perezosa lo cortaría por la mitad.
            const i = textoInterceptores.indexOf('FileInterceptor(');
            if (i === -1) return null;
            let nivel = 0;
            const inicio = i + 'FileInterceptor('.length;
            for (let j = inicio; j < textoInterceptores.length; j++) {
              const c = textoInterceptores[j];
              if (c === '(') nivel++;
              else if (c === ')') {
                if (nivel === 0) return textoInterceptores.slice(inicio, j).trim();
                nivel--;
              }
            }
            return null;
          })(),
          httpCode: httpCode ? Number(argsLiteral(httpCode)[0]?.replace(/\D/g, '')) || null : null,
          // "Público" = nadie comprueba QUIÉN llama. Un LoginThrottleGuard sólo
          // frena el ritmo, no autentica: contar "tiene algún guard" como
          // protegido escondía las rutas abiertas de verdad.
          publico: !guards.some((g) =>
            ['JwtAuthGuard', 'ApiKeyGuard', 'SubscriberAuthGuard'].includes(g),
          ),
        });
      }
    }
  });
}

endpoints.sort((a, b) => a.ruta.localeCompare(b.ruta) || a.metodo.localeCompare(b.metodo));

if (process.argv.includes('--json')) {
  // Nunca sobrescribir el contrato con una lista vacía. Es la línea base contra la
  // que se valida la migración: perderla deja el corte sin red, y se pierde en
  // silencio —el script "termina bien"— si se ejecuta sobre el código ya migrado,
  // donde no queda ningún `@Controller` que encontrar.
  if (endpoints.length === 0) {
    console.error(
      'No se encontró ningún endpoint: no se sobrescribe el contrato.\n' +
        '¿Se está ejecutando sobre el código YA migrado? Usa SRC_CONTRATO=<ruta> para\n' +
        'apuntar a un árbol de fuentes con los controladores de Nest.',
    );
    process.exit(1);
  }
  fs.writeFileSync(SALIDA, JSON.stringify(endpoints, null, 2));
  console.log(`${endpoints.length} endpoints -> ${path.relative(process.cwd(), SALIDA)}`);
} else {
  const porControlador = new Map<string, Endpoint[]>();
  for (const e of endpoints) {
    if (!porControlador.has(e.controlador)) porControlador.set(e.controlador, []);
    porControlador.get(e.controlador)!.push(e);
  }
  for (const [ctrl, lista] of [...porControlador].sort()) {
    console.log(`\n${ctrl}  (${lista.length})  ${lista[0].fichero}`);
    for (const e of lista) {
      const marcas = [
        e.publico ? 'PÚBLICO' : '',
        e.usaRes ? 'stream' : '',
        e.subeFichero ? 'upload' : '',
        e.dto ? `dto:${e.dto}` : '',
        e.areas.length ? `área:${e.areas.join('|')}` : '',
        e.permisos.length ? `perm:${e.permisos.join('|')}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.log(`  ${e.metodo.padEnd(6)} ${e.ruta.padEnd(52)} ${marcas}`);
    }
  }
  console.log(`\nTOTAL: ${endpoints.length} endpoints en ${porControlador.size} controladores`);
}
