import { AuthUser } from '../auth/current-user.decorator';
import { bodegaMaterialDelTecnico, esClienteDeSuOrden, whereSuscriptoresDeSusOrdenes } from './tecnico-scope';

/**
 * El vínculo técnico ↔ bodega personal.
 *
 * Es la pieza de la que cuelga todo lo que un técnico puede hacer con material:
 * el buscador de la orden, el descuento de stock y la lista de a quién puede
 * entregarle la cajera. Se rompió una vez de la peor manera —en silencio— porque
 * sólo miraba el `username`, un dato del legacy que los empleados dados de alta en
 * nexus no tienen: el técnico entraba, veía su agenda y no podía gastar nada.
 */

const usuario = (): AuthUser =>
  ({ id: 'u1', email: 'darwin@vestel.com.co', name: 'Darwin Orlando Villamizar', permissions: [], roles: [] }) as unknown as AuthUser;

const prismaCon = (ficha: { name: string; username: string | null } | null, technicianRef: string | null) =>
  ({
    staff: { findFirst: jest.fn().mockResolvedValue(ficha ? { id: 's1', ...ficha } : null) },
    materialWarehouse: {
      findMany: jest.fn().mockResolvedValue([{ id: 'w1', title: 'Almacen Darwin', technicianRef }]),
    },
  }) as never;

describe('bodegaMaterialDelTecnico', () => {
  it('casa por username, como las 35 bodegas heredadas del legacy', async () => {
    const b = await bodegaMaterialDelTecnico(prismaCon({ name: 'Darwin Orlando Villamizar', username: 'DarwinVillamizar' }, 'DarwinVillamizar'), usuario());
    expect(b?.id).toBe('w1');
  });

  it('casa por NOMBRE cuando la bodega se creó aquí y el empleado no trae username', async () => {
    const b = await bodegaMaterialDelTecnico(prismaCon({ name: 'Darwin Orlando Villamizar', username: null }, 'Darwin Orlando Villamizar'), usuario());
    expect(b?.id).toBe('w1');
  });

  it('ignora espacios y mayúsculas de la captura del legacy ("OmarTec ")', async () => {
    const b = await bodegaMaterialDelTecnico(prismaCon({ name: 'Omar Jose Balcazar', username: 'OmarTec' }, ' omartec '), usuario());
    expect(b?.id).toBe('w1');
  });

  it('sin ficha de empleado no hay bodega: no se le abre la de otro', async () => {
    expect(await bodegaMaterialDelTecnico(prismaCon(null, 'DarwinVillamizar'), usuario())).toBeNull();
  });

  it('la bodega de un compañero no es suya', async () => {
    expect(await bodegaMaterialDelTecnico(prismaCon({ name: 'Darwin Orlando Villamizar', username: null }, 'OmarTec'), usuario())).toBeNull();
  });
});

/**
 * "Sólo los clientes de MIS órdenes" (2026-09-10).
 *
 * Lo que se fija aquí es el criterio de "suya": la FK **y** el texto libre del
 * legacy. Mirar sólo la FK le cerraría la ficha de media cola —la mitad de las
 * órdenes de los técnicos veteranos llevan el nombre escrito y no el id— y el
 * síntoma sería un 403 al abrir el cliente de su propia visita.
 */
const prismaClientes = (ficha: { name: string; username: string | null } | null, orden: unknown) =>
  ({
    staff: { findFirst: jest.fn().mockResolvedValue(ficha ? { id: 's1', ...ficha } : null) },
    ticket: { findFirst: jest.fn().mockResolvedValue(orden) },
  }) as never;

const TECNICO = { id: 'u1', email: 'darwin@vestel.com.co', name: 'Darwin Orlando Villamizar', permissions: ['area.tecnicos'], roles: [] } as unknown as AuthUser;
const FICHA = { name: 'Darwin Orlando Villamizar', username: 'DarwinVillamizar' };

describe('esClienteDeSuOrden', () => {
  it('sí cuando el abonado tiene una orden suya', async () => {
    await expect(esClienteDeSuOrden(prismaClientes(FICHA, { id: 't1' }), TECNICO, 'sub-1')).resolves.toBe(true);
  });

  it('no cuando no la tiene: la ficha del cliente ajeno no se le abre', async () => {
    await expect(esClienteDeSuOrden(prismaClientes(FICHA, null), TECNICO, 'sub-1')).resolves.toBe(false);
  });

  it('busca por la FK Y por el texto libre del legacy (son la misma persona)', async () => {
    const prisma = prismaClientes(FICHA, { id: 't1' });
    await esClienteDeSuOrden(prisma, TECNICO, 'sub-1');
    const where = (prisma as any).ticket.findFirst.mock.calls[0][0].where;
    expect(where.subscriberId).toBe('sub-1');
    expect(where.OR).toEqual([
      { assignedStaffId: 's1' },
      { assigned: { in: ['Darwin Orlando Villamizar', 'DarwinVillamizar'] } },
    ]);
  });

  it('sin ficha de empleado no es de nadie (lado seguro)', async () => {
    await expect(esClienteDeSuOrden(prismaClientes(null, { id: 't1' }), TECNICO, 'sub-1')).resolves.toBe(false);
  });
});

describe('whereSuscriptoresDeSusOrdenes', () => {
  it('a quien no es técnico de campo no se le acota nada', async () => {
    const otro = { ...TECNICO, permissions: ['area.administracion'] } as AuthUser;
    await expect(whereSuscriptoresDeSusOrdenes(prismaClientes(FICHA, null), otro)).resolves.toBeNull();
  });

  it('al técnico se le acota a los abonados con orden suya', async () => {
    const w = await whereSuscriptoresDeSusOrdenes(prismaClientes(FICHA, null), TECNICO);
    expect(w).toEqual({
      tickets: {
        some: {
          OR: [
            { assignedStaffId: 's1' },
            { assigned: { in: ['Darwin Orlando Villamizar', 'DarwinVillamizar'] } },
          ],
        },
      },
    });
  });

  it('sin ficha, filtro imposible y no la lista entera', async () => {
    const w = await whereSuscriptoresDeSusOrdenes(prismaClientes(null, null), TECNICO);
    expect(w).toEqual({ id: { in: [] } });
  });
});
