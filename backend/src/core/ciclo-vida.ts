/**
 * Ganchos de arranque y apagado (sustituyen a `OnModuleInit` / `OnModuleDestroy` /
 * `OnApplicationBootstrap` de Nest).
 *
 * Las interfaces se conservan con el MISMO nombre y el mismo método para que los
 * cuatro servicios que las implementan no cambien ni una línea de su cuerpo. Lo que
 * cambia es quién los llama: antes Nest los descubría por reflexión al levantar cada
 * módulo; ahora los llama el arranque, explícitamente y en un orden que se lee.
 *
 * No es un detalle menor: uno de estos ganchos es el `$connect()` de Prisma. Si nadie
 * lo llama, la primera consulta de cada arranque paga la conexión y, peor, un fallo
 * de credenciales no aparece al arrancar sino a mitad de una petición de usuario.
 */

export interface OnModuleInit {
  onModuleInit(): void | Promise<void>;
}

export interface OnModuleDestroy {
  onModuleDestroy(): void | Promise<void>;
}

export interface OnApplicationBootstrap {
  onApplicationBootstrap(): void | Promise<void>;
}

/**
 * Se acepta `unknown` y se comprueba en tiempo de ejecución, en vez de exigir un tipo
 * con los ganchos. El contenedor entrega una lista heterogénea de 114 servicios de
 * los que sólo cuatro implementan alguno: pedir un tipo común obligaría a declararlo
 * en los 114 para satisfacer al compilador, que es justo el papeleo que sobra.
 */
type ConGancho = unknown;

type Ganchos = Partial<OnModuleInit & OnModuleDestroy & OnApplicationBootstrap>;

/** ¿El objeto implementa este gancho? */
function gancho<K extends keyof Ganchos>(s: unknown, nombre: K): Ganchos[K] | undefined {
  const fn = (s as Ganchos | null)?.[nombre];
  return typeof fn === 'function' ? fn : undefined;
}

/**
 * Llama a `onModuleInit()` y luego a `onApplicationBootstrap()` sobre los servicios
 * que los definan, en el orden en que se pasen.
 *
 * Los errores NO se capturan a propósito: si Prisma no conecta o el chatbot no puede
 * cargar su banco, el proceso debe morir en el arranque y que pm2 lo reintente. Un
 * proceso a medio levantar es peor que uno que no levanta — es la misma razón por la
 * que la validación del entorno aborta.
 */
export async function iniciar(servicios: ConGancho[]): Promise<void> {
  for (const s of servicios) {
    await gancho(s, 'onModuleInit')?.call(s);
  }
  for (const s of servicios) {
    await gancho(s, 'onApplicationBootstrap')?.call(s);
  }
}

/**
 * Apagado ordenado. Aquí los errores SÍ se tragan: si el proceso se está muriendo,
 * que un `$disconnect` falle no debe impedir que se cierren los demás recursos.
 */
export async function apagar(servicios: ConGancho[]): Promise<void> {
  for (const s of servicios) {
    try {
      await gancho(s, 'onModuleDestroy')?.call(s);
    } catch {
      // El proceso termina igualmente.
    }
  }
}
