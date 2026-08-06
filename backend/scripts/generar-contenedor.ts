/**
 * Genera `src/core/contenedor.ts`: el cableado explícito de todos los servicios.
 *
 * Sustituye al contenedor de inyección de dependencias de Nest. Con 122 servicios y
 * 410 dependencias por constructor, escribirlo a mano es garantía de equivocarse en
 * el orden; y equivocarse en el orden aquí significa un `undefined` que no aparece al
 * arrancar sino la primera vez que alguien pulsa un botón.
 *
 * De dónde sale la verdad: de los propios `*.module.ts`. Sus listas de `providers`
 * declaran exactamente qué instancias existían con Nest, así que generar desde ahí
 * garantiza que no se queda ninguna fuera ni se inventa ninguna nueva. El resultado
 * es un fichero normal y corriente, que se lee y se versiona — no hay reflexión ni
 * descubrimiento en tiempo de ejecución.
 *
 * El grafo se ordena topológicamente: cada servicio se instancia después de aquello
 * que necesita. Si hubiera un ciclo, se reporta y NO se genera nada.
 *
 * Uso:
 *   npx ts-node --transpile-only scripts/generar-contenedor.ts          # informe
 *   npx ts-node --transpile-only scripts/generar-contenedor.ts --escribir
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const RAIZ = path.join(__dirname, '..');
const SRC = path.join(__dirname, '..', 'src');
const SALIDA = path.join(SRC, 'core', 'contenedor.ts');
const ESCRIBIR = process.argv.includes('--escribir');

/**
 * Dependencias que NO son servicios del proyecto y se resuelven a mano.
 * `EventEmitter2` pasa a ser nuestro bus; el resto desaparece con Nest.
 */
/**
 * Providers que NO entran al contenedor porque la migración los sustituye por otra
 * cosa. Los guards de Nest son ahora middleware de Express (`core/auth/middlewares`):
 * dejarlos aquí crearía instancias muertas, y una de ellas —`PermissionsGuard`—
 * pediría un `Reflector` que ya no existe.
 */
const SUSTITUIDOS = new Set([
  'JwtAuthGuard',
  'PermissionsGuard',
  'AreaGuard',
  'LoginThrottleGuard',
  'ApiKeyGuard',
  'ModuloRedGuard',
  'SubscriberAuthGuard',
  'AuditInterceptor',
  'AllExceptionsFilter',
]);

const EXTERNAS: Record<string, string | null> = {
  EventEmitter2: 'eventos',
  Reflector: null,
  ConfigService: null,
  ModuleRef: null,
  HttpService: null,
  SchedulerRegistry: null,
};

interface Clase {
  /** Identificador único: "ruta/relativa.ts#NombreClase".
   *
   *  NO basta el nombre de la clase. Hay dos `ReportsService` distintas —la de
   *  contabilidad y la de reportes— que con Nest convivían porque cada módulo tenía
   *  su propio ámbito. Un contenedor plano indexado por nombre cablearía la
   *  equivocada en uno de los dos sitios, y el síntoma sería un informe devolviendo
   *  cifras de contabilidad: nada peta, todo miente. */
  id: string;
  nombre: string;
  fichero: string;
  /** Ids de las dependencias, ya resueltas por la ruta del import. */
  deps: Array<{ tipo: string; id: string | null }>;
  /** Nombre de la constante exportada (único en todo el contenedor). */
  variable: string;
}

/** Resuelve el especificador de un import a una ruta de fichero real. */
function resolverImport(desdeFichero: string, especificador: string): string | null {
  if (!especificador.startsWith('.')) return null;
  const base = path.resolve(path.dirname(desdeFichero), especificador);
  for (const candidato of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidato)) return candidato;
  }
  return null;
}

/** Mapa "símbolo importado" -> "fichero donde vive", para un fichero dado. */
function importesDe(sf: ts.SourceFile, fichero: string): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s)) continue;
    const destino = resolverImport(fichero, (s.moduleSpecifier as ts.StringLiteral).text);
    if (!destino) continue;
    const enlaces = s.importClause?.namedBindings;
    if (enlaces && ts.isNamedImports(enlaces)) {
      for (const el of enlaces.elements) mapa.set(el.name.text, destino);
    }
  }
  return mapa;
}

function ficherosTs(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) ficherosTs(p, acc);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) acc.push(p);
  }
  return acc;
}

