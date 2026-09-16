import { motivoDeOrdenAbierta, ordenEnCurso, puedeEmpezarOrden, tieneAgendaLibre } from './turno';

/**
 * "Una orden a la vez" — la regla del legacy (2026-09-10; nació como el turno del
 * técnico el 2026-08-04 y pasó por dos versiones más estrictas los días 09 y 10).
 *
 * Lo que se fija aquí es lo que se decidió después de leer el legacy
 * (`Tickets.php` → `update_status`): **ancla lo EMPEZADO y sólo lo empezado**, y **lo
 * único que se bloquea es empezar una segunda**. Ver, documentar y cerrar no se tocan.
 *
 * Se prueba con un Prisma de mentira porque lo que importa no es la consulta sino las
 * puertas que quedan abiertas a propósito —cerrar la que ancla, no tener ninguna
 * empezada, el exento— y el corte del rezago. Cerrar una de esas por descuido deja a la
 * empresa entera sin poder trabajar, y eso ya pasó una vez.
 */
const ORDEN = {
  id: 'la-empezada',
  code: 505628,
  type: 'Reinstalación',
  scheduledFor: null as Date | null,
  subscriber: { fullName: 'Juan Pérez', firstName: null, secondName: null, lastName1: null, lastName2: null, companyName: null },
};

const prismaCon = (
  empezada: typeof ORDEN | null,
  ficha: { name?: string; username?: string | null; agendaLibre?: boolean } | null = {},
) => {
  const espia = { where: undefined as any, orderBy: undefined as any };
  const prisma = {
    ticket: {
      findFirst: async (args: any) => {
        espia.where = args.where;
        espia.orderBy = args.orderBy;
        return empezada;
      },
    },
    staff: {
      findUnique: async () =>
        ficha && { name: ficha.name ?? 'Jose Alfredo Blanco', username: ficha.username ?? 'JoseTec', agendaLibre: ficha.agendaLibre ?? false },
    },
  } as any;
  return { prisma, espia };
};

/**
 * El interruptor general está APAGADO en producción desde el 2026-09-09 («quítela por
 * el momento»), y por eso todo lo de abajo lo enciende a mano: así se prueba la regla
 * misma, sin depender de quién es el usuario. A quién se le aplica de verdad —hoy sólo
 * al técnico de campo— tiene sus dos bloques al final.
 */
beforeEach(() => {
  process.env.UNA_ORDEN_A_LA_VEZ = 'true';
});
afterEach(() => {
  delete process.env.UNA_ORDEN_A_LA_VEZ;
});

describe('ordenEnCurso', () => {
  it('ancla lo EMPEZADO y sólo eso (el `status=Realizando` del legacy)', async () => {
    const { prisma, espia } = prismaCon(ORDEN);
    await expect(ordenEnCurso(prisma, 'staff-1')).resolves.toMatchObject({ id: 'la-empezada', code: 505628, cliente: 'Juan Pérez' });
    expect(espia.where.AND[1]).toEqual({ status: 'REALIZANDO' });
    // Nada de `PENDIENTE`: la agenda del día, por muy repartida que esté, no ancla.
    expect(JSON.stringify(espia.where)).not.toContain('PENDIENTE');
  });

  it('ante dos empezadas (las hay heredadas) toma la que la agenda pone primero', async () => {
    const { prisma, espia } = prismaCon(ORDEN);
    await ordenEnCurso(prisma, 'staff-1');
    expect(espia.orderBy[0]).toEqual({ scheduledFor: 'asc' });
  });

  it('cuenta las suyas por FK y por el texto libre del legacy (son la misma persona)', async () => {
    const { prisma, espia } = prismaCon(ORDEN);
    await ordenEnCurso(prisma, 'staff-1');
    expect(espia.where.AND[0].OR).toEqual([
      { assignedStaffId: 'staff-1' },
      { assigned: { in: ['Jose Alfredo Blanco', 'JoseTec'] } },
    ]);
  });

  it('deja fuera el rezago: nadie queda anclado a una empezada de hace dos años', async () => {
    const { prisma, espia } = prismaCon(ORDEN);
    await ordenEnCurso(prisma, 'staff-1');
    const corte: Date = espia.where.AND[2].created.gte;
    const dias = Math.round((Date.now() - corte.getTime()) / 86400_000);
    expect(dias).toBeGreaterThanOrEqual(89);
    expect(dias).toBeLessThanOrEqual(91);
  });

  it('sin nada empezado no ancla nada, por muchas asignadas que tenga', async () => {
    const { prisma } = prismaCon(null);
    await expect(ordenEnCurso(prisma, 'staff-1')).resolves.toBeNull();
  });

  it('sin ficha de empleado no hay orden que anclar', async () => {
    const { prisma } = prismaCon(ORDEN, null);
    await expect(ordenEnCurso(prisma, 'fantasma')).resolves.toBeNull();
  });
});

