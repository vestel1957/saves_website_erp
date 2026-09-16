import { planDeUltimaFactura } from './plan-facturable';
import { PrismaService } from '../prisma/prisma.service';

/** Prisma de mentira: la 1ª llamada a `$queryRaw` es la de los ítems y la 2ª la de
 *  la cabecera. Devolver `[]` en la 1ª es exactamente el caso del recién instalado. */
const prismaCon = (porItems: unknown[], porCabecera: unknown[]) => {
  const llamadas: number[] = [];
  return {
    prisma: {
      $queryRaw: jest.fn(async () => {
        llamadas.push(1);
        return llamadas.length === 1 ? porItems : porCabecera;
      }),
    } as unknown as PrismaService,
    veces: () => llamadas.length,
  };
};

const mes = new Date(Date.UTC(2026, 8, 1));
const item = (subscriberId: string, name: string, price: number) =>
  ({ subscriberId, kind: 'INTERNET', name, price, taxRate: 0, veces: BigInt(3), planPrice: price });
const cabecera = (subscriberId: string, kind: string, name: string, price: number, taxRate = 0) =>
  ({ subscriberId, kind, name, price, taxRate });

describe('planDeUltimaFactura ▸ escalón de cabecera', () => {
  it('rescata al recién instalado: sus ítems van en $0 y el plan sale de combo/TV', async () => {
    // Caso real de la corrida del 2026-09-01: el abonado 57487 solo tenía la
    // afiliación ($70.000, que no es un plan) y su mes de instalación en $0.00.
    // Por los ítems no sale nada; por la cabecera sale su combo completo.
    const { prisma, veces } = prismaCon([], [
      cabecera('s1', 'INTERNET', '300Megas26F', 58500),
      cabecera('s1', 'TV', 'Television26', 22269, 19),
    ]);
    const r = await planDeUltimaFactura(prisma, ['s1'], mes);
    expect(veces()).toBe(2);
    expect(r.get('s1')).toEqual([
      { kind: 'INTERNET', planName: '300Megas26F', price: 58500, taxRate: 0 },
      { kind: 'TV', planName: 'Television26', price: 22269, taxRate: 19 },
    ]);
  });

  it('NO pisa a quien ya resolvió por ítems: manda el precio que el cliente paga', async () => {
    // El precio de catálogo puede ir por delante del que tiene pactado el abonado.
    // Si la cabecera se impusiera, la corrida le subiría la mensualidad sola.
    const { prisma } = prismaCon(
      [item('s1', '300Megas26F', 50000)],
      [cabecera('s1', 'INTERNET', '300Megas26F', 58500)],
    );
    const r = await planDeUltimaFactura(prisma, ['s1'], mes);
    expect(r.get('s1')).toEqual([{ kind: 'INTERNET', planName: '300Megas26F', price: 50000, taxRate: 0 }]);
  });

  it('solo consulta la cabecera por los que quedaron huérfanos', async () => {
    const { prisma } = prismaCon([item('s1', '300Megas26F', 58500)], []);
    await planDeUltimaFactura(prisma, ['s1', 's2'], mes);
    const segunda = (prisma.$queryRaw as jest.Mock).mock.calls[1];
    // El `Prisma.join` de los ids viaja en los valores del template.
    expect(JSON.stringify(segunda)).toContain('s2');
    expect(JSON.stringify(segunda)).not.toContain('s1');
  });

  it('sin huérfanos no vuelve a la base', async () => {
    const { prisma, veces } = prismaCon([item('s1', '300Megas26F', 58500)], []);
    await planDeUltimaFactura(prisma, ['s1'], mes);
    expect(veces()).toBe(1);
  });

  it('el mismo plan repetido en el catálogo se devuelve UNA vez', async () => {
    // `Plan` tiene '10MegasF' y '10megasF': dos filas para el mismo plan, y el ítem
    // de la factura casa con las dos. Cada fila que salga de aquí es un renglón que
    // se cobra, así que el duplicado es plata de más (35 facturas de la corrida del
    // 01-09-2026 y los $73.600 de reconexión del abonado 4286).
    const { prisma } = prismaCon(
      [item('s1', '10MegasF', 48000), item('s1', '10megasF', 48000)],
      [],
    );
    const r = await planDeUltimaFactura(prisma, ['s1'], mes);
    expect(r.get('s1')).toEqual([{ kind: 'INTERNET', planName: '10MegasF', price: 48000, taxRate: 0 }]);
  });
});
