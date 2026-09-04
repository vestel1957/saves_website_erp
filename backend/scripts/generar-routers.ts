/**
 * Genera un router de Express por cada controlador de Nest.
 *
 * Son 616 endpoints. A mano, la errata es estadísticamente segura: un `:id` mal
 * escrito, un `@RequireArea` que se cae, dos parámetros intercambiados. Todas esas
 * compilan. Aquí se derivan del contrato ya extraído y verificado contra el Nest
 * vivo, que es la única fuente fiable de qué expone la API hoy.
 *
 * QUÉ NO SE TOCA: las clases de controlador siguen siendo clases (sin decoradores) y
 * los 616 cuerpos de handler se quedan exactamente como están. El router sólo hace
 * de cableado: extrae los argumentos de `req` y llama al método. Así el cambio de
 * framework no se mezcla con cambios de lógica de negocio.
 *
 * El fichero generado se versiona como código normal — no se regenera en cada
 * arranque. Se pone AL LADO de su controlador para que los imports relativos del
 * original (DTOs, enums, catálogos de permisos) sigan siendo válidos sin tocarlos.
 *
 * Lo que no sepa generar con certeza, lo deja marcado y lo reporta. Un TODO visible
 * es infinitamente mejor que una ruta silenciosamente mal cableada.
 *
 * Uso:
 *   npx ts-node --transpile-only scripts/generar-routers.ts            # informe
 *   npx ts-node --transpile-only scripts/generar-routers.ts --escribir
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import type { Endpoint, Parametro } from './extraer-contrato-http';

const RAIZ = path.join(__dirname, '..');
const SRC = path.join(RAIZ, 'src');
const CONTRATO = path.join(RAIZ, 'contrato-http.json');
const ESCRIBIR = process.argv.includes('--escribir');

const endpoints: Endpoint[] = JSON.parse(fs.readFileSync(CONTRATO, 'utf8'));

/** Tipos que NO son un DTO validable aunque vengan por `@Body()`/`@Query()`. */
const NO_VALIDABLES = new Set(['any', 'unknown', 'string', 'number', 'boolean', 'object', 'AuthUser']);

/**
 * Índice de TODAS las clases declaradas en el proyecto.
 *
 * Hace falta porque `class-validator` sólo puede validar contra una CLASE: los
 * decoradores viven en su prototipo. Un `interface CreateApiKeyDto` o un
 * `type X = {...}` desaparecen al compilar. Nest se comportaba igual —el
 * ValidationPipe dejaba pasar sin validar lo que no fuera una clase—, así que
 * comprobarlo aquí no endurece nada: replica lo que ya ocurría.
 */
const CLASES_DEL_PROYECTO: Set<string> = (() => {
  const nombres = new Set<string>();
  const recorrer = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.name.endsWith('.ts')) {
        const sf = ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true);
        sf.forEachChild((n) => {
          if (ts.isClassDeclaration(n) && n.name) nombres.add(n.name.text);
        });
      }
    }
  };
  recorrer(SRC);
  return nombres;
})();

/** ¿Es el nombre de una clase DTO contra la que se puede validar? */
function esDto(tipo: string | null): boolean {
  if (!tipo) return false;
  const limpio = tipo.trim();
  if (NO_VALIDABLES.has(limpio)) return false;
  // Un tipo inline (`{ to: string }`) o una unión no es una clase.
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(limpio)) return false;
  return CLASES_DEL_PROYECTO.has(limpio);
}

/**
 * Acceso a una clave de `req.query`/`req.params`.
 *
 * Con corchetes cuando la clave no es un identificador válido. El caso vivo es el
 * webhook de WhatsApp: `@Query('hub.mode')` significa la clave literal "hub.mode"
 * —`qs` no parte por puntos salvo que se le active `allowDots`—, así que generar
 * `req.query.hub.mode` buscaría un objeto `hub` que no existe. Meta dejaría de poder
 * verificar el webhook y los mensajes entrantes se caerían en silencio.
 */
