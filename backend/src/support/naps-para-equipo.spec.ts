import 'reflect-metadata';
import { SupportWriteService } from './support-write.service';

/**
 * La lista de cajas NAP del selector de entrega (2026-09-14): "no salen todas".
 * Se cortaba en 40 y Yopal tiene 508. Estas pruebas defienden que no haya tope, que
 * la búsqueda perdone los espacios y rayas bajas de los rótulos del legacy y que las
 * de la sede del cliente sigan arriba.
 */
describe('cajas NAP para entregar un equipo', () => {
  const armar = (naps: any[], branchId: string | null = 'yopal') => {
    const prisma: any = {
      subscriber: { findUnique: jest.fn().mockResolvedValue({ branchId }) },
      nap: {
        findMany: jest.fn(async (a: any) =>
          a.where?.branchId ? naps.filter((n) => n.branchId === a.where.branchId) : naps),
      },
      port: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    const svc = new SupportWriteService(
      prisma, null as any, null as any, null as any, null as any, null as any, null as any,
    );
    return { svc, prisma };
  };
  const caja = (name: string, branchId = 'yopal', address: string | null = null) =>
    ({ id: `${branchId}-${name}`, name, address, portCount: 16, branchId, branch: { name: branchId } });

  it('sin texto devuelve TODAS las de la sede, no las primeras 40', async () => {
    const naps = Array.from({ length: 508 }, (_, i) => caja(`YP_${i + 1}`));
    const { svc } = armar([...naps, caja('MOC_1', 'mocoa')]);
    const r = await svc.napsParaEquipo(undefined, 'sub-1');
    expect(r).toHaveLength(508);
    expect(r.every((n) => n.deSuSede)).toBe(true);
  });

  it('la búsqueda ignora espacios, rayas bajas y guiones del rótulo', async () => {
    const { svc } = armar([caja('VLLC _03'), caja('VLLC _04'), caja('ROS  0/0 _02', 'mocoa')]);
    expect((await svc.napsParaEquipo('vllc 03', 'sub-1')).map((n) => n.name)).toEqual(['VLLC _03']);
    expect((await svc.napsParaEquipo('ros 0/0 02', 'sub-1')).map((n) => n.name)).toEqual(['ROS  0/0 _02']);
  });

  it('al buscar trae de todas las sedes, con las del cliente primero y en orden numérico', async () => {
    const { svc } = armar([caja('CENT_10', 'mocoa'), caja('CENT_10'), caja('CENT_2')]);
    const r = await svc.napsParaEquipo('cent', 'sub-1');
    expect(r.map((n) => `${n.name}@${n.branch}`)).toEqual(['CENT_2@yopal', 'CENT_10@yopal', 'CENT_10@mocoa']);
  });

  it('cliente sin sede: salen todas', async () => {
    const naps = Array.from({ length: 1406 }, (_, i) => caja(`N_${i}`, i % 2 ? 'yopal' : 'mocoa'));
    const { svc } = armar(naps, null);
    expect(await svc.napsParaEquipo('', 'sub-1')).toHaveLength(1406);
  });
});
