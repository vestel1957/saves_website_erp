import { StaffService } from './staff.service';

/**
 * Las dos puntas por donde la sede de la ficha del empleado (`Staff.sedeAccede`)
 * y la de su cuenta de acceso (`User.sedesAccede`) se pueden desincronizar, más
 * allá de la que ya cubre `auth/sedes-accede.spec.ts` (editar desde Usuarios):
 *
 *  · Crear la cuenta de acceso de un empleado que YA tenía sede en su ficha
 *    (`createAccount`): sin heredarla, la cuenta nace sin restricción.
 *  · Editar la sede DIRECTAMENTE en la ficha (`update`, PATCH /staff/:id): sin
 *    propagarla, la cuenta se queda con la sede vieja — el mismo hueco que dejó
 *    sin ver a Cristhian Mahecha, al revés.
 */

const STAFF = {
  id: 's1', name: 'Cristhian Mahecha', email: 'mahecha@vestel.com.co',
  sedeAccede: '-3-', lastLogin: null,
};

const armar = () => {
  const staff = {
    findUnique: jest.fn().mockResolvedValue(STAFF),
    // Como Prisma real: una clave con valor `undefined` no toca la columna.
    update: jest.fn((args: { data: Record<string, unknown> }) => {
      const cambios = Object.fromEntries(Object.entries(args.data).filter(([, v]) => v !== undefined));
      return Promise.resolve({ ...STAFF, ...cambios });
    }),
  };
  const user = { findFirst: jest.fn().mockResolvedValue(null) };
  const branch = { findMany: jest.fn().mockResolvedValue([]) };
  const prisma = { staff, user, branch };
  const auth = {
    createUser: jest.fn().mockResolvedValue({ id: 'u1' }),
    reflejarSedesDesdeStaff: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { svc: new StaffService(prisma as never, auth as never, audit as never), staff, auth };
};

describe('createAccount · hereda la sede de la ficha', () => {
  it('la cuenta nueva nace acotada a la sede que ya tenía el empleado', async () => {
    const { svc, auth } = armar();
    await svc.createAccount('s1', {});
    expect(auth.createUser).toHaveBeenCalledTimes(1);
    expect(auth.createUser.mock.calls[0][0].sedesAccede).toEqual([3]);
  });

  it('sin sede en la ficha, la cuenta nace sin restricción (como antes)', async () => {
    const { svc, auth, staff } = armar();
    staff.findUnique.mockResolvedValue({ ...STAFF, sedeAccede: null });
    await svc.createAccount('s1', {});
    expect(auth.createUser.mock.calls[0][0].sedesAccede).toEqual([]);
  });
});

describe('update · la sede editada en la ficha llega a la cuenta', () => {
  it('cambiar Staff.sedeAccede propaga a User.sedesAccede por el correo', async () => {
    const { svc, auth } = armar();
    await svc.update('s1', { sedeAccede: '-4-' });
    expect(auth.reflejarSedesDesdeStaff).toHaveBeenCalledWith(STAFF.email, '-4-');
  });

  it('editar otro campo (no la sede) no toca la cuenta', async () => {
    const { svc, auth } = armar();
    await svc.update('s1', { city: 'Yopal' });
    expect(auth.reflejarSedesDesdeStaff).not.toHaveBeenCalled();
  });

  it('borrar la sede (cadena vacía → NULL) también se propaga', async () => {
    const { svc, auth } = armar();
    await svc.update('s1', { sedeAccede: '' });
    expect(auth.reflejarSedesDesdeStaff).toHaveBeenCalledWith(STAFF.email, null);
  });
});
