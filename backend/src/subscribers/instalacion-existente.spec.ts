import { completarOrdenAdoptada } from './instalacion-existente';

/**
 * Qué se le añade a una orden de instalación ADOPTADA (la que abrió el sistema anterior
 * al cobrarse la afiliación por el portal).
 *
 * El detalle que importa: la que nace allá trae en `section` los servicios contratados
 * —y cuando el abonado no tiene ni TV ni plan que enseñar, un `'+'` suelto, que es su
 * manera de escribir «nada»—. Pisar eso perdería dato; no añadir nada dejaría al técnico
 * sin dirección.
 */
describe('completar la orden de instalación adoptada', () => {
  const contexto = 'Dirección: CL 1\nTecnología: GPON\nUsuario PPPoE: PEPE1';

  it('añade el contexto debajo de lo que ya escribió el legacy', () => {
    const r = completarOrdenAdoptada({ section: 'TV + 100 MEGAS', problem: null }, contexto);
    expect(r.section).toBe(`TV + 100 MEGAS\n${contexto}`);
    expect(r.problem).toBe('Instalación de servicio nuevo');
  });

  it("trata el '+' del legacy como vacío, no como dato", () => {
    expect(completarOrdenAdoptada({ section: '+', problem: null }, contexto).section).toBe(contexto);
    expect(completarOrdenAdoptada({ section: null, problem: null }, contexto).section).toBe(contexto);
  });

  it('no repite el contexto si la orden ya lo lleva (barridos sucesivos)', () => {
    const r = completarOrdenAdoptada({ section: contexto, problem: 'Instalación de servicio nuevo' }, contexto);
    expect(r).toEqual({});
  });

  it('respeta el motivo que ya tuviera la orden', () => {
    const r = completarOrdenAdoptada({ section: 'TV', problem: 'Reinstalación acordada' }, null);
    expect(r.problem).toBeUndefined();
    expect(r.section).toBeUndefined();
  });
});