function acceso(llave: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(llave) ? `.${llave}` : `[${JSON.stringify(llave)}]`;
}

/** Expresión que produce el argumento de un parámetro del handler. */
function expresionDe(p: Parametro, avisos: string[], ruta: string): string {
  switch (p.clase) {
    case 'Param':
      return p.llave ? `req.params${acceso(p.llave)}` : 'req.params';

    case 'Query':
      if (!p.llave) {
        // Sin clave se pasa la query entera. `ParsedQs` no encaja con los
        // `Record<string, string>` que declaran los handlers, así que se castea al
        // tipo que el handler ya esperaba.
        return esDto(p.tipo)
          ? `validarQuery(${p.tipo}, req.query)`
          : `req.query as unknown as ${p.tipo ?? 'Record<string, string>'}`;
      }
      // En la query todo llega como string; el tipo declarado en el handler es lo
      // que Nest conseguía con la conversión implícita. Se castea para no cambiar la
      // firma de 426 parámetros, que es donde se rompería algo de verdad.
      return `req.query${acceso(p.llave)} as ${p.tipo ?? 'string | undefined'}`;

    case 'Body':
      if (p.llave) return `req.body?.${p.llave}`;
      if (esDto(p.tipo)) return `validar(${p.tipo}, req.body)`;
      avisos.push(`${ruta}: @Body() sin DTO validable (tipo ${p.tipo ?? '?'}) -> pasa req.body crudo`);
      return 'req.body';

    case 'CurrentUser':
      return 'usuarioDe(req)';
    case 'CurrentSubscriber':
      return 'abonadoDe(req)';
    case 'Res':
      return 'res';
    case 'Req':
      return 'req';
    case 'Ip':
      // `string | undefined` en los tipos de Express, pero con `trust proxy` activo
      // siempre viene informado; los handlers lo declaran `string`.
      return 'req.ip as string';
    case 'UploadedFile':
      return 'ficheroDe(req)';

    default:
      avisos.push(`${ruta}: parámetro sin decorador conocido (${p.clase} ${p.nombre})`);
      return `undefined as never /* TODO: ${p.clase} ${p.nombre} */`;
  }
}

/** Middleware de la ruta, en el orden en que deben ejecutarse. */
function middlewaresDe(e: Endpoint): string[] {
  const lista: string[] = [];

  // 1. Autenticación primero: puebla req.user, que el resto necesita.
  if (e.guards.includes('JwtAuthGuard')) lista.push('autenticar');
  if (e.guards.includes('SubscriberAuthGuard')) lista.push('autenticarAbonado');
  if (e.guards.includes('LoginThrottleGuard')) lista.push('frenoDeLogin');
  if (e.guards.includes('ApiKeyGuard')) {
    // Los scopes viajan en el propio middleware, no en metadatos aparte.
    lista.push(e.scopesFuente.length ? `apiKeyCon(${e.scopesFuente.join(', ')})` : 'apiKey');
  }

  // 2. Autorización. Se emite el TEXTO FUENTE de cada decorador —con sus comillas si
  // las llevaba— porque conviven literales (`'system.admin'`) y expresiones
  // (`APP_PERMISSIONS.X`), y tratarlos igual rompe la comprobación de permisos.
  if (e.areasFuente.length) {
    lista.push(
      e.orPermissionFuente.length
        ? `exigirAreaCon({ areas: [${e.areasFuente.join(', ')}], orPermission: [${e.orPermissionFuente.join(', ')}] })`
        : `exigirArea(${e.areasFuente.join(', ')})`,
    );
  }
  if (e.permisosFuente.length) lista.push(`exigirPermisos(${e.permisosFuente.join(', ')})`);
  // Lista blanca del módulo de Red frente al técnico de campo: la marca se escribe
  // en la ruta (`abiertoAlTecnico`) en vez de omitir el middleware, para que se lea
  // que fue una decisión y no un olvido. Ver `core/auth/middlewares.ts`.
  if (e.guards.includes('ModuloRedGuard')) lista.push(e.abiertoAlTecnico ? 'abiertoAlTecnico' : 'moduloRed');

  return lista;
}

