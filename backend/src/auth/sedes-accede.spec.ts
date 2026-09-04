import { BadRequestException } from '../core/http/errores';
import { AuthService } from './auth.service';

/**
 * Asignación de sedes a un usuario (`User.sedesAccede`).
 *
 * La semántica es contraintuitiva y por eso se fija aquí: **lista vacía = SIN
 * restricción** (ve todas las sedes), no "ninguna sede". Es la que aplica
 * `treasury/caja-scope.ts` al filtrar, así que si alguien la cambiara sin querer,
 * un usuario pasaría de ver todo a no ver nada (o al revés) sin tocar el filtro.
 */

/** Sólo interesa `sedesAccede` del `data` que recibe Prisma. */
type DatosUsuario = { data: { sedesAccede?: number[] } };
/** De la ficha, el CSV de sedes y por qué correo se la buscó. */
type DatosStaff = { where: { email: { equals: string } }; data: { sedeAccede: string | null } };
/** El camino inverso: `sedesAccede` del `User` que casa por correo con la ficha. */
type DatosUsuarioMany = { where: { email: { equals: string } }; data: { sedesAccede: number[] } };

const SEDES = [
  { legacyId: 1, name: 'Yopal' },
  { legacyId: 2, name: 'Villanueva' },
  { legacyId: 7, name: 'Mocoa' },
];

const armar = () => {
  const branch = {
    findMany: jest.fn(({ where }: { where?: { legacyId?: { in: number[] } } } = {}) =>
      Promise.resolve(
        where?.legacyId?.in ? SEDES.filter((s) => where.legacyId!.in.includes(s.legacyId)) : SEDES,
      ),
    ),
  };
  const user = {
    findUnique: jest.fn().mockResolvedValue(null),
    // La búsqueda del correo va sin distinguir mayúsculas (`cuentaPorCorreo`).
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn((args: DatosUsuario) => Promise.resolve(args.data)),
    update: jest.fn((args: DatosUsuario) => Promise.resolve(args.data)),
    findMany: jest.fn().mockResolvedValue([]),
    updateMany: jest.fn((args: DatosUsuarioMany) => Promise.resolve(args)),
  };
  const role = { findMany: jest.fn().mockResolvedValue([]) };
  // La ficha del empleado guarda la MISMA sede en su propia columna (CSV legacy):
  // ver `sedes-staff.ts`.
  const staff = { updateMany: jest.fn((args: DatosStaff) => Promise.resolve(args)) };
  // Cuenta y ficha se guardan juntas; el doble sólo tiene que resolver la tanda.
  const $transaction = jest.fn((ops: Promise<unknown>[]) => Promise.all(ops));
  const prisma = { branch, user, role, staff, $transaction };
  // El OTP de contraseñas no entra en estas pruebas (crear/editar usuario no pide
  // código): basta un doble que estalle si alguien lo usa sin querer.
  const passwordOtp = {
    exigir: jest.fn(() => Promise.reject(new Error('no debería pedir código aquí'))),
  };
  return { svc: new AuthService(prisma as never, passwordOtp as never), user, branch, staff };
};

