import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SubscriberStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { exigirSedeSuscriptor, sedesDe, whereSedeSuscriptor } from '../common/sede-scope';
import { assertPoint, distMeters, parsePoint } from './geo.util';
import { MapQueryDto, PingDto, SetSubscriberLocationDto } from './dto/geo.dto';

/** Tope de pines devueltos. Ver `points()` para por qué existe. */
const MAX_PUNTOS = 5000;

/** Un punto no se considera "dónde está el técnico ahora" pasadas estas horas. */
const VIGENCIA_TECNICO_H = 12;

const NOMBRE = {
  firstName: true, secondName: true, lastName1: true, lastName2: true,
  companyName: true, fullName: true,
} as const;

type ConNombre = { [K in keyof typeof NOMBRE]: string | null };

function nombreDe(s: ConNombre): string {
  return (
    s.fullName?.trim() ||
    [s.firstName, s.secondName, s.lastName1, s.lastName2]
      .map((p) => p?.trim())
      .filter(Boolean)
      .join(' ') ||
    s.companyName?.trim() ||
    'Sin nombre'
  );
}

const SI = (v: string | undefined, pordefecto: boolean) =>
  v === undefined ? pordefecto : v === '1' || v === 'true';

@Injectable()
export class GeoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Puntos del mapa: abonados y cajas NAP que tienen coordenadas utilizables.
   *
   * Devuelve TODO de una vez en lugar de paginar por recuadro visible. Con el
   * parque actual (≈1.900 abonados y ≈550 NAPs georreferenciados) son unos pocos
   * cientos de KB y el mapa se mueve sin volver a pedir nada, que es justo lo que
   * hace usable un mapa. `MAX_PUNTOS` es el seguro para cuando el 91% de abonados
   * que hoy no tiene GPS lo vaya teniendo: al pasarse, hay que cambiar a carga por
   * recuadro (`bbox`) y agrupar en el servidor, no subir el tope.
   */
  async points(user: AuthUser, q: MapQueryDto) {
    const sedes = await sedesDe(this.prisma, user);
    const incluirSubs = SI(q.subs, true);
    const incluirNaps = SI(q.naps, true);

    // El selector manda el `id` (cuid) de la sede, pero el acceso por usuario se
    // guarda con los `legacyId`. Se traduce aquí, y de paso se comprueba que el
    // usuario acotado no pida una sede que no le toca.
    let sedeFiltro = sedes;
    if (q.sede) {
      const b = await this.prisma.branch.findUnique({
        where: { id: q.sede },
        select: { legacyId: true },
      });
      if (!b || (sedes && !sedes.includes(b.legacyId))) {
        return { subscribers: [], naps: [], truncated: false };
      }
      sedeFiltro = [b.legacyId];
    }

    const texto = q.q?.trim();
    const whereSub: Prisma.SubscriberWhereInput = {
      // El filtro de verdad (coordenada válida) es en memoria: en BD son texto y
      // hay basura ('0', 'NULL', ''). Esto solo descarta los nulos, que son la
      // inmensa mayoría, usando el índice.
      gpsLat: { not: null },
      gpsLng: { not: null },
      ...whereSedeSuscriptor(sedeFiltro),
      ...(texto
        ? {
            OR: [
              { fullName: { contains: texto, mode: 'insensitive' as const } },
              { addressLine: { contains: texto, mode: 'insensitive' as const } },
              ...(/^\d+$/.test(texto) ? [{ abonado: Number(texto) }] : []),
            ],
          }
        : {}),
    };

    const [subs, naps] = await Promise.all([
      incluirSubs
        ? this.prisma.subscriber.findMany({
            where: whereSub,
            select: {
              id: true, abonado: true, ...NOMBRE, addressLine: true, phone1: true,
              status: true, gpsLat: true, gpsLng: true,
              branch: { select: { name: true, legacyId: true } },
            },
            take: MAX_PUNTOS + 1,
          })
        : Promise.resolve([]),
      incluirNaps
        ? this.prisma.nap.findMany({
            where: {
              gpsLat: { not: null },
              gpsLng: { not: null },
              ...(sedeFiltro ? { branch: { legacyId: { in: sedeFiltro } } } : {}),
              ...(texto ? { name: { contains: texto, mode: 'insensitive' as const } } : {}),
            },
            select: {
              id: true, name: true, address: true, portCount: true,
              gpsLat: true, gpsLng: true,
              branch: { select: { name: true } },
              _count: { select: { ports: true } },
            },
            take: MAX_PUNTOS + 1,
          })
        : Promise.resolve([]),
    ]);

    const truncated = subs.length > MAX_PUNTOS || naps.length > MAX_PUNTOS;

    return {
      truncated,
      subscribers: subs.slice(0, MAX_PUNTOS).flatMap((s) => {
        const p = parsePoint(s.gpsLat, s.gpsLng);
        if (!p) return [];
        return [{
          id: s.id,
          abonado: s.abonado,
          name: nombreDe(s),
          address: s.addressLine,
          phone: s.phone1,
          status: s.status,
          sede: s.branch?.name ?? null,
          lat: p.lat,
          lng: p.lng,
        }];
      }),
      naps: naps.slice(0, MAX_PUNTOS).flatMap((n) => {
        const p = parsePoint(n.gpsLat, n.gpsLng);
        if (!p) return [];
        return [{
          id: n.id,
          name: n.name,
          address: n.address,
          ports: n._count.ports,
          portCount: n.portCount,
          sede: n.branch?.name ?? null,
          lat: p.lat,
          lng: p.lng,
        }];
      }),
    };
  }

  /**
   * Último punto conocido de cada funcionario dentro de la ventana de vigencia.
   *
   * "Último de cada uno" con Prisma serían N consultas o un groupBy que no puede
   * traerse las columnas del registro ganador; con `DISTINCT ON` de Postgres es
   * una sola pasada por el índice `(userId, createdAt)`.
   */
  async technicians(_user: AuthUser, horas = VIGENCIA_TECNICO_H) {
    const desde = new Date(Date.now() - horas * 3600_000);
    const filas = await this.prisma.$queryRaw<
      Array<{
        userId: string; userName: string; lat: number; lng: number;
        accuracy: number | null; reason: string; refType: string | null;
        refId: string | null; createdAt: Date;
      }>
    >`
      SELECT DISTINCT ON ("userId")
        "userId", "userName", "lat", "lng", "accuracy", "reason", "refType", "refId", "createdAt"
      FROM "GeoPing"
      WHERE "createdAt" >= ${desde}
      ORDER BY "userId", "createdAt" DESC
    `;
    return filas.map((f) => ({
      ...f,
      minutosDesde: Math.round((Date.now() - f.createdAt.getTime()) / 60000),
    }));
  }

  /** Recorrido de un funcionario en un día (auditoría de una visita). */
  async trail(userId: string, fecha?: string) {
    const base = fecha ? new Date(`${fecha}T00:00:00.000Z`) : new Date();
    if (Number.isNaN(base.getTime())) throw new BadRequestException('Fecha inválida.');
    const desde = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
    const hasta = new Date(desde.getTime() + 86400_000);
    const puntos = await this.prisma.geoPing.findMany({
      where: { userId, createdAt: { gte: desde, lt: hasta } },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    return {
      userId,
      fecha: desde.toISOString().slice(0, 10),
      puntos: puntos.map((p) => ({
        lat: p.lat, lng: p.lng, accuracy: p.accuracy, reason: p.reason,
        refType: p.refType, refId: p.refId, createdAt: p.createdAt,
      })),
    };
  }

  /** Graba un punto del usuario actual. Lo llama el frontend tras una acción suya. */
  async ping(user: AuthUser, dto: PingDto) {
    const p = this.validar(dto.lat, dto.lng);
    const staff = await this.staffDe(user);
    await this.prisma.geoPing.create({
      data: {
        userId: user.id,
        userName: user.name,
        staffId: staff?.id ?? null,
        lat: p.lat,
        lng: p.lng,
        accuracy: dto.accuracy ?? null,
        reason: dto.reason,
        refType: dto.refType ?? null,
        refId: dto.refId ?? null,
      },
    });
    return { ok: true };
  }

  /**
   * Fija las coordenadas del abonado. Es el camino por el que se va a llenar el
   * 91% del parque que hoy no tiene GPS: el técnico, parado en el domicilio,
   * pulsa un botón.
   *
   * Cuando la captura es de campo se graba además el punto del técnico, y se
   * devuelve la distancia respecto de la coordenada anterior — así se ve de un
   * vistazo si se está corrigiendo un dato (10 m) o pisando el de otro cliente
   * (3 km), que con un botón de un solo toque pasa.
   */
  async setSubscriberLocation(user: AuthUser, id: string, dto: SetSubscriberLocationDto) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const sub = await this.prisma.subscriber.findUnique({
      where: { id },
      select: { id: true, abonado: true, gpsLat: true, gpsLng: true },
    });
    if (!sub) throw new NotFoundException('Abonado no encontrado.');

    const p = this.validar(dto.lat, dto.lng);
    const anterior = parsePoint(sub.gpsLat, sub.gpsLng);
    const movidoM = anterior ? distMeters(anterior.lat, anterior.lng, p.lat, p.lng) : null;

    await this.prisma.subscriber.update({
      where: { id },
      data: { gpsLat: p.lat.toFixed(6), gpsLng: p.lng.toFixed(6) },
    });

    if ((dto.source ?? 'campo') === 'campo') {
      const staff = await this.staffDe(user);
      await this.prisma.geoPing.create({
        data: {
          userId: user.id,
          userName: user.name,
          staffId: staff?.id ?? null,
          lat: p.lat,
          lng: p.lng,
          accuracy: dto.accuracy ?? null,
          reason: 'subscriber.capture',
          refType: 'subscriber',
          refId: id,
        },
      });
    }

    return {
      ok: true,
      lat: p.lat,
      lng: p.lng,
      anterior,
      movidoM,
      accuracy: dto.accuracy ?? null,
    };
  }

  /** Cuántos abonados tienen GPS — el indicador que dice si el mapa sirve o no. */
  async coverage(user: AuthUser) {
    const sedes = await sedesDe(this.prisma, user);
    const whereSede = whereSedeSuscriptor(sedes);
    const activos: SubscriberStatus[] = ['ACTIVO', 'CARTERA', 'COMPROMISO', 'CORTADO', 'SUSPENDIDO'];
    const [total, conGps, totalActivos, conGpsActivos, naps, napsConGps] = await Promise.all([
      this.prisma.subscriber.count({ where: whereSede }),
      this.prisma.subscriber.count({ where: { ...whereSede, gpsLat: { not: null } } }),
      this.prisma.subscriber.count({ where: { ...whereSede, status: { in: activos } } }),
      this.prisma.subscriber.count({
        where: { ...whereSede, status: { in: activos }, gpsLat: { not: null } },
      }),
      this.prisma.nap.count(),
      this.prisma.nap.count({ where: { gpsLat: { not: null } } }),
    ]);
    return { total, conGps, totalActivos, conGpsActivos, naps, napsConGps };
  }

  private validar(lat: number, lng: number) {
    try {
      return assertPoint(lat, lng);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  /**
   * Staff equivalente al usuario. No hay FK `User→Staff` (se resuelve por email o
   * nombre, igual que "Mi jornada"), así que puede no encontrarse: el punto se
   * graba igual con el `userId`, que es el dato fiable.
   */
  private staffDe(user: AuthUser) {
    return this.prisma.staff.findFirst({
      where: {
        banned: false,
        OR: [
          { email: { equals: user.email, mode: 'insensitive' } },
          { name: { equals: user.name, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
    });
  }
}