/** Ruta de Express relativa al prefijo del router: /api/plans/:id -> '/:id' */
function rutaRelativa(rutaCompleta: string, base: string): string {
  const sinPrefijo = rutaCompleta.replace(/^\/api\//, '');
  const resto = sinPrefijo.startsWith(base) ? sinPrefijo.slice(base.length) : sinPrefijo;
  const limpia = resto.replace(/^\/+/, '');
  return `/${limpia}`;
}

/**
 * Orden en que se registran las rutas dentro de un router.
 *
 * Express prueba las rutas EN EL ORDEN EN QUE SE REGISTRAN y se queda con la
 * primera que encaja: `/:id` acepta cualquier segmento, así que si se registra
 * antes que `/stats`, la petición a `/stats` acaba en el manejador del detalle
 * con `id = 'stats'`. Compila, arranca y devuelve 404 "no encontrado" en
 * producción — que es justo lo que pasó con `/tasks/assignees` y otros 21
 * endpoints: el orden aquí era `localeCompare` a secas y ':' (0x3A) va antes
 * que cualquier letra, así que TODOS los literales quedaban tapados.
 *
 * Nest no tenía el problema porque respetaba el orden de los decoradores en el
 * controlador, donde los literales ya estaban escritos arriba.
 *
 * Se ordena por especificidad, segmento a segmento: lo literal antes que lo
 * paramétrico, y entre iguales alfabético para que el fichero generado sea
 * estable entre corridas.
 */
function porEspecificidad(a: { ruta: string }, b: { ruta: string }): number {
  const sa = a.ruta.split('/');
  const sb = b.ruta.split('/');
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    const paramA = sa[i].startsWith(':');
    const paramB = sb[i].startsWith(':');
    if (paramA !== paramB) return paramA ? 1 : -1; // el literal, primero
    if (sa[i] !== sb[i]) return sa[i].localeCompare(sb[i]);
  }
  return sa.length - sb.length;
}

// ---------------------------------------------------------------------------
// Imports del controlador que hay que arrastrar al router
// ---------------------------------------------------------------------------
const OMITIR_IMPORT = [
  '@nestjs/common',
  '@nestjs/core',
  '@nestjs/platform-express',
  '@nestjs/event-emitter',
  '@nestjs/schedule',
  '.guard',
  'require-area.decorator',
  'require-permissions.decorator',
  'current-user.decorator',
];

/** Mapa "fichero#Clase" -> constante del contenedor, que emite generar-contenedor. */
const MAPA_CONTENEDOR: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(RAIZ, 'contenedor-mapa.json'), 'utf8'),
);

function resolverImport(desdeFichero: string, especificador: string): string | null {
  if (!especificador.startsWith('.')) return null;
  const base = path.resolve(path.dirname(desdeFichero), especificador);
  for (const candidato of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidato)) return candidato;
  }
  return null;
}

/**
 * Dependencias del constructor del controlador, resueltas a constantes del
 * contenedor. Se resuelve por la RUTA del import y no por el nombre de la clase, por
 * lo mismo que en el contenedor: hay dos `ReportsService` y elegir la equivocada no
 * rompe nada visible, sólo devuelve datos de otro módulo.
 */
