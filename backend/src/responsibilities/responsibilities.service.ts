import { BadRequestException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { POSTS, POST_GROUPS, postDef } from './responsibilities.catalog';

/** Un encargado resuelto, listo para notificar. */
export interface Holder {
  userId: string;
  name: string;
  /** Teléfono E.164 sin '+', o null si el usuario no lo tiene registrado. */
  whatsappPhone: string | null;
  isPrimary: boolean;
  notifyWhatsapp: boolean;
}

/** A quién le toca un cargo, y si salió del cargo o del respaldo por permiso. */
export interface Resolved {
  holders: Holder[];
  /** true = el cargo está vacío y esto es el respaldo por permiso. */
  fromFallback: boolean;
}

export class ResponsibilitiesService {
  private readonly logger = new Logger('Responsibilities');

  constructor(private readonly prisma: PrismaService) {}

  // ── Lectura para la UI ─────────────────────────────────────────────────────

  /** Catálogo completo con sus encargados. Los cargos vacíos también salen. */
  async list() {
    const filas = await this.prisma.responsibility.findMany({
      include: { user: { select: { id: true, name: true, email: true, whatsappPhone: true, isActive: true } } },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });

    const porCargo = new Map<string, typeof filas>();
    for (const f of filas) {
      const lista = porCargo.get(f.post) ?? [];
      lista.push(f);
      porCargo.set(f.post, lista);
    }

    const posts = POSTS.map((def) => {
      const asignados = porCargo.get(def.slug) ?? [];
      return {
        slug: def.slug,
        label: def.label,
        group: def.group,
        purpose: def.purpose,
        alerts: def.alerts,
        /** Sin encargado los avisos siguen saliendo por respaldo; la UI lo advierte. */
        hasFallback: !!def.fallbackPermission,
        holders: asignados.map((a) => ({
          id: a.id,
          userId: a.userId,
          name: a.user.name,
          email: a.user.email,
          isPrimary: a.isPrimary,
          notifyWhatsapp: a.notifyWhatsapp,
          /** Pidió WhatsApp pero no tiene teléfono: el aviso se queda en la campanita. */
          missingPhone: a.notifyWhatsapp && !a.user.whatsappPhone,
          /** Nombrado y luego desactivado: sigue en la casilla pero no recibe nada. */
          inactive: !a.user.isActive,
          updatedAt: a.updatedAt,
          updatedBy: a.updatedBy,
        })),
      };
    });

    return {
      groups: POST_GROUPS.map((g) => ({ group: g, posts: posts.filter((p) => p.group === g) })),
      /** Cargos sin nadie: es el número que la pantalla pone arriba. */
      vacantes: posts.filter((p) => !p.holders.length).length,
    };
  }

  /** Usuarios que se pueden nombrar encargados (para el selector). */
  async assignableUsers() {
    const rows = await this.prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true, whatsappPhone: true },
      orderBy: { name: 'asc' },
    });
    return rows.map((u) => ({ id: u.id, name: u.name, email: u.email, hasPhone: !!u.whatsappPhone }));
  }

  // ── Escritura ──────────────────────────────────────────────────────────────

  /**
   * Reemplaza de un golpe los encargados de un cargo. Es un PUT y no un POST por
   * encargado a propósito: la pantalla edita "quiénes son los de bodega" como una
   * lista, y hacerlo en una transacción evita el estado intermedio en que el cargo
   * se queda sin nadie mientras se sustituye al titular.
   */
  async setHolders(
    post: string,
    holders: { userId: string; isPrimary?: boolean; notifyWhatsapp?: boolean }[],
    updatedBy?: string,
  ) {
    const def = postDef(post);
    if (!def) throw new BadRequestException(`El cargo "${post}" no existe en el catálogo.`);

    const limpios = [...new Map((holders ?? []).map((h) => [h.userId, h])).values()].filter((h) => h.userId);

    if (limpios.length) {
      const existen = await this.prisma.user.findMany({
        where: { id: { in: limpios.map((h) => h.userId) } },
        select: { id: true },
      });
      const vivos = new Set(existen.map((u) => u.id));
      const fantasma = limpios.find((h) => !vivos.has(h.userId));
      if (fantasma) throw new BadRequestException('Uno de los usuarios seleccionados no existe.');
    }

    // Un solo titular. Si nadie viene marcado, el primero de la lista lo es: un cargo
    // con encargados pero sin titular es justo la ambigüedad que esto viene a quitar.
    const titular = limpios.find((h) => h.isPrimary)?.userId ?? limpios[0]?.userId;

    await this.prisma.$transaction(async (tx) => {
      await tx.responsibility.deleteMany({ where: { post } });
      if (!limpios.length) return;
      await tx.responsibility.createMany({
        data: limpios.map((h) => ({
          post,
          userId: h.userId,
          isPrimary: h.userId === titular,
          notifyWhatsapp: !!h.notifyWhatsapp,
          updatedBy: updatedBy ?? null,
        })),
      });
    });

    return this.list();
  }

  // ── Resolución para el notificador ─────────────────────────────────────────

  /**
   * Quién atiende este cargo ahora mismo. Nunca lanza: un aviso que no se puede
   * dirigir no puede tumbar la operación que lo produjo.
   *
   * Sólo devuelve usuarios ACTIVOS: nombrar a alguien y desvincularlo después no
   * debe dejar el aviso cayendo en una cuenta apagada.
   */
  async resolve(post: string): Promise<Resolved> {
    const def = postDef(post);
    if (!def) {
      // Un slug con typo no le llega a nadie y no falla en ninguna parte: por eso grita.
      this.logger.error(`Se pidió avisar al cargo "${post}", que no está en el catálogo. Nadie recibió el aviso.`);
      return { holders: [], fromFallback: false };
    }

    const filas = await this.prisma.responsibility
      .findMany({
        where: { post, user: { isActive: true } },
        include: { user: { select: { id: true, name: true, whatsappPhone: true } } },
        orderBy: { isPrimary: 'desc' },
      })
      .catch((e) => {
        this.logger.warn(`No se pudieron leer los encargados de "${post}": ${(e as Error).message}`);
        return [];
      });

    if (filas.length) {
      return {
        fromFallback: false,
        holders: filas.map((f) => ({
          userId: f.userId,
          name: f.user.name,
          whatsappPhone: f.user.whatsappPhone ?? null,
          isPrimary: f.isPrimary,
          notifyWhatsapp: f.notifyWhatsapp,
        })),
      };
    }

    if (!def.fallbackPermission) return { holders: [], fromFallback: false };

    const respaldo = await this.byPermission(def.fallbackPermission);
    if (respaldo.length) {
      this.logger.warn(
        `El cargo "${def.label}" no tiene encargado: el aviso salió a los ${respaldo.length} con el permiso ` +
          `${def.fallbackPermission}. Nómbralo en Configuración → Encargados por cargo.`,
      );
    }
    return {
      fromFallback: true,
      // El respaldo NO manda WhatsApp: es un aviso que iba dirigido y terminó en una
      // lista. Escribirle al teléfono de 23 personas por eso sería peor que el problema.
      holders: respaldo.map((u) => ({
        userId: u.id,
        name: u.name,
        whatsappPhone: null,
        isPrimary: false,
        notifyWhatsapp: false,
      })),
    };
  }

  /** Usuarios activos con un permiso, por rol o por ajuste individual. */
  private async byPermission(key: string) {
    return this.prisma.user
      .findMany({
        where: {
          isActive: true,
          OR: [
            { roles: { some: { role: { permissions: { some: { permission: { key } } } } } } },
            { permissionOverrides: { some: { effect: 'ALLOW', permission: { key } } } },
          ],
        },
        select: { id: true, name: true },
        take: 200,
      })
      .catch(() => []);
  }
}
