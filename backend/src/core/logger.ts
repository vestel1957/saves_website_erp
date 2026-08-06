/**
 * Logger propio, sustituto de `Logger` de `@nestjs/common` (54 ficheros lo usan).
 *
 * Misma API que la de Nest —`new Logger('Contexto')` y `.log/.error/.warn/.debug`,
 * más los métodos estáticos— para que la migración sea un cambio de import y no una
 * reescritura de cada llamada. El formato de salida imita al de Nest a propósito:
 * quien lee los logs de pm2 a diario no tiene que reaprender a leerlos.
 */

const NIVELES = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
type Nivel = (typeof NIVELES)[number];

/**
 * `debug`/`verbose` se silencian en producción. Antes lo hacía Nest por defecto;
 * sin este corte, los mensajes de depuración acabarían en los logs de pm2.
 */
const NIVEL_MAXIMO: Nivel = process.env.LOG_LEVEL
  ? (process.env.LOG_LEVEL as Nivel)
  : process.env.NODE_ENV === 'production'
    ? 'log'
    : 'debug';

const COLOR: Record<Nivel, string> = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  log: '\x1b[32m',
  debug: '\x1b[35m',
  verbose: '\x1b[36m',
};
const RESET = '\x1b[0m';

// Sin TTY (pm2 escribe a fichero) los códigos de color son basura en el log.
const usarColor = process.stdout.isTTY === true;

function marcaDeTiempo(): string {
  // Hora local del servidor, como hacía Nest.
  return new Date().toLocaleString('es-CO', { hour12: false });
}

function emitir(nivel: Nivel, contexto: string | undefined, mensaje: unknown, extra?: unknown) {
  if (NIVELES.indexOf(nivel) > NIVELES.indexOf(NIVEL_MAXIMO)) return;

  const etiqueta = nivel.toUpperCase().padStart(5);
  const ctx = contexto ? `[${contexto}] ` : '';
  const texto = typeof mensaje === 'string' ? mensaje : JSON.stringify(mensaje);
  const linea = usarColor
    ? `${COLOR[nivel]}${etiqueta}${RESET} ${marcaDeTiempo()} ${ctx}${texto}`
    : `${etiqueta} ${marcaDeTiempo()} ${ctx}${texto}`;

  const salida = nivel === 'error' || nivel === 'warn' ? console.error : console.log;
  salida(linea);
  // La traza (o el segundo argumento) va en su propia línea, como en Nest.
  if (extra !== undefined) salida(typeof extra === 'string' ? extra : JSON.stringify(extra));
}

export class Logger {
  constructor(private readonly contexto?: string) {}

  log(mensaje: unknown, extra?: unknown) {
    emitir('log', this.contexto, mensaje, extra);
  }
  error(mensaje: unknown, traza?: unknown) {
    emitir('error', this.contexto, mensaje, traza);
  }
  warn(mensaje: unknown, extra?: unknown) {
    emitir('warn', this.contexto, mensaje, extra);
  }
  debug(mensaje: unknown, extra?: unknown) {
    emitir('debug', this.contexto, mensaje, extra);
  }
  verbose(mensaje: unknown, extra?: unknown) {
    emitir('verbose', this.contexto, mensaje, extra);
  }

  // Nest permite usarlos también como estáticos; algún sitio del proyecto lo hace.
  static log(mensaje: unknown, contexto?: string) {
    emitir('log', contexto, mensaje);
  }
  static error(mensaje: unknown, traza?: unknown, contexto?: string) {
    emitir('error', contexto, mensaje, traza);
  }
  static warn(mensaje: unknown, contexto?: string) {
    emitir('warn', contexto, mensaje);
  }
  static debug(mensaje: unknown, contexto?: string) {
    emitir('debug', contexto, mensaje);
  }
}