const ficheros = ficherosTs(SRC);

// ---------------------------------------------------------------------------
// 1. Qué providers declaraban los módulos (la lista de lo que debe existir)
// ---------------------------------------------------------------------------
/** Ids ("fichero#Clase") de los providers declarados por algún módulo. */
const declarados = new Set<string>();
const avisos: string[] = [];

for (const fichero of ficheros) {
  if (!fichero.endsWith('.module.ts')) continue;
  const texto = fs.readFileSync(fichero, 'utf8');
  const sf = ts.createSourceFile(fichero, texto, ts.ScriptTarget.Latest, true);
  // El módulo importa cada provider: esa ruta es la que dice CUÁL de las clases
  // homónimas se está declarando.
  const importes = importesDe(sf, fichero);

  const visitar = (nodo: ts.Node) => {
    if (
      ts.isPropertyAssignment(nodo) &&
      ts.isIdentifier(nodo.name) &&
      (nodo.name.text === 'providers' || nodo.name.text === 'controllers') &&
      ts.isArrayLiteralExpression(nodo.initializer)
    ) {
      for (const el of nodo.initializer.elements) {
        if (ts.isIdentifier(el)) {
          if (nodo.name.text !== 'providers') continue;
          const destino = importes.get(el.text);
          if (destino) declarados.add(`${destino}#${el.text}`);
          else avisos.push(`${path.relative(SRC, fichero)}: no se resolvió el import de ${el.text}`);
        } else {
          // Provider con useFactory/useValue/useClass: no se puede deducir. Se avisa
          // para cablearlo a mano en vez de generarlo mal.
          avisos.push(`${path.relative(SRC, fichero)}: provider no literal -> ${el.getText().slice(0, 60)}`);
        }
      }
    }
    nodo.forEachChild(visitar);
  };
  sf.forEachChild(visitar);
}

// ---------------------------------------------------------------------------
// 2. Constructor de cada clase declarada: de qué depende
// ---------------------------------------------------------------------------
const clases = new Map<string, Clase>();

for (const fichero of ficheros) {
  if (fichero.endsWith('.module.ts')) continue;
  const texto = fs.readFileSync(fichero, 'utf8');
  const sf = ts.createSourceFile(fichero, texto, ts.ScriptTarget.Latest, true);
  const importes = importesDe(sf, fichero);

  sf.forEachChild((nodo) => {
    if (!ts.isClassDeclaration(nodo) || !nodo.name) return;
    const nombre = nodo.name.text;
    const id = `${fichero}#${nombre}`;
    if (!declarados.has(id)) return;

    if (SUSTITUIDOS.has(nombre)) return;

    const ctor = nodo.members.find(ts.isConstructorDeclaration);
    const deps =
      ctor?.parameters.map((p) => {
        // `private readonly prisma: PrismaService` -> "PrismaService"
        const tipo = (p.type?.getText() ?? '').replace(/<.*>$/, '').trim();
        // La dependencia se resuelve por el import de ESTE fichero, que es lo único
        // que distingue una clase de otra homónima.
        const destino = importes.get(tipo);
        return { tipo, id: destino ? `${destino}#${tipo}` : null };
      }) ?? [];

    clases.set(id, { id, nombre, fichero, deps, variable: '' });
  });
}

// Nombre de la constante: PlansService -> plansService. Si dos clases comparten
// nombre, se antepone la carpeta (accountingReportsService) para que el fichero
// generado siga siendo legible y no haya colisión.
{
  const porNombre = new Map<string, Clase[]>();
  for (const c of clases.values()) {
    if (!porNombre.has(c.nombre)) porNombre.set(c.nombre, []);
    porNombre.get(c.nombre)!.push(c);
  }
  const bajaInicial = (n: string) => n.charAt(0).toLowerCase() + n.slice(1);
  for (const [nombre, lista] of porNombre) {
    if (lista.length === 1) {
      lista[0].variable = bajaInicial(nombre);
      continue;
    }
    for (const c of lista) {
      const carpeta = bajaInicial(path.basename(path.dirname(c.fichero)).replace(/[^a-zA-Z0-9]/g, ''));
      // Si la clase ya lleva el nombre de su carpeta (reports/ReportsService), anteponerla
      // otra vez daría "reportsReportsService". En ese caso se queda con el nombre simple
      // y es la OTRA la que se cualifica: accounting/ReportsService -> accountingReportsService.
      c.variable = bajaInicial(nombre).startsWith(carpeta) ? bajaInicial(nombre) : carpeta + nombre;
      avisos.push(`Nombre repetido "${nombre}": ${path.relative(SRC, c.fichero)} -> ${c.variable}`);
    }
    // Si la regla anterior dejó dos iguales, se cualifican todas para no colisionar.
    const usados = new Set<string>();
    for (const c of lista) {
      if (!usados.has(c.variable)) {
        usados.add(c.variable);
        continue;
      }
      const carpeta = bajaInicial(path.basename(path.dirname(c.fichero)).replace(/[^a-zA-Z0-9]/g, ''));
      c.variable = carpeta + nombre;
      usados.add(c.variable);
    }
  }
}

