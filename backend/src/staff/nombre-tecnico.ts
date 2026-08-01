import type { PrismaService } from '../prisma/prisma.service';

/**
 * Traduce el nombre de usuario del legacy al NOMBRE COMPLETO del funcionario.
 *
 * Las órdenes de servicio guardan al técnico en `Ticket.assigned`, que es texto
 * libre heredado del legacy: los 115 valores distintos que hay en la tabla son
 * *usernames* ('NaimeSistemas', 'OmarTec'), ni uno solo es un nombre de persona.
 * El sistema ya no habla de nombres de usuario, así que el username se queda como
 * lo que es —una llave de datos viejos— y se traduce al salir a pantalla.
 *
 * Lo que no cruza con ninguna ficha se devuelve tal cual: hay usernames de gente
 * cuya ficha ya no existe, y dejar la orden sin técnico sería peor que mostrar el
 * texto crudo.
 */
export type ResolverNombre = (texto: string | null | undefined) => string | null;

export type TraductorTecnicos = {
  /** username (o lo que haya) -> nombre completo. */
  nombre: ResolverNombre;
  /**
   * El camino de vuelta: todos los textos con los que ese nombre puede estar
   * escrito en `Ticket.assigned`. Sirve para que filtrar por "Omar Jose Balcazar"
   * encuentre también las 584 órdenes que dicen 'OmarTec'.
   */
  claves(nombre: string): string[];
  /**
   * Lo mismo, pero para una búsqueda parcial: buscar "balcazar" en órdenes tiene
   * que traer las de 'OmarTec', porque el apellido está en la ficha y no en el
   * texto que guardó el legacy.
   */
  clavesPorTexto(texto: string): string[];
  /**
   * ¿Ese texto es de un funcionario inhabilitado? Los reportes que miden a la
   * gente (recaudo, rendimiento, órdenes por técnico) no evalúan a quien ya no
   * trabaja aquí. Un texto que no cruza con ninguna ficha NO es inhabilitado: es
   * un desconocido, y ahí se prefiere mostrarlo a borrarlo del reporte.
   */
  inhabilitado(texto: string | null | undefined): boolean;
};

/** El censo de funcionarios cambia muy poco; releerlo en cada listado no aporta. */
const TTL_MS = 60_000;

type Censo = {
  at: number;
  porUsuario: Map<string, string>;
  clavesPorNombre: Map<string, string[]>;
  /** Llaves (username y nombre) de los que están inhabilitados. */
  inhabilitados: Set<string>;
};
let cache: Censo | null = null;

/** Vacía la caché tras editar un funcionario, para no mostrar un nombre viejo un minuto. */
export function olvidarNombres() {
  cache = null;
}

const llave = (s: string) => s.trim().toLowerCase();

async function censo(prisma: PrismaService): Promise<Censo> {
  const ahora = Date.now();
  if (cache && ahora - cache.at < TTL_MS) return cache;
  const filas = await prisma.staff.findMany({ select: { username: true, name: true, banned: true } });
  const porUsuario = new Map<string, string>();
  const clavesPorNombre = new Map<string, string[]>();
  const inhabilitados = new Set<string>();
  for (const f of filas) {
    const nombre = f.name.trim();
    if (!nombre) continue;
    // El legacy trae basura de captura (mayúsculas distintas, espacios al final:
    // 'OmarTec '), así que las llaves van normalizadas.
    const claves = clavesPorNombre.get(llave(nombre)) ?? [nombre];
    const u = (f.username ?? '').trim();
    if (u) {
      porUsuario.set(llave(u), nombre);
      claves.push(u);
    }
    clavesPorNombre.set(llave(nombre), claves);
    if (f.banned) {
      inhabilitados.add(llave(nombre));
      if (u) inhabilitados.add(llave(u));
    }
  }
  cache = { at: ahora, porUsuario, clavesPorNombre, inhabilitados };
  return cache;
}

/** Traductor `username <-> nombre completo` listo para usar en un listado. */
export async function traductorDeTecnicos(prisma: PrismaService): Promise<TraductorTecnicos> {
  const { porUsuario, clavesPorNombre, inhabilitados } = await censo(prisma);
  return {
    nombre: (texto) => {
      const t = texto?.trim();
      if (!t) return null;
      return porUsuario.get(llave(t)) ?? t;
    },
    // Sin ficha que case, el propio texto es la única llave que hay.
    claves: (nombre) => clavesPorNombre.get(llave(nombre)) ?? [nombre.trim()],
    clavesPorTexto: (texto) => {
      const t = llave(texto);
      if (!t) return [];
      const salida: string[] = [];
      for (const [nombre, claves] of clavesPorNombre) if (nombre.includes(t)) salida.push(...claves);
      return salida;
    },
    inhabilitado: (texto) => {
      const t = texto?.trim();
      return !!t && inhabilitados.has(llave(t));
    },
  };
}