describe('puedeEmpezarOrden', () => {
  it('niega empezar una segunda y devuelve a cuál ir', async () => {
    const { prisma } = prismaCon(ORDEN);
    const v = await puedeEmpezarOrden(prisma, 'staff-1', { id: 'otra' });
    expect(v.permitido).toBe(false);
    // El id viaja en el veredicto, y no sólo en el texto: es lo que la pantalla
    // convierte en el enlace "ver la orden abierta", igual que el `<a>` del legacy.
    if (!v.permitido) {
      expect(v.enCurso.id).toBe('la-empezada');
      expect(v.motivo).toContain('#505628');
    }
  });

  it('no se bloquea a sí misma: volver a pulsar "Empezar" en la suya pasa', async () => {
    // El legacy sí falla aquí (su consulta encuentra la propia orden). No se copia.
    const { prisma } = prismaCon(ORDEN);
    const v = await puedeEmpezarOrden(prisma, 'staff-1', { id: 'la-empezada' });
    expect(v.permitido).toBe(true);
  });

  it('quien no tiene ninguna EMPEZADA empieza la que quiera de su día', async () => {
    // Es el caso que rompía el 2026-09-09 y el 09-10: tener catorce asignadas, o la
    // agenda del día entera, no es estar trabajando nada.
    const { prisma } = prismaCon(null);
    const v = await puedeEmpezarOrden(prisma, 'staff-1', { id: 'cualquiera' });
    expect(v.permitido).toBe(true);
  });

  it('sin ficha de empleado no se bloquea nada (no hay forma de saber qué es suyo)', async () => {
    const { prisma } = prismaCon(ORDEN, null);
    const v = await puedeEmpezarOrden(prisma, 'fantasma', { id: 'otra' });
    expect(v.permitido).toBe(true);
  });
});

/**
 * La excepción nominal (2026-09-02): quien tiene `Staff.agendaLibre` trabaja como
 * antes del candado. Es además la válvula de escape si alguien queda anclado a una
 * orden empezada que no puede cerrar — lo que en el legacy no tiene salida.
 */
describe('agenda libre (excepción por persona)', () => {
  it('el exento empieza cualquier orden', async () => {
    const { prisma } = prismaCon(ORDEN, { agendaLibre: true });
    const v = await puedeEmpezarOrden(prisma, 'staff-oscar', { id: 'otra' });
    expect(v.permitido).toBe(true);
  });

  it('la bandera es de esa ficha: sin ella el candado sigue igual', async () => {
    const { prisma } = prismaCon(ORDEN, { agendaLibre: false });
    const v = await puedeEmpezarOrden(prisma, 'staff-otro', { id: 'otra' });
    expect(v.permitido).toBe(false);
  });

  it('una ficha que no aparece no queda exenta por accidente', async () => {
    const { prisma } = prismaCon(ORDEN, null);
    await expect(tieneAgendaLibre(prisma, 'fantasma')).resolves.toBe(false);
  });
});

describe('el aviso', () => {
  it('dice cuál es la orden y qué hacer para destaparse', () => {
    const texto = motivoDeOrdenAbierta({ id: 'x', code: 505628, type: 'Reinstalación', cliente: 'Juan Pérez', agendadaPara: null });
    expect(texto).toContain('#505628');
    expect(texto).toContain('Juan Pérez');
    expect(texto).toMatch(/Ciérrala/);
  });

  it('aguanta una orden sin número y sin cliente (las hay heredadas del legacy)', () => {
    const texto = motivoDeOrdenAbierta({ id: 'x', code: null, type: 'Veeduria', cliente: null, agendadaPara: null });
    expect(texto).toContain('Veeduria');
    expect(texto).not.toContain('#');
  });
});

/**
 * El interruptor apagado —que es como está hoy para todo el que no es técnico de
 * campo— no puede dejar ni un resto del candado: ni el 403 al empezar otra, ni la
 * orden que ancla (de la que cuelgan los avisos de las pantallas).
 */
