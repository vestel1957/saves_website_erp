import 'reflect-metadata';
import { NetworkWriteService } from './network-write.service';

/**
 * La sede de una caja NAP se escribe con el catálogo de BODEGAS.
 *
 * `naps.sede` / `vlans.sede` / `puertos.sede` del legacy no apuntan a
 * `customers_group` (las sedes de los clientes) sino a `almacen_equipos`, que es
 * contra lo que el propio legacy resuelve el nombre:
 *
 *   Redes_model.php:250  join('almacen_equipos', 'almacen_equipos.id = naps.sede')
 *
 * Los dos catálogos se parecen —Yopal es 2 en uno y 4 en el otro— y por confundirlos
 * el ETL dejó las 1.406 cajas cada una en la sede de al lado: las 199 de
 * "Villavicencio" eran de Tauramena, las 305 de "Mocoa" eran de Monterrey. Se
 * corrigió con `prisma/migrate-sede-naps-almacen-2026-09.ts`; esto es para que el
 * alta no lo vuelva a sembrar caja por caja.
 */
describe('NetworkWriteService · la sede de las NAPs es la bodega, no customers_group', () => {
  /** Las bodegas reales, con la sede que les dedujo migrate-bodegas-equipos-sede. */
  const BODEGAS = [
    { legacyId: 2, branchLegacy: 3 }, // Villanueva
    { legacyId: 4, branchLegacy: 2 }, // Yopal
    { legacyId: 5, branchLegacy: 4 }, // Monterrey
    { legacyId: 8, branchLegacy: 7 }, // Tauramena
    { legacyId: 10, branchLegacy: 8 }, // Villavicencio
    { legacyId: 12, branchLegacy: 2 }, // CABECERA YOPAL
    { legacyId: 13, branchLegacy: 2 }, // Almacen cabecera Yopal
  ];

  const armar = (sede: { id: string; legacyId: number | null }) => {
    const napCreada: any[] = [];
    const puertos: any[] = [];
    const vlanCreada: any[] = [];
    const tx = {
      nap: {
        aggregate: jest.fn().mockResolvedValue({ _max: { legacyId: 1415 } }),
        create: jest.fn(async ({ data }: any) => { napCreada.push(data); return { id: 'n1', ...data }; }),
      },
      port: {
        aggregate: jest.fn().mockResolvedValue({ _max: { legacyId: 9000 } }),
        createMany: jest.fn(async ({ data }: any) => { puertos.push(...data); return { count: data.length }; }),
      },
    };
    const prisma = {
      branch: { findUnique: jest.fn().mockResolvedValue(sede) },
      nap: { findFirst: jest.fn().mockResolvedValue(null) },
      vlan: {
        aggregate: jest.fn().mockResolvedValue({ _max: { legacyId: 600 } }),
        create: jest.fn(async ({ data }: any) => { vlanCreada.push(data); return { id: 'v1', ...data }; }),
      },
      equipmentWarehouse: {
        findFirst: jest.fn(async ({ where, orderBy }: any) => {
          const cand = BODEGAS.filter((b) => b.branchLegacy === where.branchLegacy)
            .sort((a, b) => (orderBy?.legacyId === 'asc' ? a.legacyId - b.legacyId : 0));
          return cand[0] ?? null;
        }),
      },
      $transaction: jest.fn((fn: any) => fn(tx)),
    };
    const svc = new NetworkWriteService(prisma as any, {} as any, {} as any, {} as any);
    return { svc, prisma, napCreada, puertos, vlanCreada };
  };

  it('una caja de Yopal (sede 2) se guarda con la bodega 4, no con el 2', async () => {
    const { svc, napCreada } = armar({ id: 'b-yopal', legacyId: 2 });
    await svc.createNap({ branchId: 'b-yopal', name: 'YP-NUEVA-1', portCount: 8 } as any);
    expect(napCreada[0].sedeLegacy).toBe(4);
    expect(napCreada[0].branchId).toBe('b-yopal');
  });

  it('elige la bodega del pueblo, no la "cabecera" (Yopal tiene 4, 12 y 13)', async () => {
    const { svc, napCreada, prisma } = armar({ id: 'b-yopal', legacyId: 2 });
    await svc.createNap({ branchId: 'b-yopal', name: 'YP-NUEVA-2', portCount: 8 } as any);
    expect(prisma.equipmentWarehouse.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { legacyId: 'asc' } }),
    );
    expect(napCreada[0].sedeLegacy).toBe(4);
  });

  it('los puertos que nacen con la caja llevan la misma bodega que ella', async () => {
    const { svc, puertos } = armar({ id: 'b-vllnva', legacyId: 3 });
    await svc.createNap({ branchId: 'b-vllnva', name: 'VLLC3_09', portCount: 8 } as any);
    expect(puertos).toHaveLength(8);
    expect(new Set(puertos.map((p) => p.sedeLegacy))).toEqual(new Set([2]));
  });

  it('una VLAN nueva también se guarda con la bodega', async () => {
    const { svc, vlanCreada } = armar({ id: 'b-taura', legacyId: 7 });
    await svc.createVlan({ branchId: 'b-taura', vlan: 777, detail: 'prueba' } as any);
    expect(vlanCreada[0].sedeLegacy).toBe(8);
  });

  it('una sede sin bodega (Mocoa) se guarda con 0, no con su id de cliente', async () => {
    const { svc, napCreada } = armar({ id: 'b-mocoa', legacyId: 5 });
    await svc.createNap({ branchId: 'b-mocoa', name: 'MOC-1', portCount: 8 } as any);
    // 5 en el catálogo de bodegas es Monterrey: guardarlo mandaría la caja a otro pueblo.
    expect(napCreada[0].sedeLegacy).toBe(0);
    expect(napCreada[0].branchId).toBe('b-mocoa');
  });
});
