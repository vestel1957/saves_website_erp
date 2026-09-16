import type { SubInvoiceStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { hoyEnColombia } from './fecha-colombia';

/**
 * Candado de los cortes MASIVOS: a quién se puede cortar de verdad.
 *
 * Nació de un corte real del legacy (2026-09-09, 07:27, lote de 17 clientes con la
 * nota "Por mora."): **9 de los 17 debían SOLO la factura del mes corriente, que
 * vencía el 20**. Uno de ellos (abonado 50999) había pagado agosto cuatro días
 * antes. Hubo que reconectarlos a mano uno por uno durante el día siguiente.
 *
 * No fue un descuido de quien apretó el botón: la pantalla de corte del legacy
 * (`Clientgroup::get_filtrados_para_checked`) selecciona **solo por plata** —"1 mes",
 * "más de un mes", "2 meses", "Todos", "más de $10.000"— y la fecha de vencimiento no
 * aparece en ninguna parte de esa consulta. Como la corrida del día 1 emite el mes
 * corriente (ver [[mes-que-factura-la-corrida]]), desde el día 1 el que está al día ya
 * "debe una mensualidad" y entra en la lista.
 *
 * Aquí se tapa por los dos lados, porque el filtro y el botón son cosas distintas:
 *
 *  · el filtro `deuda=fija` de `debtIds` mide solo la deuda YA VENCIDA (esto es lo
 *    que cambia a quién se le propone cortar), y
 *
 *  · este candado se aplica en el momento de ejecutar el lote, gane el filtro que
 *    gane —y también cuando los clientes se eligieron a mano en la pantalla—, que es
 *    lo único que garantiza que no se corta a quien no tiene una sola factura
 *    vencida. Un filtro se puede cambiar; el botón es el mismo siempre.
 *
 * **No aplica al corte individual** de la ficha ni al cierre de una orden de corte ya
 * abierta: ahí hay una persona decidiendo caso por caso (fraude, petición del propio
 * cliente, un trabajo que un supervisor mandó hacer) y el sistema no tiene por qué
 * saber más que ella. Lo que se frena es el lote, que es donde un criterio flojo se
 * multiplica por cientos.
 */

/** Estados de factura que cuentan como deuda (mismo criterio que la lista de clientes). */
const IMPAGAS: SubInvoiceStatus[] = ['DUE', 'PARTIAL'];

/** Por qué a este abonado no se le corta en lote. */
export type MotivoProteccion = 'sin-vencer' | 'compromiso';

/** Lo que hay que saber de un abonado para decidir si el lote puede cortarlo. */
export type FilaCandado = {
  id: string;
  status: string | null;
  /** Fecha pactada del acuerdo de pago, si la tiene. */
  promiseExpiry: Date | null;
  /** ¿Arrastra alguna factura sin pagar YA vencida? */
  tieneVencida: boolean;
};

/**
 * Decisión pura: `null` = se puede cortar.
 *
 * El orden importa poco (quien no tiene nada vencido tampoco tiene un compromiso
 * incumplido), pero se mira primero el vencimiento porque es el motivo que hay que
 * explicarle a quien mandó el lote: "todavía no le vence" se entiende; "tiene
 * compromiso" en un cliente que no debe nada, no.
 */
export function motivoProteccion(f: FilaCandado, hoy: Date): MotivoProteccion | null {
  if (!f.tieneVencida) return 'sin-vencer';
  // Paridad con el legacy (`_compromiso_vencido`): manda la fecha pactada cuando
  // existe y, cuando no —los que bajaron del legacy sin fecha—, manda que arrastre
  // una factura vencida. Aquí lo segundo ya es cierto, así que sin fecha se corta.
  if (f.status === 'COMPROMISO' && f.promiseExpiry && f.promiseExpiry >= hoy) return 'compromiso';
  return null;
}

export type Protegidos = { compromiso: number; sinVencer: number };

export type ResultadoCandado = {
  /** Los que sí se pueden cortar. */
  ids: string[];
  protegidos: Protegidos;
};

/** Frase para el parte del lote (y para el 400 cuando no queda nadie a quien cortar). */
export function fraseProtegidos(p: Protegidos): string {
  const partes: string[] = [];
  if (p.sinVencer) partes.push(`${p.sinVencer} sin ninguna factura vencida (aún están en plazo)`);
  if (p.compromiso) partes.push(`${p.compromiso} con compromiso de pago vigente`);
  return partes.join(' y ');
}

/**
 * Quita del lote a quien no se debe cortar y dice cuántos quedaron fuera por qué.
 *
 * Los ids que no existen se dejan pasar tal cual (igual que antes): sin ficha no hay
 * nada que comprobar, y comérselos aquí escondería el error más adelante.
 */
export async function filtrarCortables(
  prisma: PrismaService,
  ids: string[],
  hoy: Date = hoyEnColombia(),
): Promise<ResultadoCandado> {
  if (!ids.length) return { ids: [], protegidos: { compromiso: 0, sinVencer: 0 } };
  const rows = await prisma.subscriber.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      promiseExpiry: true,
      // Solo hace falta saber SI hay alguna vencida, no cuáles.
      invoices: {
        where: { status: { in: IMPAGAS }, dueDate: { lt: hoy } },
        select: { id: true },
        take: 1,
      },
    },
  });
  const protegidos: Protegidos = { compromiso: 0, sinVencer: 0 };
  const fuera = new Set<string>();
  for (const r of rows) {
    const motivo = motivoProteccion(
      { id: r.id, status: r.status, promiseExpiry: r.promiseExpiry, tieneVencida: r.invoices.length > 0 },
      hoy,
    );
    if (!motivo) continue;
    fuera.add(r.id);
    if (motivo === 'compromiso') protegidos.compromiso++;
    else protegidos.sinVencer++;
  }
  return { ids: ids.filter((id) => !fuera.has(id)), protegidos };
}
