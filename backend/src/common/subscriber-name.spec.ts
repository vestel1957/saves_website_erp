import { subName, displayName, SubscriberNameParts } from './subscriber-name';

const base: SubscriberNameParts = {
  firstName: null,
  secondName: null,
  lastName1: null,
  lastName2: null,
  companyName: null,
  fullName: null,
};

describe('subName', () => {
  it('devuelve null cuando la entrada es null/undefined', () => {
    expect(subName(null)).toBeNull();
    expect(subName(undefined)).toBeNull();
  });

  it('prioriza fullName (recortado) sobre todo lo demás', () => {
    expect(subName({ ...base, fullName: '  Juan Pérez  ', firstName: 'Otro' })).toBe('Juan Pérez');
  });

  it('compone nombre + apellidos ignorando vacíos', () => {
    expect(
      subName({ ...base, firstName: 'Ana', secondName: '', lastName1: 'Gómez', lastName2: null }),
    ).toBe('Ana Gómez');
  });

  it('cae a la razón social cuando no hay nombre de persona', () => {
    expect(subName({ ...base, companyName: 'ACME S.A.S' })).toBe('ACME S.A.S');
  });

  it('devuelve null cuando no hay ningún dato de nombre', () => {
    expect(subName(base)).toBeNull();
  });
});

describe('displayName', () => {
  it('usa el texto de reserva por defecto', () => {
    expect(displayName(base)).toBe('Sin nombre');
  });

  it('permite un texto de reserva personalizado', () => {
    expect(displayName(base, 'N/D')).toBe('N/D');
  });

  it('devuelve el nombre cuando existe', () => {
    expect(displayName({ ...base, fullName: 'Pedro' })).toBe('Pedro');
  });
});
