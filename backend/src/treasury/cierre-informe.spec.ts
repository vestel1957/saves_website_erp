import { informeCierre, WOMPI_ID } from './cierre-informe';
import { PrismaService } from '../prisma/prisma.service';

/**
 * La fila "Efectivo" del bloque Forma de pago.
 *
 * Se blinda porque es la única cifra del informe que a propósito NO copia al legacy: allá
 * el efectivo se contaba dentro del guard `invoice->total != 0`, así que los pagos sin
 * factura (anticipos, `tid = 0`) quedaban invisibles aunque la plata estuviera en el cajón.
 */

const CAJA = 1;
const DIA = new Date('2026-09-16T00:00:00.000Z');

/** Una factura mínima: el prorrateo sólo necesita total e ítems. */
const factura = (total: number) => ({
  total, tax: 0, invoiceDate: DIA, branchRef: 'Villanueva',
  items: [{ productName: '100 Megas', subtotal: total }],
});

type Fila = Record<string, unknown>;

/** Prisma de mentira: `propias` es la 1ª llamada a findMany, los bancos la 2ª. */
const prismaCon = (propias: Fila[], bancos: Fila[] = []) => {
  const findMany = jest.fn()
    .mockResolvedValueOnce(propias)
    .mockResolvedValueOnce(bancos)
    .mockResolvedValue([]);
  return {
    cashAccount: { findUnique: jest.fn().mockResolvedValue({ holder: 'Villanueva', accountNumber: '004' }) },
    transaction: { findMany, findFirst: jest.fn().mockResolvedValue(null) },
    voiding: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
};

const fila = (f: Partial<Fila>): Fila => ({
  id: 'x', type: 'INCOME', category: 'Sales', method: 'Cash',
  credit: 0, debit: 0, note: null, status: 'VIGENTE', invoice: null, ...f,
});

const efectivoDe = async (propias: Fila[], bancos: Fila[] = []) =>
  (await informeCierre(prismaCon(propias, bancos), CAJA, DIA)).dineroEnCaja.recaudo;

describe('Velocidad del plan', () => {
  const megasDe = async (producto: string) =>
    (await informeCierre(
      prismaCon([fila({ credit: 50_000, invoice: { ...factura(50_000), items: [{ productName: producto, subtotal: 50_000 }] } })]),
      CAJA, DIA,
    )).servicios.planes[0]?.megas;

  it('toma el primer número del nombre, no todos los dígitos pegados', async () => {
    expect(await megasDe('300 Megas 26 F')).toBe(300);
    expect(await megasDe('600 Megas 26 F')).toBe(600);
    expect(await megasDe('100 Megas F 24')).toBe(100);
  });

  it('sigue leyendo bien los nombres de un solo número', async () => {
    expect(await megasDe('100 Megas F-26')).toBe(100);
    expect(await megasDe('10 Megas (F)')).toBe(10);
    expect(await megasDe('5 Megas')).toBe(5);
  });
});

describe('Dinero en caja → Recaudo del día', () => {
  it('cuenta el efectivo CON factura', async () => {
    expect(await efectivoDe([fila({ credit: 50_000, invoice: factura(50_000) })]))
      .toMatchObject({ cantidad: 1, monto: 50_000 });
  });

  it('cuenta también el efectivo SIN factura (el anticipo que el legacy perdía)', async () => {
    const r = await efectivoDe([
      fila({ id: 'a', credit: 50_000, invoice: factura(50_000) }),
      fila({ id: 'b', credit: 32_890, note: 'Pago adelantado de ROCIO — queda a favor' }),
    ]);
    expect(r).toMatchObject({ cantidad: 2, monto: 82_890 });
  });

  it('NO cuenta el arrastre: ya tiene su propia fila, contarlo aquí lo duplicaría', async () => {
    const r = await efectivoDe([
      fila({ id: 'a', credit: 50_000, invoice: factura(50_000) }),
      fila({ id: 'b', credit: 1_327_108, note: 'Saldo 2026-09-15' }),
    ]);
    expect(r).toMatchObject({ cantidad: 1, monto: 50_000 });
  });

  it('un gasto en efectivo sale del cajón, no entra', async () => {
    const r = await efectivoDe([
      fila({ id: 'a', credit: 50_000, invoice: factura(50_000) }),
      fila({ id: 'b', type: 'EXPENSE', debit: 92_000 }),
    ]);
    expect(r).toMatchObject({ cantidad: 1, monto: 50_000 });
  });

  it('el traslado que LLEGA de otra caja es efectivo que entra; la consignación que sale, no', async () => {
    const r = await efectivoDe([
      fila({ id: 'a', type: 'TRANSFER', method: '', credit: 77_000 }),
      fila({ id: 'b', type: 'TRANSFER', method: '', debit: 2_000_000 }),
    ]);
    expect(r).toMatchObject({ cantidad: 1, monto: 77_000 });
  });

  it('una anulada no es plata en el cajón', async () => {
    const r = await efectivoDe([
      fila({ id: 'a', credit: 50_000, invoice: factura(50_000) }),
      fila({ id: 'b', credit: 100_000, status: 'ANULADA' }),
    ]);
    expect(r).toMatchObject({ cantidad: 1, monto: 50_000 });
  });

  it('el pago por Wompi NO pasó por la ventanilla, aunque se consolide en esta caja', async () => {
    const wompi = fila({ id: 'w', cashAccountId: WOMPI_ID, method: 'WOMPI', credit: 65_000, invoice: factura(65_000) });
    const r = await efectivoDe([fila({ credit: 50_000, invoice: factura(50_000) })], [wompi]);
    expect(r).toMatchObject({ cantidad: 1, monto: 50_000 });
  });

  it('un movimiento de banco en Cash tampoco es el cajón (hay 23 así en 2026)', async () => {
    const banco = fila({ id: 'b', cashAccountId: 6, method: 'Cash', credit: 900_000, invoice: factura(900_000) });
    const r = await efectivoDe([fila({ credit: 50_000, invoice: factura(50_000) })], [banco]);
    expect(r).toMatchObject({ cantidad: 1, monto: 50_000 });
  });

  it('el bloque cierra: arrastre + recaudo - egresos = excedente', async () => {
    const r = (await informeCierre(prismaCon([
      fila({ id: 's', credit: 1_327_108, note: 'Saldo 2026-09-15' }),
      fila({ id: 'a', credit: 3_293_900, invoice: factura(3_293_900) }),
      fila({ id: 'b', type: 'EXPENSE', debit: 3_692_000 }),
    ]), CAJA, DIA)).dineroEnCaja;
    expect(r.saldoAnterior.monto).toBe(1_327_108);
    expect(r.recaudo.monto).toBe(3_293_900);
    expect(r.totalEnCaja).toBe(4_621_008);
    expect(r.egresos.monto).toBe(3_692_000);
    expect(r.excedente).toBe(929_008);
  });

  it('el barrido del cierre no es un egreso del día: dejaría el excedente siempre en cero', async () => {
    const r = (await informeCierre(prismaCon([
      fila({ id: 'a', credit: 500_000, invoice: factura(500_000) }),
      fila({ id: 'z', type: 'EXPENSE', debit: 500_000, note: 'Saldo 2026-09-16' }),
    ]), CAJA, DIA)).dineroEnCaja;
    expect(r.egresos).toMatchObject({ cantidad: 0, monto: 0 });
    expect(r.excedente).toBe(500_000);
  });

  it('la consignación al banco sí sale del cajón', async () => {
    const r = (await informeCierre(prismaCon([
      fila({ id: 'a', credit: 500_000, invoice: factura(500_000) }),
      fila({ id: 'b', type: 'TRANSFER', method: '', debit: 200_000 }),
    ]), CAJA, DIA)).dineroEnCaja;
    expect(r.egresos.monto).toBe(200_000);
    expect(r.excedente).toBe(300_000);
  });

  it('un domingo sin movimientos no inventa saldo anterior', async () => {
    const r = (await informeCierre(prismaCon([]), CAJA, DIA)).dineroEnCaja;
    expect(r.saldoAnterior.monto).toBe(0);
    expect(r.totalEnCaja).toBe(0);
    expect(r.excedente).toBe(0);
  });

  it('separa el recaudo sin factura, que es la mitad de por qué Cobrado != Recaudo', async () => {
    const r = (await informeCierre(prismaCon([
      fila({ id: 'a', credit: 50_000, invoice: factura(50_000) }),
      fila({ id: 'b', credit: 32_890, note: 'Pago adelantado — queda a favor' }),
      fila({ id: 'c', credit: 16_000, note: 'Pago adelantado — queda a favor' }),
    ]), CAJA, DIA)).dineroEnCaja;
    expect(r.recaudo).toMatchObject({ cantidad: 3, monto: 98_890 });
    expect(r.sinFactura).toMatchObject({ cantidad: 2, monto: 48_890 });
  });

  it('acepta las dos capitalizaciones que conviven en los datos', async () => {
    const r = await efectivoDe([
      fila({ id: 'a', method: 'Cash', credit: 10_000 }),
      fila({ id: 'b', method: 'cash', credit: 20_000 }),
    ]);
    expect(r).toMatchObject({ cantidad: 2, monto: 30_000 });
  });
});

describe('Consolidación de banco sin sede en la factura', () => {
  const wompi = (branchRef: string | null, sedeCliente: string | null, credit = 62_500) => fila({
    method: 'WOMPI', cashAccountId: WOMPI_ID, credit,
    invoice: { ...factura(credit), branchRef },
    subscriber: sedeCliente ? { branch: { name: sedeCliente } } : null,
  });
  const bancos = async (filas: Fila[]) =>
    (await informeCierre(prismaCon([], filas), CAJA, DIA)).porBanco.find((b) => b.nombre === 'WOMPI');

  it('con refer vacío usa la sede del cliente', async () => {
    expect(await bancos([wompi('', 'Villanueva'), wompi(null, 'Villanueva')])).toMatchObject({ cantidad: 2, monto: 125_000 });
  });

  it('si la factura trae sede, manda la factura aunque el cliente sea de otra', async () => {
    expect(await bancos([wompi('Yopal', 'Villanueva')])).toMatchObject({ cantidad: 0, monto: 0 });
    expect(await bancos([wompi('Villanueva', 'Yopal')])).toMatchObject({ cantidad: 1, monto: 62_500 });
  });

  it('sin refer y cliente de otra sede no entra', async () => {
    expect(await bancos([wompi('', 'Yopal')])).toMatchObject({ cantidad: 0, monto: 0 });
  });
});
