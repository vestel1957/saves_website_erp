/**
 * La conversión de hora colombiana que usan los DOS sentidos de la caja.
 *
 * No es un test de cortesía: el writeback escribe `finicial`/`hinicial` en el legacy y la
 * ida los relee para crear la apertura de este lado. Si las dos puntas no coinciden al
 * minuto, la apertura no casa nunca y las dos direcciones se pisan en bucle. El servidor
 * corre en Europe/Berlin, así que un `new Date('...T07:22:00')` a secas se iría 7 horas.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- los scripts del sync son JS puro (corren sin build), no hay módulo TS que importar
const horaCo = require('../../scripts/lib/hora-co');

describe('hora-co (scripts)', () => {
  it('convierte una hora de Colombia al instante real (UTC-5)', () => {
    // 7:22 en Villanueva son las 12:22 UTC: es la apertura real del 27-ago-2026.
    expect(horaCo.INSTANTE_CO('2026-08-27', '07:22:00').toISOString())
      .toBe('2026-08-27T12:22:00.000Z');
  });

  it('acepta las horas que devuelve el legacy con y sin segundos', () => {
    expect(horaCo.INSTANTE_CO('2026-08-27', '07:22').toISOString())
      .toBe('2026-08-27T12:22:00.000Z');
    // Sin hora (la columna admite NULL) cae a medianoche colombiana, no a la del servidor.
    expect(horaCo.INSTANTE_CO('2026-08-27', null).toISOString())
      .toBe('2026-08-27T05:00:00.000Z');
  });

  it('da la fecha y la hora colombianas de un instante, no las del servidor', () => {
    const instante = new Date('2026-08-27T12:22:00.000Z');
    expect(horaCo.FECHA_CO(instante)).toBe('2026-08-27');
    expect(horaCo.HORA_CO(instante)).toBe('07:22:00');
    expect(horaCo.HORA_CO_AMPM(instante)).toBe('7:22 am');
  });

  it('el día colombiano no se adelanta con el vuelco de UTC', () => {
    // 03:00 UTC del 28 son todavía las 22:00 del 27 en Colombia: el cierre de caja de esa
    // noche pertenece al día anterior, y confundirlo mueve la plata de día.
    expect(horaCo.FECHA_CO(new Date('2026-08-28T03:00:00.000Z'))).toBe('2026-08-27');
  });

  it('ida y vuelta: lo que se escribe en el legacy vuelve al mismo instante', () => {
    const abierta = new Date('2026-08-27T12:48:00.000Z');
    const fecha = horaCo.FECHA_CO(abierta);
    const hora = horaCo.HORA_CO(abierta);
    expect(horaCo.INSTANTE_CO(fecha, hora).getTime()).toBe(abierta.getTime());
  });

  it('DIA_UTC da la medianoche que espera una columna `date` de Postgres', () => {
    expect(horaCo.DIA_UTC('2026-08-27').toISOString()).toBe('2026-08-27T00:00:00.000Z');
  });
});
