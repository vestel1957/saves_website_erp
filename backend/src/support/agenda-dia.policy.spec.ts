import { whereDelDia, whereTrabajoDelDia } from './agenda-dia';

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

/**
 * El trabajo del día del técnico — lo que ve en `/soporte` desde el 2026-09-10.
 *
 * Lo que se fija aquí no es la forma del `where` sino los cuatro renglones que NO
 * pueden faltar. Cada uno tapa un agujero por el que el técnico perdería trabajo de
 * vista: si se cae el de "empezado" queda anclado sin ver a qué; si se cae el de
 * "asignado hoy sin agendar" desaparece 1 de cada 4 órdenes que cierra; y si se cae
 * el de "cerrado hoy", el día terminado se ve igual que uno en blanco.
 */
describe('whereTrabajoDelDia', () => {
  const renglones = () => whereTrabajoDelDia(HOY).OR ?? [];

  it('trae la agenda de hoy, con lo atrasado que sigue abierto', () => {
    expect(renglones()[0]).toEqual(whereDelDia(HOY, HOY));
  });

  it('trae lo EMPEZADO, esté agendado o no', () => {
    expect(renglones()).toContainEqual({ status: 'REALIZANDO' });
  });

  it('trae lo asignado HOY sin agendar (la cajera abre y el técnico cierra el mismo día)', () => {
    expect(renglones()).toContainEqual({
      scheduledFor: null,
      status: { in: ['PENDIENTE', 'REALIZANDO'] },
      created: HOY,
    });
  });

  it('trae lo que cerró o apartó hoy, para que vea lo que lleva hecho', () => {
    const r = renglones();
    expect(r).toContainEqual({ finalDate: HOY });
    expect(r.some((c: any) => c.resolvedAt)).toBe(true);
    expect(r.some((c: any) => c.skippedAt)).toBe(true);
  });

  it('NO trae su historial: nada abierto sin fecha de días anteriores', () => {
    // El renglón de lo no agendado exige `created: HOY`. Sin eso volverían las 966
    // órdenes de toda su vida, que es justo lo que el usuario pidió quitar.
    const sinAgendar = renglones().find((c: any) => c.scheduledFor === null) as any;
    expect(sinAgendar.created).toEqual(HOY);
  });
});
