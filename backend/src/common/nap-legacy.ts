import type { PrismaService } from '../prisma/prisma.service';

/** Lo que un equipo trae del legacy para decir dónde está colgado. */
export type EquipoConCaja = { nat: number | null; port: number | null };

/** La caja y el puerto ya legibles, más los ids de aquí para abrir el editor. */
export type CajaDeEquipo = {
  napId: string | null;
  napName: string | null;
  portId: string | null;
  portNumber: number | null;
};

export const SIN_CAJA: CajaDeEquipo = { napId: null, napName: null, portId: null, portNumber: null };

/**
 * Traduce los ids legacy de un puñado de equipos a la caja NAP y el número de puerto
 * que hay ROTULADOS: `equipos.nat` es `Nap.legacyId` y `equipos.puerto` es
 * `Port.legacyId` —el `idp` de la fila, no el número— (ver `resolverPuertos` en
 * `support-write.service`). Sin esto las pantallas enseñan "N:241 · PN:2393", que no
 * es ni la caja ni el puerto que el técnico ve en el poste.
 *
 * Devuelve una función por equipo para que cada pantalla la aplique en su propio
 * `map`. Dos consultas en total, no una por equipo.
 */
export async function traductorDeCajas(
  prisma: PrismaService,
  equipos: EquipoConCaja[],
): Promise<(e: EquipoConCaja) => CajaDeEquipo> {
  const napsDe = [...new Set(equipos.map((e) => e.nat).filter((v): v is number => !!v))];
  const puertosDe = [...new Set(equipos.map((e) => e.port).filter((v): v is number => !!v))];
  const [naps, puertos] = await Promise.all([
    napsDe.length
      ? prisma.nap.findMany({ where: { legacyId: { in: napsDe } }, select: { id: true, legacyId: true, name: true } })
      : [],
    puertosDe.length
      ? prisma.port.findMany({ where: { legacyId: { in: puertosDe } }, select: { id: true, legacyId: true, port: true, napLegacy: true } })
      : [],
  ]);

  return (e: EquipoConCaja): CajaDeEquipo => {
    const caja = e.nat ? naps.find((n) => n.legacyId === e.nat) ?? null : null;
    // Sólo vale si el puerto es DE esa caja: hay 353 equipos importados cuyo `puerto`
    // no casa con ningún `idp` de su NAP, y pintar el número de un puerto de otra
    // caja es peor que no pintar nada.
    const puerto = e.port ? puertos.find((p) => p.legacyId === e.port && (!e.nat || p.napLegacy === e.nat)) ?? null : null;
    return {
      napId: caja?.id ?? null,
      napName: caja?.name ?? null,
      portId: puerto?.id ?? null,
      portNumber: puerto?.port ?? null,
    };
  };
}
