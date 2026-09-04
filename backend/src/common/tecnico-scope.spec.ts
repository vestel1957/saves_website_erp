import { AuthUser } from '../auth/current-user.decorator';
import { bodegaMaterialDelTecnico } from './tecnico-scope';

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