const faltantes = [...declarados].filter((d) => !clases.has(d));

// ---------------------------------------------------------------------------
// 3. Orden topológico
// ---------------------------------------------------------------------------
const orden: Clase[] = [];
const estado = new Map<string, 'visitando' | 'listo'>();
const ciclos: string[] = [];

function visitar(id: string, pila: string[]): void {
  if (estado.get(id) === 'listo') return;
  if (estado.get(id) === 'visitando') {
    const corto = (x: string) => x.split('#')[1] ?? x;
    ciclos.push([...pila.slice(pila.indexOf(id)), id].map(corto).join(' -> '));
    return;
  }
  const clase = clases.get(id);
  if (!clase) return;

  estado.set(id, 'visitando');
  for (const dep of clase.deps) {
    if (dep.id && clases.has(dep.id)) visitar(dep.id, [...pila, id]);
  }
  estado.set(id, 'listo');
  orden.push(clase);
}

for (const id of [...clases.keys()].sort()) visitar(id, []);

// ---------------------------------------------------------------------------
// 4. Informe / generación
// ---------------------------------------------------------------------------
console.log(`providers declarados en módulos : ${declarados.size}`);
console.log(`clases encontradas             : ${clases.size}`);
console.log(`orden de instanciación resuelto : ${orden.length}`);

const depsExternas = new Set<string>();
const depsDesconocidas = new Map<string, string[]>();
for (const c of clases.values()) {
  for (const d of c.deps) {
    if (d.id && clases.has(d.id)) continue;
    if (d.tipo in EXTERNAS) depsExternas.add(d.tipo);
    else {
      if (!depsDesconocidas.has(d.tipo)) depsDesconocidas.set(d.tipo, []);
      depsDesconocidas.get(d.tipo)!.push(c.nombre);
    }
  }
}

if (faltantes.length) {
  console.log(`\nDeclarados en un módulo pero sin clase encontrada (${faltantes.length}):`);
  for (const f of faltantes) console.log(`   ${path.relative(SRC, f)}`);
}
if (depsExternas.size) {
  console.log(`\nDependencias externas (se resuelven a mano): ${[...depsExternas].join(', ')}`);
}
if (depsDesconocidas.size) {
  console.log(`\nDependencias SIN resolver (${depsDesconocidas.size}) — hay que cablearlas a mano:`);
  for (const [d, quienes] of [...depsDesconocidas].sort()) {
    console.log(`   ${d.padEnd(34)} usada por: ${quienes.slice(0, 4).join(', ')}${quienes.length > 4 ? `, +${quienes.length - 4}` : ''}`);
  }
}
if (ciclos.length) {
  console.log(`\nCICLOS (${ciclos.length}) — no se puede generar hasta romperlos:`);
  for (const c of [...new Set(ciclos)]) console.log(`   ${c}`);
}
if (avisos.length) {
  console.log(`\nAvisos (${avisos.length}):`);
  for (const a of [...new Set(avisos)].slice(0, 15)) console.log(`   ${a}`);
}

if (!ESCRIBIR) {
  console.log('\n(simulacro — usa --escribir para generar src/core/contenedor.ts)');
  process.exit(ciclos.length ? 1 : 0);
}

if (ciclos.length) {
  console.error('\nNo se genera nada: hay ciclos en el grafo de dependencias.');
  process.exit(1);
}

