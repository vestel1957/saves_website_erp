import { diaDelPago, pagosAnterioresAlCorte } from './pago-anterior-al-corte';

const orden = (id: string, subscriberId: string, diaPago: string) => ({ id, subscriberId, diaPago });
const corte = (subscriberId: string, dia: string) => ({ subscriberId, created: new Date(`${dia}T00:00:00Z`) });

describe('pagosAnterioresAlCorte', () => {
  it('descarta el pago de julio cuando lo cortaron después por agosto (abonado 53495)', () => {
    const r = pagosAnterioresAlCorte(
      [orden('o1', 's1', '2026-07-30')],
      [corte('s1', '2026-07-23'), corte('s1', '2026-08-24')],
    );
    expect([...r]).toEqual(['o1']);
  });

  it('deja pasar el pago posterior al corte', () => {
    const r = pagosAnterioresAlCorte([orden('o1', 's1', '2026-08-10')], [corte('s1', '2026-07-23')]);
    expect(r.size).toBe(0);
  });

  it('el mismo día no cuenta como anterior: cortado por la mañana, pagó por la tarde', () => {
    const r = pagosAnterioresAlCorte([orden('o1', 's1', '2026-08-24')], [corte('s1', '2026-08-24')]);
    expect(r.size).toBe(0);
  });

  it('sin cortes no descarta nada, y cada orden se mira por su abonado', () => {
    const r = pagosAnterioresAlCorte(
      [orden('o1', 's1', '2026-07-30'), orden('o2', 's2', '2026-07-30'), orden('o3', 's1', '2026-08-25')],
      [corte('s1', '2026-08-24'), { subscriberId: null, created: new Date('2026-09-01T00:00:00Z') }],
    );
    expect([...r]).toEqual(['o1']);
  });
});

describe('diaDelPago', () => {
  it('toma el día del texto del portal, no del instante corrido por la zona del proceso', () => {
    // Portal: 00:30 del 24-08 en Colombia. Leído como hora de Berlín quedó el 23 a las 22:30 UTC.
    expect(diaDelPago({ fecha: '2026-08-24 00:30:00' }, new Date('2026-08-23T22:30:00Z'))).toBe('2026-08-24');
  });

  it('sin fecha del portal usa createdAt', () => {
    expect(diaDelPago(null, new Date('2026-07-30T10:47:10Z'))).toBe('2026-07-30');
    expect(diaDelPago({ fecha: 42 }, new Date('2026-07-30T10:47:10Z'))).toBe('2026-07-30');
  });
});
