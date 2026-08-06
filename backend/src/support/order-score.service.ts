import { BadRequestException } from '../core/http/errores';
import { PrismaService } from '../prisma/prisma.service';
import { PUNTAJE_MAX, PUNTAJE_MIN, esPuntajeValido, puntajeSugerido } from './order-score.policy';
import { esTrabajoDeCampo, tiposDeCampo } from './field-work.policy';
import { DETALLES_POR_CLASE } from './order-types';

/** Cuánto vale un tipo de orden y de dónde salió ese número. */
export type PuntajeDeTipo = {
  tipo: string;
  puntos: number;
  /** `definido` = alguien lo fijó a mano · `sugerido` = el valor que trae el sistema. */
  origen: 'definido' | 'sugerido';
  /** El sugerido, para poder mostrar de qué se está apartando y volver atrás. */
  sugerido: number;
  /** ¿Cuenta en el tablero de rendimiento? Ver field-work.policy.ts. */
  campo: boolean;
  /** Órdenes de este tipo en el último año. Sin esto no se sabe qué vale la pena afinar. */
  usos: number;
  updatedBy: string | null;
  updatedAt: Date | null;
};

/** Un cambio pedido desde la pantalla. `puntos: null` = volver al sugerido. */
export type CambioPuntaje = { tipo: string; puntos: number | null };

/**
 * El puntaje de las órdenes: qué vale cada tipo y cuánto se le sella a una orden
 * al cerrarla.
 *
 * Vive aparte de `SupportWriteService` porque tiene dos clientes que no se
 * parecen: el cierre (una lectura por orden, en caliente) y la pantalla de
 * configuración (el catálogo entero, de vez en cuando).
 */
export class OrderScoreService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Los puntos que vale este tipo HOY: lo configurado, o el sugerido si nadie lo
   * tocó. Es una consulta por cierre y va por índice único (`type`); no se
   * cachea a propósito, porque un cambio de puntaje tiene que valer para la
   * siguiente orden que se cierre y no para la de dentro de cinco minutos.
   */
  async puntajeDe(tipo: string | null | undefined): Promise<number> {
    if (!tipo) return puntajeSugerido(tipo);
    const fila = await this.prisma.ticketTypeScore.findUnique({ where: { type: tipo } });
    return fila ? fila.points : puntajeSugerido(tipo);
  }

  /**
   * Catálogo completo para la pantalla de configuración.
   *
   * La lista de tipos sale de los DOS lados: los que existen de verdad en las
   * órdenes (incluidos los que abre el chatbot, que no están en el catálogo web)
   * y los del catálogo (que pueden no haberse usado nunca todavía). Quedarse con
   * uno solo deja tipos sin puntaje configurable.
   */
  async catalogo() {
    const desde = new Date(Date.now() - 365 * 86400_000);
    const [usados, definidos, todosLosTipos] = await Promise.all([
      this.prisma.ticket.groupBy({
        by: ['type'],
        where: { created: { gte: desde } },
        _count: { _all: true },
      }),
      this.prisma.ticketTypeScore.findMany(),
      this.prisma.ticket.findMany({ distinct: ['type'], select: { type: true } }),
    ]);

    const usoPorTipo = new Map(usados.map((u) => [u.type, u._count._all]));
    const definidoPorTipo = new Map(definidos.map((d) => [d.type, d]));

    const tipos = new Set<string>();
    for (const t of todosLosTipos) if (t.type) tipos.add(t.type);
    for (const lista of Object.values(DETALLES_POR_CLASE)) for (const t of lista) tipos.add(t);
    for (const d of definidos) tipos.add(d.type);

    // El "es de campo" se calcula con la MISMA lista que usa el tablero (incluido
    // el ajuste manual `tickets.fieldTypes`), no con el patrón suelto: si alguien
    // recortó el universo medido, la pantalla tiene que decir lo mismo que el tablero.
    const ajuste = await this.prisma.appSetting.findUnique({ where: { key: 'tickets.fieldTypes' } });
    const campo = new Set(
      ajuste?.value ? tiposDeCampo([...tipos], ajuste.value) : [...tipos].filter(esTrabajoDeCampo),
    );

    const filas: PuntajeDeTipo[] = [...tipos].map((tipo) => {
      const def = definidoPorTipo.get(tipo);
      const sugerido = puntajeSugerido(tipo);
      return {
        tipo,
        puntos: def ? def.points : sugerido,
        origen: def ? 'definido' : 'sugerido',
        sugerido,
        campo: campo.has(tipo),
        usos: usoPorTipo.get(tipo) ?? 0,
        updatedBy: def?.updatedBy ?? null,
        updatedAt: def?.updatedAt ?? null,
      };
    });

    // Los de campo primero (son los que puntúan en el tablero) y, dentro de cada
    // grupo, por uso: lo que más se cierra es lo que más mueve los puntos.
    filas.sort((a, b) => {
      if (a.campo !== b.campo) return a.campo ? -1 : 1;
      if (b.usos !== a.usos) return b.usos - a.usos;
      return a.tipo.localeCompare(b.tipo, 'es');
    });

    return { min: PUNTAJE_MIN, max: PUNTAJE_MAX, tipos: filas };
  }

  /**
   * Guarda los puntajes cambiados en la pantalla.
   *
   * No toca `Ticket.score` de las órdenes ya cerradas, y es deliberado: lo que se
   * le abonó a un técnico se queda como se le abonó (ver el comentario de
   * `Ticket.score`). El cambio vale desde el siguiente cierre.
   */
  async guardar(cambios: CambioPuntaje[], actor?: string) {
    if (!Array.isArray(cambios) || !cambios.length) {
      throw new BadRequestException('No hay puntajes que guardar.');
    }

    for (const c of cambios) {
      if (!c?.tipo || typeof c.tipo !== 'string') {
        throw new BadRequestException('Falta el tipo de orden en uno de los puntajes.');
      }
      if (c.puntos !== null && !esPuntajeValido(c.puntos)) {
        throw new BadRequestException(
          `El puntaje de "${c.tipo}" tiene que ser un número entero de ${PUNTAJE_MIN} a ${PUNTAJE_MAX}.`,
        );
      }
    }

    await this.prisma.$transaction(
      cambios.map((c) =>
        c.puntos === null
          ? // Volver al sugerido = borrar la fila, no escribir el sugerido. Así, si
            // mañana se afina la escala del sistema, este tipo la sigue.
            this.prisma.ticketTypeScore.deleteMany({ where: { type: c.tipo } })
          : this.prisma.ticketTypeScore.upsert({
              where: { type: c.tipo },
              create: { type: c.tipo, points: c.puntos, updatedBy: actor ?? null },
              update: { points: c.puntos, updatedBy: actor ?? null },
            }),
      ),
    );

    return { guardados: cambios.length };
  }
}
