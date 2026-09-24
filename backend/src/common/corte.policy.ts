import type { SubInvoiceStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { hoyEnColombia } from './fecha-colombia';
import { deudaPendiente } from './money';
import { serviciosContratados, tieneServicio } from './servicios-contratados';

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

/**
 * Deuda VENCIDA mínima, en pesos, para que el lote corte a alguien.
 *
 * **El estado de la factura no prueba que se deba plata** (2026-09-21). El candado
 * miraba sólo `status IN (DUE, PARTIAL)` y el lote masivo de ese día cortó a clientes
 * al día: la CC 39949681 (abonado 8423) pagó septiembre el 5 con 50 pesos de más, pero
 * su factura de agosto venía del legacy como `partial` con 74.100 pagados sobre 73.150.
 * Para el candado eso era "una factura vencida sin pagar". De 567 cortados en el lote,
 * 16 no debían un peso vencido (y otros 16 debían menos de 10.000: residuos de IVA,
 * ver [[saldo-fantasma-sobrepago-no-aplicado]]). En la base hay ~340 facturas DUE o
 * PARTIAL que en plata están saldadas: el estado viene del legacy y miente;
 * `total − paidAmount` es el dato.
 *
 * El piso de 10.000 es el mismo de la revisión de cortes deshechos y el filtro
 * "más de $10.000" del legacy: por un residuo de céntimos no se le corta el internet a
 * nadie en lote. Quien de verdad deba menos, se corta desde su ficha.
 */
export const DEUDA_MINIMA_CORTE = 10_000;

/** Por qué a este abonado no se le corta en lote. */
export type MotivoProteccion = 'sin-vencer' | 'compromiso';

/** Lo que hay que saber de un abonado para decidir si el lote puede cortarlo. */
export type FilaCandado = {
  id: string;
  status: string | null;
  /** Fecha pactada del acuerdo de pago, si la tiene. */
  promiseExpiry: Date | null;
  /** ¿Arrastra deuda YA vencida de al menos `DEUDA_MINIMA_CORTE` pesos? */
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

export type Protegidos = {
  compromiso: number;
  sinVencer: number;
  /** No tienen contratado el servicio que el lote corta (ver `filtrarCortables`). */
  sinServicio?: number;
};

export type ResultadoCandado = {
  /** Los que sí se pueden cortar. */
  ids: string[];
  protegidos: Protegidos;
};

/** Frase para el parte del lote (y para el 400 cuando no queda nadie a quien cortar). */
export function fraseProtegidos(p: Protegidos): string {
  const partes: string[] = [];
  if (p.sinVencer) {
    partes.push(`${p.sinVencer} sin ninguna factura vencida o debiendo menos de $${DEUDA_MINIMA_CORTE.toLocaleString('es-CO')} vencidos`);
  }
  if (p.compromiso) partes.push(`${p.compromiso} con compromiso de pago vigente`);
  if (p.sinServicio) partes.push(`${p.sinServicio} que no tienen ese servicio contratado`);
  return partes.join(' y ');
}

/**
 * Quita del lote a quien no se debe cortar y dice cuántos quedaron fuera por qué.
 *
 * Los ids que no existen se dejan pasar tal cual (igual que antes): sin ficha no hay
 * nada que comprobar, y comérselos aquí escondería el error más adelante.
 *
 * `servicio`: el que corta el lote. Quien no lo tiene contratado sale también
 * (2026-09-23): el lote de TV le abría "Corte Television" a quien sólo paga internet
 * y el de internet cortaba a quien sólo paga TV, porque se marca a los clientes por
 * deuda, no por lo que tienen. Sin datos de lo que tiene, se deja pasar.
 */
export async function filtrarCortables(
  prisma: PrismaService,
  ids: string[],
  hoy: Date = hoyEnColombia(),
  servicio?: 'INTERNET' | 'TV',
): Promise<ResultadoCandado> {
  if (!ids.length) return { ids: [], protegidos: { compromiso: 0, sinVencer: 0, ...(servicio ? { sinServicio: 0 } : {}) } };
  const rows = await prisma.subscriber.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      promiseExpiry: true,
      // Se trae la PLATA, no sólo si existe alguna: una factura PARTIAL puede estar
      // pagada de más (ver `DEUDA_MINIMA_CORTE`).
      invoices: {
        where: { status: { in: IMPAGAS }, dueDate: { lt: hoy } },
        select: { total: true, paidAmount: true },
      },
    },
  });
  const protegidos: Protegidos = { compromiso: 0, sinVencer: 0 };
  const fuera = new Set<string>();
  if (servicio) {
    protegidos.sinServicio = 0;
    // Si no se puede leer qué tiene cada uno, el lote sigue como antes: es un filtro
    // de más, no una razón para no cortar a nadie.
    const contratos = await serviciosContratados(prisma, rows.map((r) => r.id)).catch(() => new Map());
    for (const r of rows) {
      if (tieneServicio(contratos, r.id, servicio)) continue;
      fuera.add(r.id);
      protegidos.sinServicio!++;
    }
  }
  for (const r of rows) {
    if (fuera.has(r.id)) continue;
    const motivo = motivoProteccion(
      {
        id: r.id,
        status: r.status,
        promiseExpiry: r.promiseExpiry,
        tieneVencida: deudaPendiente(r.invoices) >= DEUDA_MINIMA_CORTE,
      },
      hoy,
    );
    if (!motivo) continue;
    fuera.add(r.id);
    if (motivo === 'compromiso') protegidos.compromiso++;
    else protegidos.sinVencer++;
  }
  return { ids: ids.filter((id) => !fuera.has(id)), protegidos };
}
