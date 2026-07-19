import { esCajera, puedeVer, SEDE_BANCO, AlcanceCajas } from './caja-scope';
import { AuthUser } from '../auth/current-user.decorator';

/** AuthUser mínimo: sólo `permissions` influye en el alcance. */
const usuario = (permissions: string[]): AuthUser =>
  ({ id: 'u1', permissions, roles: [] }) as unknown as AuthUser;

const alcance = (p: Partial<AlcanceCajas> = {}): AlcanceCajas => ({
  todas: false,
  caja: null,
  sedes: [],
  ...p,
});

describe('esCajera', () => {
  it('es cajera quien tiene area.caja y nada por encima', () => {
    expect(esCajera(usuario(['area.caja']))).toBe(true);
  });

  it('el superusuario nunca es cajera, aunque tenga area.caja', () => {
    expect(esCajera(usuario(['area.caja', 'system.admin']))).toBe(false);
  });

  it.each(['area.contabilidad', 'area.administracion', 'area.gerencia'])(
    'un área de mando (%s) manda sobre la restricción de cajera',
    (mando) => {
      expect(esCajera(usuario(['area.caja', mando]))).toBe(false);
    },
  );

  it('quien no tiene area.caja no es cajera (pero tampoco queda acotado por aquí)', () => {
    expect(esCajera(usuario(['area.tecnicos']))).toBe(false);
  });

  it('no revienta si el usuario viene sin permisos', () => {
    expect(esCajera(usuario([]))).toBe(false);
    expect(esCajera(undefined as unknown as AuthUser)).toBe(false);
  });

  it('compara contra la CLAVE del permiso, no contra el nombre para mostrar', () => {
    // resolveUser() mete en `roles` el nombre visible ('Caja y ventas'); si la
    // comprobación mirase ahí, la restricción no se aplicaría jamás.
    expect(esCajera(usuario(['Caja y ventas']))).toBe(false);
  });
});

describe('puedeVer', () => {
  it('los bancos (sede 0) los ve todo el mundo: sin ellos no se consolida un cierre', () => {
    expect(puedeVer(alcance({ caja: 7 }), 99, SEDE_BANCO)).toBe(true);
  });

  it('una cajera ve su caja', () => {
    expect(puedeVer(alcance({ caja: 7 }), 7, 3)).toBe(true);
  });

  it('una cajera NO ve la caja de otra sede', () => {
    expect(puedeVer(alcance({ caja: 7 }), 8, 3)).toBe(false);
  });

  it('una cajera SIN caja asignada no ve ninguna caja de sede (sólo bancos)', () => {
    // Lado seguro y fiel al legacy: ante la duda, no enseñar el efectivo de otra sede.
    expect(puedeVer(alcance({ caja: null }), 7, 3)).toBe(false);
    expect(puedeVer(alcance({ caja: null }), 7, SEDE_BANCO)).toBe(true);
  });

  it('quien ve todas y no tiene sedes acotadas, ve cualquier caja', () => {
    expect(puedeVer(alcance({ todas: true }), 42, 9)).toBe(true);
  });

  it('sedesAccede acota TAMBIÉN a quien "ve todas"', () => {
    const a = alcance({ todas: true, sedes: [1, 2] });
    expect(puedeVer(a, 42, 1)).toBe(true);
    expect(puedeVer(a, 42, 3)).toBe(false);
  });

  it('con sedesAccede, una caja sin sede conocida se niega', () => {
    expect(puedeVer(alcance({ todas: true, sedes: [1] }), 42, null)).toBe(false);
  });

  it('sedesAccede vacío significa sin límite, no "ninguna sede"', () => {
    expect(puedeVer(alcance({ todas: true, sedes: [] }), 42, 5)).toBe(true);
  });

  it('una caja derivada (sin sede) la ve su dueña', () => {
    expect(puedeVer(alcance({ caja: 7 }), 7, null)).toBe(true);
  });
});