describe('createUser · sedes de acceso', () => {
  it('sin sedes: guarda [] = sin restricción, ve todas', async () => {
    const { svc, user } = armar();
    await svc.createUser({ email: 'a@b.c', name: 'Ana', password: 'clave-larga' });
    expect(user.create.mock.calls[0][0].data.sedesAccede).toEqual([]);
  });

  it('con sedes: las guarda deduplicadas y ordenadas', async () => {
    const { svc, user } = armar();
    await svc.createUser({
      email: 'a@b.c', name: 'Ana', password: 'clave-larga', sedesAccede: [7, 1, 7],
    });
    expect(user.create.mock.calls[0][0].data.sedesAccede).toEqual([1, 7]);
  });

  it('una sede inexistente se rechaza en vez de guardarse', async () => {
    const { svc, user } = armar();
    // Guardar un legacyId que no existe dejaría al usuario sin acceso a nada y sin
    // ninguna pista de por qué.
    await expect(
      svc.createUser({ email: 'a@b.c', name: 'Ana', password: 'clave-larga', sedesAccede: [1, 99] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(user.create).not.toHaveBeenCalled();
  });
});

describe('updateUser · sedes de acceso', () => {
  const existente = { id: 'u1', email: 'a@b.c', name: 'Ana' };

  it('omitir el campo NO toca las sedes que ya tenía', async () => {
    const { svc, user } = armar();
    user.findUnique.mockResolvedValue(existente);
    await svc.updateUser('u1', { name: 'Ana María' });
    expect(user.update.mock.calls[0][0].data.sedesAccede).toBeUndefined();
  });

  it('enviar [] quita la restricción y le devuelve todas las sedes', async () => {
    const { svc, user } = armar();
    user.findUnique.mockResolvedValue(existente);
    await svc.updateUser('u1', { sedesAccede: [] });
    expect(user.update.mock.calls[0][0].data.sedesAccede).toEqual([]);
  });

  it('acota a las sedes indicadas', async () => {
    const { svc, user } = armar();
    user.findUnique.mockResolvedValue(existente);
    await svc.updateUser('u1', { sedesAccede: [2, 1] });
    expect(user.update.mock.calls[0][0].data.sedesAccede).toEqual([1, 2]);
  });

  it('una sede inexistente se rechaza también al editar', async () => {
    const { svc, user } = armar();
    user.findUnique.mockResolvedValue(existente);
    await expect(svc.updateUser('u1', { sedesAccede: [42] })).rejects.toBeInstanceOf(BadRequestException);
    expect(user.update).not.toHaveBeenCalled();
  });
});

/**
 * Mover a alguien de sede tiene que llegar TAMBIÉN a su ficha (`Staff.sedeAccede`):
 * es la columna que miran la agenda y el traspaso de material para decidir a qué
 * técnicos le ofrecen a una cajera. Sin esto, mover a un técnico le cambiaba lo que
 * él ve pero no de qué sede ES, y la cajera de su sede nueva no lo encontraba.
 */
describe('updateUser · la sede llega a la ficha del empleado', () => {
  const existente = { id: 'u1', email: 'a@b.c', name: 'Ana' };

  it('guarda el CSV del legacy en la ficha que casa por correo', async () => {
    const { svc, user, staff } = armar();
    user.findUnique.mockResolvedValue(existente);
    await svc.updateUser('u1', { sedesAccede: [2] });
    expect(staff.updateMany).toHaveBeenCalledTimes(1);
    expect(staff.updateMany.mock.calls[0][0].data.sedeAccede).toBe('-2-');
    expect(staff.updateMany.mock.calls[0][0].where.email.equals).toBe('a@b.c');
  });

  it('quitar la restricción deja la ficha sin sede (= la ven todas las cajeras)', async () => {
    const { svc, user, staff } = armar();
    user.findUnique.mockResolvedValue(existente);
    await svc.updateUser('u1', { sedesAccede: [] });
    expect(staff.updateMany.mock.calls[0][0].data.sedeAccede).toBeNull();
  });

  it('editar sólo el nombre NO toca la sede de la ficha', async () => {
    const { svc, user, staff } = armar();
    user.findUnique.mockResolvedValue(existente);
    await svc.updateUser('u1', { name: 'Ana María' });
    expect(staff.updateMany).not.toHaveBeenCalled();
  });

  it('al cambiar el correo, la ficha se busca por el nuevo', async () => {
    const { svc, user, staff } = armar();
    user.findUnique.mockResolvedValue(existente);
    await svc.updateUser('u1', { email: 'Nuevo@B.C', sedesAccede: [7] });
    expect(staff.updateMany.mock.calls[0][0].where.email.equals).toBe('nuevo@b.c');
  });
});

/**
 * El camino inverso: `StaffService.update` (PATCH /staff/:id) también puede tocar
 * `Staff.sedeAccede` directamente, y `reflejarSedesDesdeStaff` es lo que usa para
 * que esa edición llegue igual a `User.sedesAccede` — si no, el mismo hueco
 * reaparece al revés.
 */
describe('reflejarSedesDesdeStaff', () => {
  it('traduce el CSV del legacy a la lista que guarda User.sedesAccede', async () => {
    const { svc, user } = armar();
    await svc.reflejarSedesDesdeStaff('a@b.c', '-2-,-4-');
    expect(user.updateMany).toHaveBeenCalledTimes(1);
    expect(user.updateMany.mock.calls[0][0].data.sedesAccede).toEqual([2, 4]);
    expect(user.updateMany.mock.calls[0][0].where.email.equals).toBe('a@b.c');
  });

  it('NULL en la ficha (sin sede) quita la restricción de la cuenta', async () => {
    const { svc, user } = armar();
    await svc.reflejarSedesDesdeStaff('a@b.c', null);
    expect(user.updateMany.mock.calls[0][0].data.sedesAccede).toEqual([]);
  });

  it('sin correo, no hay a quién buscarle la cuenta', async () => {
    const { svc, user } = armar();
    await svc.reflejarSedesDesdeStaff('', '-2-');
    expect(user.updateMany).not.toHaveBeenCalled();
  });
});
