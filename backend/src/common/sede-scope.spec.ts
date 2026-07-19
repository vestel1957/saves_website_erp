import { ForbiddenException } from '@nestjs/common';
import { AuthUser } from '../auth/current-user.decorator';
import {
  sedesDe,
  whereSedeSuscriptor,
  whereSedePorSuscriptor,
  exigirSedeSuscriptor,
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
