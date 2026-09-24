import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Quién puede quedar como el funcionario que trajo al cliente (`Subscriber.affiliateStaffId`).
 *
 * Hasta el 2026-09-23 cada funcionario repartía un código (`VES-K7M2`) y el alta lo
 * pedía escrito. Ese mismo día, a pedido del usuario, el código se retiró: el alta
 * ofrece un SELECTOR con los funcionarios de la empresa y el cliente queda a nombre
 * del que se elija. Las columnas `Staff.affiliateCode` y `Subscriber.affiliateCode`
 * siguen en la base, sin uso nuevo.
 *
 * Desde el 2026-09-23 (noche) la lista es NOMINAL: sólo los funcionarios que el usuario
 * nombró (incluye a las cajeras Sonia, Mireya y Lizeth, y a Edgar). Reemplaza la regla
 * anterior de «activos menos cajeras». Se nombran por `legacyId` porque es la llave que
 * sobrevive a una reimportación de la ficha. Para agregar o quitar a alguien, tocar aquí.
 * Pendiente: «Gustavo Andrés Arévalo Rodríguez» estaba en la lista pero no tiene ficha
 * de funcionario; cuando la tenga, sumar su `legacyId`.
 */
const AFILIADORES_LEGACY: number[] = [
  127, // Luis Alberto Martínez Martínez
  29, // Oscar Rodríguez Fonseca
  163, // Johana Mancipe Díaz
  131, // Paula Andrea Unas
  161, // Santiago André García Castañeda
  35, // Dagoberto Zea
  109, // Julio Alejandro Martínez Alvarado
  34, // Luis Fabián Arévalo López
  18, // Cristhian Manuel Dueñas Acosta
  68, // José Alfredo Blanco
  142, // Cristhian Mahecha Monsalve
  103, // Edgar Esteban Rodríguez
  55, // Nayme Andrés Jiménez Chávez
  33, // Sonia Rubiela Barreto Umaña
  107, // Miguel Ángel Sarmiento Pachón
  139, // Luz Neidi Barrera Forero
  165, // Mireya Esperanza Aguilera Gómez
  70, // Luis Fernando Hurtado Cuartas
  160, // Elder López Fuentes
  137, // Miguel Ángel Álvarez Martínez
  177, // Juver Octavio Fonseca Vega
  89, // Windy Sussan Muñoz Martínez
  179, // Brayan Mauricio Linares Castañeda
  178, // Lizeth Tatiana Cendales Herrera
];

export const AFILIADORES: Prisma.StaffWhereInput = {
  banned: false,
  legacyId: { in: AFILIADORES_LEGACY },
};

/** Los funcionarios que se pueden elegir en el alta, por nombre. */
export function afiliadoresDisponibles(prisma: PrismaService) {
  return prisma.staff.findMany({
    where: AFILIADORES,
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}

/** El funcionario elegido, si de verdad está en la lista (activo y en la lista nominal); si no, null. */
export function afiliadorValido(prisma: PrismaService, staffId: string | null | undefined) {
  if (!staffId) return Promise.resolve(null);
  return prisma.staff.findFirst({ where: { AND: [{ id: staffId }, AFILIADORES] }, select: { id: true, name: true } });
}

/**
 * Rango de fechas en hora de Bogotá. `affiliateAt` es un timestamp: cortarlo en UTC
 * pasaría al día siguiente las altas de después de las 7 p. m. Sin fechas = sin límite.
 */
export function rangoBogota(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: new Date(`${from}T00:00:00.000-05:00`) } : {}),
    ...(to ? { lte: new Date(`${to}T23:59:59.999-05:00`) } : {}),
  };
}