// Dos clases distintas pueden llamarse igual (las dos `ReportsService`). En un único
// fichero eso es una colisión de identificadores, así que la segunda y siguientes se
// importan con alias. El alias se deriva de la variable ya desambiguada, para que el
// import y la instancia se lean como la misma cosa.
const alias = new Map<string, string>(); // id -> identificador a usar en el fichero
{
  const usados = new Set<string>();
  for (const c of orden) {
    // Candidatos en orden de preferencia. Ojo: capitalizar la variable NO basta —
    // `reportsService` capitalizado vuelve a ser `ReportsService` y choca con el
    // nombre original. Por eso hay una cadena de alternativas y una comprobación
    // real de colisión al final.
    const carpeta = path.basename(path.dirname(c.fichero)).replace(/[^a-zA-Z0-9]/g, '');
    const capitalizar = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const candidatos = [
      c.nombre,
      capitalizar(c.variable),
      capitalizar(carpeta) + c.nombre,
    ];
    let elegido = candidatos.find((x) => !usados.has(x));
    // Red de seguridad: si todo choca, se numera. Feo, pero correcto — y el aviso
    // de "nombre repetido" ya avisó de que aquí hay dos clases homónimas.
    for (let i = 2; !elegido; i++) {
      const numerado = `${c.nombre}${i}`;
      if (!usados.has(numerado)) elegido = numerado;
    }
    usados.add(elegido);
    alias.set(c.id, elegido);
  }
}

const importsPorFichero = new Map<string, string[]>();
for (const c of orden) {
  const rel = path
    .relative(path.dirname(SALIDA), c.fichero.replace(/\.ts$/, ''))
    .split(path.sep)
    .join('/');
  const ruta = rel.startsWith('.') ? rel : `./${rel}`;
  const identificador = alias.get(c.id)!;
  const clausula = identificador === c.nombre ? c.nombre : `${c.nombre} as ${identificador}`;
  if (!importsPorFichero.has(ruta)) importsPorFichero.set(ruta, []);
  importsPorFichero.get(ruta)!.push(clausula);
}

const lineasImport = [...importsPorFichero]
  .sort()
  .map(([ruta, nombres]) => `import { ${[...new Set(nombres)].sort().join(', ')} } from '${ruta}';`);

const lineasInstancia = orden.map((c) => {
  const args = c.deps.map((d) => {
    if (d.id && clases.has(d.id)) return clases.get(d.id)!.variable;
    const externa = EXTERNAS[d.tipo];
    if (externa) return externa;
    return `undefined as never /* TODO: ${d.tipo} */`;
  });
  return `export const ${c.variable} = new ${alias.get(c.id)}(${args.join(', ')});`;
});

const contenido = `/**
 * Cableado de servicios (composition root). ── FICHERO GENERADO ──
 *
 * Lo genera \`scripts/generar-contenedor.ts\` a partir de los constructores reales.
 * No se edita a mano: vuelve a generarse cuando cambian las dependencias.
 *
 * Sustituye al contenedor de inyección de Nest. Aquí no hay reflexión ni
 * descubrimiento: cada servicio se construye una vez, en orden topológico, y se
 * exporta como una constante. Quién depende de quién se lee en la propia llamada.
 *
 * Servicios: ${orden.length}
 */
import { eventos } from './eventos';
${lineasImport.join('\n')}

${lineasInstancia.join('\n')}

/** Todos los servicios, para los ganchos de arranque y apagado. */
export const todosLosServicios = [
${orden.map((c) => `  ${c.variable},`).join('\n')}
];
`;

fs.writeFileSync(SALIDA, contenido);
console.log(`\nGenerado ${path.relative(process.cwd(), SALIDA)} (${orden.length} servicios)`);

// Mapa "fichero#Clase" -> nombre de la constante exportada. Lo consume el generador
// de routers para saber qué instancia pasarle a cada controlador. Se emite como
// fichero aparte porque deducirlo releyendo el contenedor generado obligaría a
// deshacer los alias, y ahí es fácil equivocarse de clase homónima.
const MAPA = path.join(RAIZ, 'contenedor-mapa.json');
fs.writeFileSync(
  MAPA,
  JSON.stringify(
    Object.fromEntries(orden.map((c) => [path.relative(RAIZ, c.fichero) + '#' + c.nombre, c.variable])),
    null,
    2,
  ),
);
console.log(`Generado ${path.relative(process.cwd(), MAPA)}`);
