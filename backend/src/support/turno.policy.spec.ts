import { puedeAbrirOrden, tieneAgendaLibre, visitaEnTurno } from './turno';

/**
 * El turno obligatorio (restituido el 2026-09-02).
 *
 * Se prueba con un Prisma de mentira porque lo que hay que fijar aquí no es la
 * consulta sino las TRES puertas que quedan abiertas a propósito: las órdenes
 * cerradas, el día sin agenda y la propia visita en turno. Cerrar cualquiera de las
 * dos primeras por descuido deja al técnico sin poder trabajar, y eso ya pasó una vez.
 */
const prismaCon = (enTurno: { id: string } | null, agendaLibre = false) => {
  const espia = { where: undefined as any, orderBy: undefined as any };
  const prisma = {
    ticket: {
      findFirst: async (args: any) => {
        espia.where = args.where;
        espia.orderBy = args.orderBy;
        return enTurno;
      },
    },
    staff: { findUnique: async () => ({ agendaLibre }) },
  } as any;
  return { prisma, espia };
};

describe('visitaEnTurno', () => {
  it('pide sólo lo ABIERTO del día y lo lee en el orden de la agenda', async () => {
    const { prisma, espia } = prismaCon({ id: 'a' });
    const hoy = new Date(Date.UTC(2026, 8, 2));
    await expect(visitaEnTurno(prisma, 'staff-1', hoy)).resolves.toBe('a');
    expect(espia.where.assignedStaffId).toBe('staff-1');
    expect(espia.where.status).toEqual({ in: ['PENDIENTE', 'REALIZANDO'] });
    // El día viene de `agenda-dia`, así que lo atrasado entra: si aquí sólo se
    // preguntara por `scheduledFor: hoy`, una visita arrastrada del martes no sería
    // nunca la del turno y nadie podría abrirla.
    expect(espia.where.OR ?? espia.where.scheduledFor).toBeDefined();
    expect(espia.orderBy[0]).toEqual({ scheduledFor: 'asc' });
  });

  it('sin nada abierto devuelve null', async () => {
    const { prisma } = prismaCon(null);
    await expect(visitaEnTurno(prisma, 'staff-1', new Date())).resolves.toBeNull();
  });
});

describe('puedeAbrirOrden', () => {
  it('deja abrir la que está en turno', async () => {
    const { prisma } = prismaCon({ id: 'la-que-toca' });
    const v = await puedeAbrirOrden(prisma, 'staff-1', { id: 'la-que-toca', status: 'PENDIENTE' });
    expect(v.permitido).toBe(true);
  });

  it('niega adelantarse a otra pendiente, y dice cómo destapar la siguiente', async () => {
    const { prisma } = prismaCon({ id: 'la-que-toca' });
    const v = await puedeAbrirOrden(prisma, 'staff-1', { id: 'otra', status: 'PENDIENTE' });
    expect(v.permitido).toBe(false);
    if (!v.permitido) expect(v.motivo).toMatch(/no atendida/);
  });

  it('las cerradas se abren siempre: son su historial, no trabajo por elegir', async () => {
    const { prisma } = prismaCon({ id: 'la-que-toca' });
    for (const status of ['RESUELTO', 'ANULADA']) {
      const v = await puedeAbrirOrden(prisma, 'staff-1', { id: 'vieja', status });
      expect(v.permitido).toBe(true);
    }
  });

  it('un día sin agenda no bloquea nada: el turno ordena, no impide trabajar', async () => {
    const { prisma } = prismaCon(null);
    const v = await puedeAbrirOrden(prisma, 'staff-1', { id: 'cualquiera', status: 'PENDIENTE' });
    expect(v.permitido).toBe(true);
  });
});

/**
 * La excepción nominal (2026-09-02): un técnico con `Staff.agendaLibre` trabaja como
 * antes del turno —ve y abre toda su jornada—, y el resto del equipo no se entera.
 */
describe('agenda libre (excepción por persona)', () => {
  it('el exento abre cualquiera de sus pendientes', async () => {
    const { prisma } = prismaCon({ id: 'la-que-toca' }, true);
    const v = await puedeAbrirOrden(prisma, 'staff-oscar', { id: 'otra', status: 'PENDIENTE' });
    expect(v.permitido).toBe(true);
  });

  it('la bandera es de esa ficha: sin ella el candado sigue igual', async () => {
    const { prisma } = prismaCon({ id: 'la-que-toca' }, false);
    const v = await puedeAbrirOrden(prisma, 'staff-otro', { id: 'otra', status: 'PENDIENTE' });
    expect(v.permitido).toBe(false);
  });

  it('una ficha que no aparece no queda exenta por accidente', async () => {
    const prisma = {
      ticket: { findFirst: async () => ({ id: 'la-que-toca' }) },
      staff: { findUnique: async () => null },
    } as any;
    await expect(tieneAgendaLibre(prisma, 'fantasma')).resolves.toBe(false);
    const v = await puedeAbrirOrden(prisma, 'fantasma', { id: 'otra', status: 'PENDIENTE' });
    expect(v.permitido).toBe(false);
  });
});