function dependenciasDelControlador(
  ficheroControlador: string,
  nombreClase: string,
  avisos: string[],
): { args: string[]; variables: string[] } {
  const texto = fs.readFileSync(ficheroControlador, 'utf8');
  const sf = ts.createSourceFile(ficheroControlador, texto, ts.ScriptTarget.Latest, true);

  const importes = new Map<string, string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s)) continue;
    const destino = resolverImport(ficheroControlador, (s.moduleSpecifier as ts.StringLiteral).text);
    if (!destino) continue;
    const enlaces = s.importClause?.namedBindings;
    if (enlaces && ts.isNamedImports(enlaces)) {
      for (const el of enlaces.elements) importes.set(el.name.text, destino);
    }
  }

  const args: string[] = [];
  const variables: string[] = [];

  sf.forEachChild((nodo) => {
    if (!ts.isClassDeclaration(nodo) || nodo.name?.text !== nombreClase) return;
    const ctor = nodo.members.find(ts.isConstructorDeclaration);
    for (const p of ctor?.parameters ?? []) {
      const tipo = (p.type?.getText() ?? '').replace(/<.*>$/, '').trim();
      const destino = importes.get(tipo);
      const clave = destino ? `${path.relative(RAIZ, destino)}#${tipo}` : '';
      const variable = MAPA_CONTENEDOR[clave];
      if (variable) {
        args.push(variable);
        variables.push(variable);
      } else {
        avisos.push(`${nombreClase}: no se resolvió la dependencia ${tipo} (${clave || 'sin import'})`);
        args.push(`undefined as never /* TODO: ${tipo} */`);
      }
    }
  });

  return { args, variables };
}

/**
 * Clases exportadas por el propio fichero del controlador (DTOs declarados ahí
 * mismo, no en `dto/`). El router las necesita para validar, y como no vienen por
 * un import no se pueden copiar: hay que traerlas del controlador explícitamente.
 */
function clasesExportadasEn(ficheroControlador: string): Set<string> {
  const texto = fs.readFileSync(ficheroControlador, 'utf8');
  const sf = ts.createSourceFile(ficheroControlador, texto, ts.ScriptTarget.Latest, true);
  const salida = new Set<string>();
  sf.forEachChild((n) => {
    // Se recogen exportadas y no exportadas: varios controladores declaran sus DTO y
    // sus constantes de áreas sin `export` porque sólo los usaba el propio fichero.
    // Ahora el router los necesita (`exportar-dtos-de-controladores.ts` los exporta).
    if (ts.isClassDeclaration(n) && n.name) salida.add(n.name.text);
    if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) salida.add(d.name.text);
      }
    }
  });
  return salida;
}

/** Palabras que no pueden ser nombre de variable en modo estricto. */
const RESERVADAS = new Set([
  'public', 'private', 'protected', 'static', 'package', 'interface',
  'implements', 'let', 'yield', 'default', 'class', 'new', 'delete',
]);

function importsDelControlador(ficheroControlador: string): string[] {
  const texto = fs.readFileSync(ficheroControlador, 'utf8');
  const sf = ts.createSourceFile(ficheroControlador, texto, ts.ScriptTarget.Latest, true);
  const salida: string[] = [];
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s)) continue;
    const desde = (s.moduleSpecifier as ts.StringLiteral).text;
    if (OMITIR_IMPORT.some((o) => desde.includes(o))) continue;
    salida.push(s.getText(sf));
  }
  return salida;
}

// ---------------------------------------------------------------------------
// Generación
// ---------------------------------------------------------------------------
const porControlador = new Map<string, Endpoint[]>();
for (const e of endpoints) {
  if (!porControlador.has(e.controlador)) porControlador.set(e.controlador, []);
  porControlador.get(e.controlador)!.push(e);
}

const avisosGlobales: string[] = [];
/** Routers generados, para construir el índice de rutas al final. */
const indice: Array<{ varRouter: string; prefijo: string; fichero: string }> = [];

/**
 * Routers ESCRITOS A MANO que también van al índice.
 *
 * El índice se reescribe entero en cada corrida a partir del contrato, así que
 * un módulo nacido después del port (que por definición no está en
 * `contrato-http.json`) desaparecía de `rutas.ts` al regenerar y sus endpoints
 * devolvían 404 aunque el router existiera. Se apuntan aquí para que
 * sobrevivan.
 */
const A_MANO: Array<{ varRouter: string; prefijo: string; fichero: string }> = [
  { varRouter: 'bundlesRouter', prefijo: 'plan-bundles', fichero: 'src/plans/bundles.router.ts' },
];
let generados = 0;
let rutasGeneradas = 0;

