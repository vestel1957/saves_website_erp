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
    create: jest.fn((args: DatosUsuario) => Promise.resolve(args.data)),
    update: jest.fn((args: DatosUsuario) => Promise.resolve(args.data)),
    findMany: jest.fn().mockResolvedValue([]),
  };
  const role = { findMany: jest.fn().mockResolvedValue([]) };
  const prisma = { branch, user, role };
  // El OTP de contraseñas no entra en estas pruebas (crear/editar usuario no pide
  // código): basta un doble que estalle si alguien lo usa sin querer.
  const passwordOtp = {
    exigir: jest.fn(() => Promise.reject(new Error('no debería pedir código aquí'))),
  };
  return { svc: new AuthService(prisma as never, passwordOtp as never), user, branch };
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
