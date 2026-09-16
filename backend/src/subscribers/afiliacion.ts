import type { PrismaService } from '../prisma/prisma.service';
import { num } from '../common/money';
import { esAfiliacion } from '../common/concepto-factura';

/**
 * La AFILIACIÓN: lo que de verdad se le cobra a un cliente el día que se da de alta.
 *
 * Hasta 2026-08-29 el alta emitía como "factura de afiliación" la MENSUALIDAD de los
 * planes contratados (100 MEGAS + Television = 76.900). Eso no es lo que cobra la
 * empresa ni lo que cobra el legacy, y el desajuste se veía en ventanilla: la cajera
 * recibía los 70.000 de la afiliación contra una factura de 76.900 y el cliente quedaba
 * debiendo 6.900 el mismo día de entrar (caso real: abonado 57439, factura #500035).
 *
 * Lo que hace el legacy en sus ~7.500 altas, sin una sola excepción:
 *
 *   alta            → factura FIJA con un producto «Afiliación …»  (70.000)
 *   instalación     → factura RECURRENTE con los planes a 0        (el mes en curso no se cobra)
 *   1º del mes sig. → corrida mensual normal                       (75.000, 76.900…)
 *
 * O sea: la mensualidad NO entra en el alta. Empieza a correr el mes siguiente, que es
 * justo lo que hace la corrida mensual de nexus (sólo factura ACTIVO/COMPROMISO, y el
 * alta nace INSTALAR).
 *
 * Las afiliaciones son productos del catálogo (`Material`, la tabla `productos` del
 * legacy), no un número escrito a mano: hay doce, con precios distintos según lo que se
 * venda (Combo 70.000, Villavo 50.000, Dedicado 300.000, Streaming 85.000…). Este módulo
 * las lee de ahí y propone la que toca; la cajera puede cambiarla en el asistente.
 */

/** Una afiliación del catálogo, lista para volcarse como renglón de factura. */
export type AfiliacionCatalogo = {
  /** `Material.id` — es lo que manda el asistente en `affiliationId`. */
  id: string;
  name: string;
  price: number;
  taxRate: number;
  /** `Material.legacyId` (pid del legacy), para que el renglón viaje igual allá. */
  productId: number;
};

/**
 * Qué afiliación se propone según lo que contrata.
 *
 * Son los tres casos que cubren el 99% de las altas; el resto (Villavo, Dedicado,
 * Streaming, cambio de plan) se elige a mano en el asistente porque dependen de la
 * venta, no del plan.
 */
export function nombreSugerido(servicios: readonly string[]): string | null {
  const kinds = new Set(servicios.map((k) => (k ?? '').toUpperCase()));
  const internet = kinds.has('INTERNET');
  const tv = kinds.has('TV');
  if (internet && tv) return 'Afiliación Combo';
  if (internet) return 'Afiliación Internet solo';
  if (tv) return 'Afiliación Television';
  return null;
}

/** Sin tildes y en minúsculas: el catálogo mezcla «Afiliación» y «Afiliacion». */
const plano = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Todas las afiliaciones del catálogo, de la más barata a la más cara. */
export async function catalogoAfiliaciones(prisma: PrismaService): Promise<AfiliacionCatalogo[]> {
  const filas = await prisma.material.findMany({
    where: { name: { startsWith: 'Afiliaci', mode: 'insensitive' } },
    select: { id: true, name: true, price: true, taxRate: true, legacyId: true },
  });
  return filas
    .map((m) => ({
      id: m.id,
      name: m.name.trim(),
      price: num(m.price),
      taxRate: num(m.taxRate),
      productId: m.legacyId ?? 0,
    }))
    .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name, 'es'));
}

/**
 * La afiliación que se va a facturar en ESTA alta.
 *
 * Manda lo que eligió quien hace el alta (`materialId`); si no eligió, se deduce de los
 * servicios contratados. El precio se puede pisar (`precio`) porque el legacy factura
 * afiliaciones rebajadas y hasta en 0 — una promoción, un cliente que vuelve—, y sin eso
 * habría que ir a editar la factura recién emitida.
 *
 * Devuelve `null` cuando no hay de dónde deducirla (alta sin plan y sin elección): más
 * vale que el alta lo reporte como paso no hecho que cobrar una afiliación inventada.
 */
export async function resolverAfiliacion(
  prisma: PrismaService,
  opciones: { materialId?: string | null; precio?: number | null; servicios: readonly string[] },
): Promise<AfiliacionCatalogo | null> {
  const catalogo = await catalogoAfiliaciones(prisma);
  if (!catalogo.length) return null;

  let elegida: AfiliacionCatalogo | undefined;
  if (opciones.materialId?.trim()) {
    elegida = catalogo.find((a) => a.id === opciones.materialId!.trim());
    // Un id que no está en el catálogo es un error de quien llama, no algo que
    // se pueda "arreglar" cobrando otra cosa.
    if (!elegida) return null;
  } else {
    const sugerida = nombreSugerido(opciones.servicios);
    if (!sugerida) return null;
    elegida = catalogo.find((a) => plano(a.name) === plano(sugerida));
    // El catálogo lo mantiene contabilidad y los nombres cambian de año en año
    // («Afiliacion 2021»): si el nombre exacto ya no existe, se cae a cualquier
    // afiliación que empiece igual antes que a no cobrar nada.
    elegida ??= catalogo.find((a) => esAfiliacion(a.name));
  }
  if (!elegida) return null;

  const precio = opciones.precio;
  if (precio === undefined || precio === null || !Number.isFinite(precio) || precio < 0) return elegida;
  return { ...elegida, price: Math.round(precio) };
}