describe('con la regla apagada (UNA_ORDEN_A_LA_VEZ sin poner)', () => {
  beforeEach(() => {
    delete process.env.UNA_ORDEN_A_LA_VEZ;
  });

  it('se empieza otra orden aunque ya tenga una empezada', async () => {
    const { prisma } = prismaCon(ORDEN);
    const v = await puedeEmpezarOrden(prisma, 'staff-1', { id: 'otra' });
    expect(v.permitido).toBe(true);
  });

  it('nadie queda anclado: no hay orden en curso que enseñar', async () => {
    const { prisma, espia } = prismaCon(ORDEN);
    await expect(ordenEnCurso(prisma, 'staff-1')).resolves.toBeNull();
    // Ni siquiera se pregunta a la base: apagada, la regla no cuesta una consulta.
    expect(espia.where).toBeUndefined();
  });

  it('todo el mundo ve su agenda entera, como el exento', async () => {
    const { prisma } = prismaCon(ORDEN, { agendaLibre: false });
    await expect(tieneAgendaLibre(prisma, 'staff-otro')).resolves.toBe(true);
  });
});

/**
 * A quién se le aplica hoy: al TÉCNICO DE CAMPO siempre, con el interruptor apagado
 * —que es como está el sistema para todos los demás—. Es lo que se rompería en
 * silencio el día que alguien toque `turnoAplicaA` o los permisos que lo marcan.
 */
describe('el técnico de campo lleva el candado aunque el interruptor esté apagado', () => {
  const TECNICO = { id: 'u-1', email: 't@vestel.com.co', name: 'Jose Alfredo Blanco', permissions: ['area.tecnicos'] } as any;
  const CAJERA = { id: 'u-2', email: 'c@vestel.com.co', name: 'Sonia Barreto', permissions: ['area.caja'] } as any;
  const JEFE = { id: 'u-3', email: 'j@vestel.com.co', name: 'Ana', permissions: ['area.tecnicos', 'area.administracion'] } as any;

  beforeEach(() => {
    delete process.env.UNA_ORDEN_A_LA_VEZ;
  });

  it('a él sí: con una empezada encima no empieza otra', async () => {
    const { prisma } = prismaCon(ORDEN);
    const v = await puedeEmpezarOrden(prisma, 'staff-1', { id: 'otra' }, TECNICO);
    expect(v.permitido).toBe(false);
  });

  it('a él sí: la orden que lo ancla se calcula y se enseña', async () => {
    const { prisma } = prismaCon(ORDEN);
    await expect(ordenEnCurso(prisma, 'staff-1', TECNICO)).resolves.toMatchObject({ id: 'la-empezada' });
  });

  it('pero sin nada empezado su día está libre: empieza la visita que le toque', async () => {
    const { prisma } = prismaCon(null);
    const v = await puedeEmpezarOrden(prisma, 'staff-1', { id: 'la-tercera-del-dia' }, TECNICO);
    expect(v.permitido).toBe(true);
  });

  it('el exento sigue siendo exento, también siendo técnico', async () => {
    const { prisma } = prismaCon(ORDEN, { agendaLibre: true });
    await expect(tieneAgendaLibre(prisma, 'staff-oscar', TECNICO)).resolves.toBe(true);
    const v = await puedeEmpezarOrden(prisma, 'staff-oscar', { id: 'otra' }, TECNICO);
    expect(v.permitido).toBe(true);
  });

  it('a la cajera NO: el interruptor está apagado y ella no es de campo', async () => {
    const { prisma } = prismaCon(ORDEN);
    const v = await puedeEmpezarOrden(prisma, 'staff-2', { id: 'otra' }, CAJERA);
    expect(v.permitido).toBe(true);
    await expect(ordenEnCurso(prisma, 'staff-2', CAJERA)).resolves.toBeNull();
  });

  it('quien es técnico Y administración tampoco: manda el área de mando', async () => {
    const { prisma } = prismaCon(ORDEN);
    const v = await puedeEmpezarOrden(prisma, 'staff-3', { id: 'otra' }, JEFE);
    expect(v.permitido).toBe(true);
  });

  it('los procesos internos (sin usuario) siguen pasando: el cron mueve su orden', async () => {
    const { prisma } = prismaCon(ORDEN);
    const v = await puedeEmpezarOrden(prisma, 'staff-1', { id: 'otra' });
    expect(v.permitido).toBe(true);
  });
});
