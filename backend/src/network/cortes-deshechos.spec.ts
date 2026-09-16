import { candidatosDeCorte, cortesDeshechos, type ListasDelRouter } from './cortes-deshechos';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const corte = (subscriberId: string, legacyId: number, dia: string, sede: number | null = 3) =>
  ({ subscriberId, abonado: legacyId + 40000, legacyId, sede, created: d(dia) });
const listas = (router: string, sede: number | null, activos: string[], morosos: string[]): ListasDelRouter => ({
  router,
  sede,
  activos: new Map(activos.map((c) => [c, 'sep/01/2026 19:18:24'])),
  morosos: new Set(morosos),
});

describe('candidatosDeCorte', () => {
  it('cortado por mora, sin reconexión y debiendo: sigue cortado (abonado 51993)', () => {
    const r = candidatosDeCorte([corte('s1', 16604, '2026-08-24')], [], [{ subscriberId: 's1', pendiente: 55194 }]);
    expect(r).toEqual([expect.objectContaining({ subscriberId: 's1', legacyId: 16604, sede: 3, deudaVencida: 55194 })]);
  });

  it('una reconexión el mismo día o después lo saca', () => {
    const vencida = [{ subscriberId: 's1', pendiente: 50000 }];
    expect(candidatosDeCorte([corte('s1', 1, '2026-08-24')], [{ subscriberId: 's1', created: d('2026-08-24') }], vencida)).toEqual([]);
    expect(candidatosDeCorte([corte('s1', 1, '2026-08-24')], [{ subscriberId: 's1', created: d('2026-08-28') }], vencida)).toEqual([]);
  });

  it('una reconexión VIEJA no borra un corte nuevo', () => {
    const r = candidatosDeCorte(
      [corte('s1', 1, '2026-07-23'), corte('s1', 1, '2026-08-24')],
      [{ subscriberId: 's1', created: d('2026-08-06') }],
      [{ subscriberId: 's1', pendiente: 50000 }],
    );
    expect(r.map((x) => x.corte)).toEqual([d('2026-08-24')]);
  });

  it('sin deuda vencida o con un saldo de redondeo no cuenta (abonado 55677, $3.850)', () => {
    expect(candidatosDeCorte([corte('s1', 1, '2026-08-24')], [], [])).toEqual([]);
    expect(candidatosDeCorte([corte('s1', 1, '2026-08-24')], [], [{ subscriberId: 's1', pendiente: 3850 }])).toEqual([]);
  });
});

describe('cortesDeshechos', () => {
  const cand = [{ subscriberId: 's1', abonado: 51993, legacyId: 16604, sede: 3, corte: d('2026-08-24'), deudaVencida: 55194 }];

  it('en ACTIVOS y en ningún MOROSOS: navega', () => {
    const r = cortesDeshechos(cand, [listas('Ip_Villanueva_EOC', 3, ['activo_16604'], [])]);
    expect(r).toEqual([expect.objectContaining({ abonado: 51993, router: 'Ip_Villanueva_EOC', enActivosDesde: 'sep/01/2026 19:18:24' })]);
  });

  it('en MOROSOS de cualquier router de la sede ya está bloqueado', () => {
    expect(cortesDeshechos(cand, [
      listas('Ip_Villanueva_EOC', 3, ['activo_16604'], []),
      listas('Ip_Villanueva_GPON', 3, [], ['activo_16604']),
    ])).toEqual([]);
  });

  it('en ninguna lista no se puede afirmar que navegue', () => {
    expect(cortesDeshechos(cand, [listas('Ip_Villanueva_EOC', 3, [], [])])).toEqual([]);
  });

  it('una entrada vieja en un router de OTRA sede no cuenta (abonados 2385 y 52392)', () => {
    const monterrey = [{ ...cand[0], abonado: 2385, legacyId: 6306, sede: 4 }];
    expect(cortesDeshechos(monterrey, [
      listas('ip_tauramena', 7, ['activo_6306'], []),
      listas('ip_Monterrey', 4, [], []),
    ])).toEqual([]);
  });
});
