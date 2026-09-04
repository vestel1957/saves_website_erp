import { partirNotaDeEstado, sinEcosDelSync } from './motivo-estado';

describe('partirNotaDeEstado', () => {
  it('separa el funcionario del motivo en un cambio manual', () => {
    expect(partirNotaDeEstado('Cambio manual por Paula Andrea Unas: se exonera por convenio'))
      .toEqual({ author: 'Paula Andrea Unas', reason: 'se exonera por convenio' });
  });

  it('un cambio manual sin motivo deja el motivo vacío (no el nombre)', () => {
    expect(partirNotaDeEstado('Cambio manual por Nayme  Jimenez'))
      .toEqual({ author: 'Nayme Jimenez', reason: null });
  });

  it('lo que escribe el sistema es todo motivo y no tiene autor', () => {
    expect(partirNotaDeEstado('Reconexión automática por pago'))
      .toEqual({ author: null, reason: 'Reconexión automática por pago' });
    expect(partirNotaDeEstado('Paso automático a Cartera (cron): 3 facturas pendientes'))
      .toEqual({ author: null, reason: 'Paso automático a Cartera (cron): 3 facturas pendientes' });
  });

  it('las filas que trae el sync del legacy vienen sin nota', () => {
    expect(partirNotaDeEstado(null)).toEqual({ author: null, reason: null });
    expect(partirNotaDeEstado('   ')).toEqual({ author: null, reason: null });
  });

  it('un motivo con dos puntos no se parte a la mitad', () => {
    expect(partirNotaDeEstado('Cambio manual por Ana: autoriza Juan: no cobrar septiembre').reason)
      .toBe('autoriza Juan: no cobrar septiembre');
  });
});

describe('sinEcosDelSync', () => {
  const f = (iso: string) => new Date(iso);

  it('funde la copia pelada que devuelve el legacy y conserva la que tiene el motivo', () => {
    const out = sinEcosDelSync([
      { status: 'EXONERADO', date: f('2026-08-28T19:23:28.461Z'), note: 'Cambio manual por Paula: convenio' },
      { status: 'EXONERADO', date: f('2026-08-28T19:23:28.000Z'), note: null },
      { status: 'ACTIVO', date: f('2026-08-27T15:57:47.521Z'), note: 'Reconexión automática por pago' },
      { status: 'ACTIVO', date: f('2026-08-27T15:57:47.000Z'), note: null },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].note).toBe('Cambio manual por Paula: convenio');
    expect(out[1].note).toBe('Reconexión automática por pago');
  });

  it('dos cambios de verdad al mismo estado no se funden', () => {
    const out = sinEcosDelSync([
      { status: 'CORTADO', date: f('2026-08-28T19:00:00.000Z'), note: null },
      { status: 'CORTADO', date: f('2026-08-20T10:00:00.000Z'), note: null },
    ]);
    expect(out).toHaveLength(2);
  });

  it('no se salta un estado distinto que ocurrió en el mismo segundo', () => {
    const out = sinEcosDelSync([
      { status: 'ACTIVO', date: f('2026-08-28T19:00:00.500Z'), note: null },
      { status: 'CORTADO', date: f('2026-08-28T19:00:00.000Z'), note: null },
    ]);
    expect(out).toHaveLength(2);
  });
});
