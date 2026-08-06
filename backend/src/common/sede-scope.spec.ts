import { ForbiddenException } from '../core/http/errores';
import { AuthUser } from '../auth/current-user.decorator';
import {
  sedesDe,
  whereSedeSuscriptor,
  whereSedePorSuscriptor,
  exigirSedeSuscriptor,
  exigirSedeDestino,
  esCajeraPura,
} from './sede-scope';

/**
 * Alcance por sede. La regla que se fija aquí —**lista vacía = SIN restricción**—
 * es la misma de `treasury/caja-scope.ts`; invertirla por descuido convertiría a
 * todos los usuarios en ciegos (o a los acotados en omniscientes) sin que nadie
 * tocara un solo `where`.
 */

const usuario = (permissions: string[] = []): AuthUser =>
  ({ id: 'u1', permissions, roles: [] }) as unknown as AuthUser;

const prismaCon = (sedesAccede: number[] | null, sub?: { branch: { legacyId: number } | null } | null) =>
  ({
    user: { findUnique: jest.fn().mockResolvedValue(sedesAccede === null ? null : { sedesAccede }) },
    subscriber: { findUnique: jest.fn().mockResolvedValue(sub ?? null) },
  }) as never;

describe('sedesDe', () => {
  it('sin sedes asignadas devuelve null = sin límite', async () => {
    expect(await sedesDe(prismaCon([]), usuario())).toBeNull();
  });

  it('con sedes asignadas devuelve la lista', async () => {
    expect(await sedesDe(prismaCon([2, 5]), usuario())).toEqual([2, 5]);
  });

  it('el superusuario nunca queda acotado, aunque tenga sedes', async () => {
    expect(await sedesDe(prismaCon([2]), usuario(['system.admin']))).toBeNull();
  });

  it('sin usuario (procesos internos) no filtra', async () => {
    expect(await sedesDe(prismaCon([2]), undefined)).toBeNull();
  });

  it('usa el alcance ya resuelto en la sesión sin volver a la BD', async () => {
    const prisma = prismaCon([7]); // la BD diría 7; la sesión manda
    const u = { ...usuario(), sedes: [3] } as AuthUser;
    expect(await sedesDe(prisma, u)).toEqual([3]);
    expect((prisma as any).user.findUnique).not.toHaveBeenCalled();
  });

  it('sesión con alcance vacío = sin límite (y tampoco consulta)', async () => {
    const prisma = prismaCon([7]);
    const u = { ...usuario(), sedes: [] } as AuthUser;
    expect(await sedesDe(prisma, u)).toBeNull();
    expect((prisma as any).user.findUnique).not.toHaveBeenCalled();
  });
});

describe('resolverSedes — respaldo por la caja asignada', () => {
  // Hay cajeras activas sin `sedesAccede` cargado: si sólo se mirara esa lista,
  // la vacía significaría "todas" y verían la empresa entera.
  const prismaConCaja = (sedesAccede: number[], cajaLegacyId: number | null, branchLegacy: number | null) =>
    ({
      user: { findUnique: jest.fn().mockResolvedValue({ sedesAccede, cajaLegacyId }) },
      cashAccount: { findUnique: jest.fn().mockResolvedValue(branchLegacy === null ? null : { branchLegacy }) },
    }) as never;

  it('a la cajera sin sedes marcadas la acota la sede de su caja', async () => {
    const prisma = prismaConCaja([], 12, 3);
    expect(await sedesDe(prisma, usuario(['area.caja']))).toEqual([3]);
  });

  it('a contabilidad NO la acota su caja: trabaja sobre todas las sedes', async () => {
    const prisma = prismaConCaja([], 12, 3);
    expect(await sedesDe(prisma, usuario(['area.caja', 'area.contabilidad']))).toBeNull();
  });

  it('una caja de banco (sede 0) no aporta alcance', async () => {
    const prisma = prismaConCaja([], 99, 0);
    expect(await sedesDe(prisma, usuario(['area.caja']))).toBeNull();
  });

  it('las sedes marcadas mandan sobre la caja', async () => {
    const prisma = prismaConCaja([5], 12, 3);
    expect(await sedesDe(prisma, usuario(['area.caja']))).toEqual([5]);
  });
});

