import { whereDelDia } from './agenda-dia';

/** Un día de Colombia tal como Prisma lo escribe en una columna `date`. */
const dia = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const HOY = dia('2026-08-11');

/**
 * El arrastre de lo atrasado (2026-08-11).
 *
 * El caso que lo motivó es real: la orden 319544, agendada para el 6 de agosto y
 * nunca cerrada. El técnico solo mira hoy y la bandeja de la cajera solo trae lo que
 * NO tiene día, así que la orden seguía viva y no la veía nadie.
 */
describe('whereDelDia', () => {
  it('para hoy suma lo que quedó ABIERTO de días anteriores', () => {
    const w = whereDelDia(HOY, HOY);
    expect(w.OR).toEqual([
      { scheduledFor: HOY },
      { scheduledFor: { lt: HOY }, status: { in: ['PENDIENTE', 'REALIZANDO'] } },
    ]);
  });

  it('no arrastra lo ya cerrado: la columna de hoy no se llena con el histórico', () => {
    const arrastre = whereDelDia(HOY, HOY).OR?.[1] as { status: { in: string[] } };
    expect(arrastre.status.in).not.toContain('RESUELTO');
    expect(arrastre.status.in).not.toContain('ANULADA');
  });

  it('un día pasado se lee tal cual: el tablero del 6 sigue contando lo del 6', () => {
    expect(whereDelDia(dia('2026-08-06'), HOY)).toEqual({ scheduledFor: dia('2026-08-06') });
  });

  it('un día futuro tampoco arrastra: mañana no hereda los atrasos de hoy', () => {
    expect(whereDelDia(dia('2026-08-12'), HOY)).toEqual({ scheduledFor: dia('2026-08-12') });
  });

  it('compara el día por VALOR, no por identidad de objeto', () => {
    // Dos `Date` distintos con la misma medianoche UTC son el mismo día. Con un
    // `===` esto devolvería la rama de "otro día" y el arrastre no ocurriría nunca.
    expect(whereDelDia(dia('2026-08-11'), HOY).OR).toBeDefined();
  });
});
