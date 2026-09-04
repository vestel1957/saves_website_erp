import { variosDeQuery } from './filtros-query';

describe('variosDeQuery', () => {
  it('un solo valor se comporta como siempre (enlaces viejos)', () => {
    expect(variosDeQuery('PENDIENTE')).toEqual(['PENDIENTE']);
  });

  it('parte por comas y limpia espacios', () => {
    expect(variosDeQuery('PENDIENTE, REALIZANDO')).toEqual(['PENDIENTE', 'REALIZANDO']);
  });

  it('sin filtro = lista vacía (no un valor vacío que filtraría por nada)', () => {
    expect(variosDeQuery(undefined)).toEqual([]);
    expect(variosDeQuery('')).toEqual([]);
    expect(variosDeQuery(' , ,')).toEqual([]);
  });

  it('quita repetidos', () => {
    expect(variosDeQuery('Alta,Alta,Media')).toEqual(['Alta', 'Media']);
  });

  it('acepta el parámetro repetido, que Express entrega como array', () => {
    expect(variosDeQuery(['Alta', 'Media,Baja'])).toEqual(['Alta', 'Media', 'Baja']);
  });

  it('topa la cantidad: la URL no puede pedir un IN sin fin', () => {
    const muchos = Array.from({ length: 200 }, (_, i) => `v${i}`).join(',');
    expect(variosDeQuery(muchos)).toHaveLength(50);
  });
});