describe('esCajeraPura', () => {
  it('el área de caja sola sí acota', () => {
    expect(esCajeraPura(['area.caja'])).toBe(true);
  });

  it('con un área de mando, o siendo superusuario, no', () => {
    expect(esCajeraPura(['area.caja', 'area.gerencia'])).toBe(false);
    expect(esCajeraPura(['area.caja', 'system.admin'])).toBe(false);
  });
});

describe('exigirSedeDestino', () => {
  const prismaConBranch = (sedesAccede: number[], legacyId: number | null) =>
    ({
      user: { findUnique: jest.fn().mockResolvedValue({ sedesAccede, cajaLegacyId: null }) },
      branch: { findUnique: jest.fn().mockResolvedValue(legacyId === null ? null : { legacyId }) },
    }) as never;

  it('deja pasar a quien no está acotado', async () => {
    await expect(exigirSedeDestino(prismaConBranch([], 9), usuario(), 'b9')).resolves.toBeUndefined();
  });

  it('deja crear en una sede suya', async () => {
    await expect(exigirSedeDestino(prismaConBranch([3], 3), usuario(), 'b3')).resolves.toBeUndefined();
  });

  it('bloquea mandar el cliente a otra sede aunque el selector no la ofrezca', async () => {
    await expect(exigirSedeDestino(prismaConBranch([3], 9), usuario(), 'b9')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a un usuario acotado no le vale dejar el cliente sin sede', async () => {
    await expect(exigirSedeDestino(prismaConBranch([3], 3), usuario(), null)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('si no se toca la sede (undefined) no se exige nada', async () => {
    await expect(exigirSedeDestino(prismaConBranch([3], 3), usuario(), undefined)).resolves.toBeUndefined();
  });
});

describe('condiciones de where', () => {
  it('sin límite no añade condición: no estorba a los índices', () => {
    expect(whereSedeSuscriptor(null)).toEqual({});
    expect(whereSedePorSuscriptor(null)).toEqual({});
  });

  it('acotado filtra por la relación, no por branchId', () => {
    // `sedesAccede` son legacyId (enteros) y `Subscriber.branchId` es un cuid:
    // compararlos directamente no casaría nunca y el filtro sería inútil.
    expect(whereSedeSuscriptor([1, 3])).toEqual({ branch: { legacyId: { in: [1, 3] } } });
    expect(whereSedePorSuscriptor([1, 3])).toEqual({
      subscriber: { branch: { legacyId: { in: [1, 3] } } },
    });
  });
});

describe('exigirSedeSuscriptor', () => {
  it('deja pasar a quien no está acotado', async () => {
    await expect(exigirSedeSuscriptor(prismaCon([]), usuario(), 's1')).resolves.toBeUndefined();
  });

  it('deja pasar si el cliente es de una sede suya', async () => {
    const prisma = prismaCon([2, 5], { branch: { legacyId: 5 } });
    await expect(exigirSedeSuscriptor(prisma, usuario(), 's1')).resolves.toBeUndefined();
  });

  it('bloquea si el cliente es de otra sede', async () => {
    const prisma = prismaCon([2], { branch: { legacyId: 9 } });
    await expect(exigirSedeSuscriptor(prisma, usuario(), 's1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('bloquea si el cliente no tiene sede: ante la duda, no enseñar', async () => {
    const prisma = prismaCon([2], { branch: null });
    await expect(exigirSedeSuscriptor(prisma, usuario(), 's1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('un cliente inexistente NO se convierte en 403', async () => {
    // Devolver 403 en vez de dejar que el servicio lance su 404 revelaría si el id
    // existe o no, que es justo lo que un atacante quiere saber.
    const prisma = prismaCon([2], null);
    await expect(exigirSedeSuscriptor(prisma, usuario(), 'no-existe')).resolves.toBeUndefined();
  });
});