for (const [controlador, lista] of porControlador) {
  const ficheroControlador = path.join(RAIZ, lista[0].fichero);
  if (!fs.existsSync(ficheroControlador)) {
    avisosGlobales.push(`No existe ${lista[0].fichero}`);
    continue;
  }

  const avisos: string[] = [];
  // Prefijo del router: el trozo común de @Controller('x').
  const base = lista[0].ruta.replace(/^\/api\//, '').split('/')[0];
  const nombreVar = controlador.replace(/Controller$/, '');
  const enMinuscula = nombreVar.charAt(0).toLowerCase() + nombreVar.slice(1);
  const varRouter = `${enMinuscula}Router`;
  // `PublicController` daría la variable `public`, que es palabra reservada en modo
  // estricto y no compila. En ese caso se usa el nombre largo.
  const varControlador = RESERVADAS.has(enMinuscula) ? `${enMinuscula}Controlador` : enMinuscula;

  const usados = {
    validar: false,
    validarQuery: false,
    usuarioDe: false,
    abonadoDe: false,
    ficheroDe: false,
    frenoDeLogin: false,
    apiKey: false,
    apiKeyCon: false,
    subida: false,
  };

  const lineas: string[] = [];
  for (const e of lista.sort(porEspecificidad)) {
    const mws = middlewaresDe(e);
    const args = e.parametros.map((p) => expresionDe(p, avisos, `${e.metodo} ${e.ruta}`));

    if (args.some((a) => a.includes('validarQuery('))) usados.validarQuery = true;
    if (args.some((a) => a.startsWith('validar('))) usados.validar = true;
    if (args.includes('usuarioDe(req)')) usados.usuarioDe = true;
    if (args.includes('abonadoDe(req)')) usados.abonadoDe = true;
    if (args.includes('ficheroDe(req)')) usados.ficheroDe = true;
    if (mws.includes('frenoDeLogin')) usados.frenoDeLogin = true;
    if (mws.includes('apiKey')) usados.apiKey = true;
    if (mws.some((m) => m.startsWith('apiKeyCon('))) usados.apiKeyCon = true;

    // Subidas: las opciones de multer se trasladan tal cual desde el decorador.
    const middlewareSubida: string[] = [];
    if (e.subeFichero) {
      usados.subida = true;
      if (e.subidaFuente) {
        middlewareSubida.push(`subirUno(${e.subidaFuente})`);
      } else {
        avisos.push(`${e.metodo} ${e.ruta}: sube fichero y no se pudieron leer las opciones de multer`);
      }
    }

    // El handler recibe (req, res) y devuelve; `manejar` serializa lo devuelto salvo
    // que el handler ya haya escrito (streams, PDFs, Excel).
    const necesitaRes = args.includes('res') || args.includes('req');
    const firma = necesitaRes ? '(req, res)' : '(req)';
    const llamada = `${varControlador}.${e.handler}(${args.join(', ')})`;

    const partes = [
      `'${rutaRelativa(e.ruta, base)}'`,
      ...mws,
      ...middlewareSubida,
      `manejar(${firma} => ${llamada})`,
    ];
    lineas.push(`${varRouter}.${e.metodo.toLowerCase()}(\n  ${partes.join(',\n  ')},\n);`);
    rutasGeneradas++;
  }

  // Imports del núcleo, sólo los que se usan.
  const deRuta = ['crearRouter', 'manejar'];
  const deValidar = [
    ...(usados.validar ? ['validar'] : []),
    ...(usados.validarQuery ? ['validarQuery'] : []),
  ];
  const deAuth = [
    ...(lista.some((e) => e.guards.includes('JwtAuthGuard')) ? ['autenticar'] : []),
    ...(lista.some((e) => e.guards.includes('SubscriberAuthGuard')) ? ['autenticarAbonado'] : []),
    ...(lista.some((e) => e.areas.length && !e.orPermission.length) ? ['exigirArea'] : []),
    ...(lista.some((e) => e.areas.length && e.orPermission.length) ? ['exigirAreaCon'] : []),
    ...(lista.some((e) => e.permisos.length) ? ['exigirPermisos'] : []),
    ...(lista.some((e) => e.guards.includes('ModuloRedGuard') && !e.abiertoAlTecnico) ? ['moduloRed'] : []),
    ...(lista.some((e) => e.guards.includes('ModuloRedGuard') && e.abiertoAlTecnico) ? ['abiertoAlTecnico'] : []),
    ...(usados.usuarioDe ? ['usuarioDe'] : []),
    ...(usados.abonadoDe ? ['abonadoDe'] : []),
    ...(usados.frenoDeLogin ? ['crearFrenoDeLogin'] : []),
    ...(usados.apiKey ? ['apiKey'] : []),
    ...(usados.apiKeyCon ? ['apiKeyCon'] : []),
  ];

  const rel = (destino: string) => {
    const r = path
      .relative(path.dirname(ficheroControlador), path.join(SRC, destino))
      .split(path.sep)
      .join('/');
    return r.startsWith('.') ? r : `./${r}`;
  };

  const deps = dependenciasDelControlador(ficheroControlador, controlador, avisos);

  // DTOs declarados dentro del propio controlador y usados por las rutas generadas.
  const cuerpoGenerado = lineas.join('\n');
  const dtosLocales = [...clasesExportadasEn(ficheroControlador)]
    .filter((c) => c !== controlador)
    .filter((c) => new RegExp(`\\b${c}\\b`).test(cuerpoGenerado))
    .sort();

  const importContenedor = deps.variables.length
    ? `import { ${[...new Set(deps.variables)].sort().join(', ')} } from '${rel('core/contenedor')}';`
    : '';
  // El controlador vive en el fichero de al lado: se importa por su nombre de fichero.
  const nombreFicheroCtrl = path.basename(ficheroControlador, '.ts');

  const cabecera = [
    `/**`,
    ` * Rutas de ${base} — ── FICHERO GENERADO ──`,
    ` *`,
    ` * Lo genera \`scripts/generar-routers.ts\` desde el contrato extraído del`,
    ` * controlador. Cablea HTTP -> método: extrae los argumentos de \`req\` y llama.`,
    ` * La lógica sigue viviendo en ${controlador}, que ya no lleva decoradores.`,
    ` *`,
    ` * Endpoints: ${lista.length}`,
    ` */`,
    `import { crearRouter, manejar } from '${rel('core/http/ruta')}';`,
    ...(deValidar.length ? [`import { ${deValidar.join(', ')} } from '${rel('core/http/validar')}';`] : []),
    ...(deAuth.length ? [`import { ${deAuth.join(', ')} } from '${rel('core/auth/instancias')}';`] : []),
    ...(usados.ficheroDe || usados.subida
      ? [`import { ${[usados.ficheroDe ? 'ficheroDe' : '', usados.subida ? 'subirUno' : ''].filter(Boolean).join(', ')} } from '${rel('core/http/uploads')}';`]
      : []),
    `import { ${[controlador, ...dtosLocales].join(', ')} } from './${nombreFicheroCtrl}';`,
    ...(importContenedor ? [importContenedor] : []),
    ...importsDelControlador(ficheroControlador).map((imp) => {
      // `import type { X }` no sirve si el router usa X como VALOR en `validar(X, ...)`.
      // Se degrada a import normal sólo en ese caso, para no tocar los demás.
      if (!imp.startsWith('import type ')) return imp;
      const usaComoValor = [...imp.matchAll(/[{,]\s*([A-Za-z0-9_]+)/g)].some((m) =>
        new RegExp(`valid(ar|arQuery)\\(${m[1]}\\b`).test(cuerpoGenerado),
      );
      return usaComoValor ? imp.replace(/^import type /, 'import ') : imp;
    }),
    ``,
    ...(usados.frenoDeLogin
      ? [`/** Freno propio de este router: su contador no se comparte con otros logins. */`,
         `const frenoDeLogin = crearFrenoDeLogin();`, ``]
      : []),
    `/** Instancia única del controlador. Las dependencias salen del contenedor. */`,
    `const ${varControlador} = new ${controlador}(${deps.args.join(', ')});`,
    ``,
    `export const ${varRouter} = crearRouter();`,
    ``,
  ].join('\n');

  const contenido = cabecera + lineas.join('\n\n') + '\n';
  // Un fichero puede declarar DOS controladores (promotions tiene el de gestión y el
  // del abonado). Nombrar el router sólo por el fichero hacía que el segundo pisara
  // al primero y sus rutas desaparecían sin que nada fallara al compilar: el índice
  // de rutas simplemente importaba un router que no existía.
  const variosEnElFichero =
    [...porControlador.keys()].filter(
      (c) => porControlador.get(c)![0].fichero === lista[0].fichero,
    ).length > 1;
  const destino = variosEnElFichero
    ? path.join(path.dirname(ficheroControlador), `${nombreVar.toLowerCase()}.router.ts`)
    : ficheroControlador.replace(/\.controller\.ts$/, '.router.ts');

  if (ESCRIBIR) fs.writeFileSync(destino, contenido);
  generados++;
  indice.push({ varRouter, prefijo: base, fichero: destino });
  for (const a of avisos) avisosGlobales.push(a);
}

// ---------------------------------------------------------------------------
// Índice de rutas: qué router atiende cada prefijo (sustituye a `app.module.ts`)
// ---------------------------------------------------------------------------
// Se genera AQUÍ y no en un script aparte a propósito: el nombre del fichero de cada
// router lo decide este generador (y no siempre coincide con el del controlador,
// porque un fichero puede declarar dos). Calcularlo por segunda vez en otro sitio es
// pedir que los dos cálculos se separen y que el índice importe un fichero que no
// existe — que es exactamente lo que pasó al hacerlo por separado.
if (ESCRIBIR) {
  const filas = [
    ...indice,
    ...A_MANO.map((r) => ({ ...r, fichero: path.join(RAIZ, r.fichero) })),
  ].sort(
    (a, b) => a.prefijo.localeCompare(b.prefijo) || a.varRouter.localeCompare(b.varRouter),
  );
  const rutaIndice = path.join(SRC, 'core', 'rutas.ts');
  const imports = filas
    .map((f) => {
      const r = path
        .relative(path.dirname(rutaIndice), f.fichero.replace(/\.ts$/, ''))
        .split(path.sep)
        .join('/');
      return `import { ${f.varRouter} } from '${r.startsWith('.') ? r : `./${r}`}';`;
    })
    .join('\n');

  const contenidoIndice = `/**
 * Índice de rutas: qué router atiende cada prefijo. ── FICHERO GENERADO ──
 *
 * Sustituye a la lista de módulos de \`app.module.ts\`. Aquí no se declaran
 * dependencias —de eso se encarga el contenedor—: sólo se dice qué se publica y bajo
 * qué prefijo, que es lo único que un módulo de Nest acababa aportando.
 *
 * Varios routers comparten prefijo a propósito (\`network\`, \`whatsapp\`, \`admin\`):
 * Express los prueba en orden y cada uno responde a las suyas.
 *
 * Routers: ${filas.length}
 */
${imports}

export const RUTAS = [
${filas.map((f) => `  { prefijo: '${f.prefijo}', router: ${f.varRouter} },`).join('\n')}
];
`;
  fs.writeFileSync(rutaIndice, contenidoIndice);
  console.log(`Índice de rutas: ${filas.length} routers -> src/core/rutas.ts`);
}

console.log(`${ESCRIBIR ? 'GENERADOS' : 'SIMULACRO'}: ${generados} routers · ${rutasGeneradas} rutas`);
if (avisosGlobales.length) {
  console.log(`\nRequieren repaso a mano (${avisosGlobales.length}):`);
  for (const a of avisosGlobales.slice(0, 40)) console.log(`   ${a}`);
  if (avisosGlobales.length > 40) console.log(`   ... y ${avisosGlobales.length - 40} más`);
}
