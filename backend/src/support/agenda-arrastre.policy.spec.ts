import { arrastrarAlDiaDeHoy, ordenDeLaJornada, whereArrastrables } from './agenda-arrastre';

/** Un día de Colombia tal como Prisma lo escribe en una columna `date`. */
const dia = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const HOY = dia('2026-09-01');

const fila = (id: string, o: Partial<{ scheduledFor: Date; carriedFrom: Date; scheduledSeq: number; created: Date }> = {}) => ({
  id,
  scheduledFor: o.scheduledFor ?? HOY,
  carriedFrom: o.carriedFrom ?? null,
  scheduledSeq: o.scheduledSeq ?? null,
  created: o.created ?? null,
});

describe('qué se arrastra', () => {
  it('sólo lo agendado para un día pasado y todavía abierto', () => {
    expect(whereArrastrables(HOY)).toEqual({
      scheduledFor: { lt: HOY },
      status: { in: ['PENDIENTE', 'REALIZANDO'] },
    });
  });

  it('no arrastra lo cerrado: una visita del jueves ya resuelta se queda en el jueves', () => {
    const w = whereArrastrables(HOY) as { status: { in: string[] } };
    expect(w.status.in).not.toContain('RESUELTO');
    expect(w.status.in).not.toContain('ANULADA');
  });
});

describe('orden de la jornada tras arrastrar', () => {
  it('lo arrastrado va DELANTE de lo que ya estaba puesto para hoy', () => {
    const filas = [
      fila('hoy-1', { scheduledSeq: 1 }),
      fila('ayer', { carriedFrom: dia('2026-08-31') }),
    ];
    expect(ordenDeLaJornada(filas, HOY)).toEqual(['ayer', 'hoy-1']);
  });

  it('entre lo arrastrado manda la antigüedad: lo del lunes antes que lo del viernes', () => {
    const filas = [
      fila('viernes', { carriedFrom: dia('2026-08-28') }),
      fila('lunes', { carriedFrom: dia('2026-08-24') }),
    ];
    expect(ordenDeLaJornada(filas, HOY)).toEqual(['lunes', 'viernes']);
  });

  it('un día que se arrastra entero conserva el recorrido que armó la cajera', () => {
    const ayer = dia('2026-08-31');
    const filas = [
      fila('c', { carriedFrom: ayer, scheduledSeq: 3 }),
      fila('a', { carriedFrom: ayer, scheduledSeq: 1 }),
      fila('b', { carriedFrom: ayer, scheduledSeq: 2 }),
    ];
    expect(ordenDeLaJornada(filas, HOY)).toEqual(['a', 'b', 'c']);
  });

  it('sin posición se desempata por antigüedad de la orden, no por azar', () => {
    const filas = [
      fila('nueva', { created: dia('2026-08-30') }),
      fila('vieja', { created: dia('2026-01-05') }),
    ];
    expect(ordenDeLaJornada(filas, HOY)).toEqual(['vieja', 'nueva']);
  });
});

/** Prisma de mentira: sólo lo que el arrastre le pide. */
function prismaFalso(ordenes: any[]) {
  const escrituras: any[] = [];
  const cumple = (o: any, where: any) => {
    if (where.id?.in && !where.id.in.includes(o.id)) return false;
    if (where.id && typeof where.id === 'string' && where.id !== o.id) return false;
    if ('carriedFrom' in where && where.carriedFrom === null && o.carriedFrom !== null) return false;
    if (where.scheduledFor instanceof Date && o.scheduledFor?.getTime() !== where.scheduledFor.getTime()) return false;
    if (where.scheduledFor?.lt && !(o.scheduledFor && o.scheduledFor < where.scheduledFor.lt)) return false;
    if (where.assignedStaffId && o.assignedStaffId !== where.assignedStaffId) return false;
    if (where.status?.in && !where.status.in.includes(o.status)) return false;
    return true;
  };
  const prisma = {
    ticket: {
      findMany: async ({ where }: any) => ordenes.filter((o) => cumple(o, where)).map((o) => ({ ...o })),
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const o of ordenes) if (cumple(o, where)) { Object.assign(o, data); count++; }
        return { count };
      },
      update: async ({ where, data }: any) => {
        const o = ordenes.find((x) => x.id === where.id);
        Object.assign(o, data);
        escrituras.push({ id: where.id, ...data });
        return o;
      },
    },
    $transaction: async (fn: any) => fn(prisma),
  };
  return { prisma, ordenes, escrituras };
}

describe('arrastrarAlDiaDeHoy', () => {
  const abierta = (id: string, o: any = {}) => ({
    id, status: 'PENDIENTE', assignedStaffId: 'tec-1', carriedFrom: null, scheduledSeq: null,
    created: dia('2026-08-01'), ...o,
  });

  it('le pone la fecha de HOY a lo que quedó abierto y guarda de qué día viene', async () => {
    const { prisma, ordenes } = prismaFalso([
      abierta('ayer', { scheduledFor: dia('2026-08-31'), scheduledSeq: 1 }),
    ]);
    const r = await arrastrarAlDiaDeHoy(prisma as any, HOY);

    expect(r).toMatchObject({ movidas: 1, tecnicos: 1, masVieja: '2026-08-31' });
    expect(ordenes[0].scheduledFor).toEqual(HOY);
    expect(ordenes[0].carriedFrom).toEqual(dia('2026-08-31'));
    // Ya tiene puesto en la jornada de hoy: la numeración es por día, y sin esto
    // llegaría a la columna sin posición.
    expect(ordenes[0].scheduledSeq).toBe(1);
  });

  it('el día de origen se sella UNA vez: lo que lleva tres días rodando sigue diciendo de dónde viene', async () => {
    const lunes = dia('2026-08-24');
    const { prisma, ordenes } = prismaFalso([
      abierta('rodando', { scheduledFor: dia('2026-08-31'), carriedFrom: lunes }),
    ]);
    await arrastrarAlDiaDeHoy(prisma as any, HOY);
    expect(ordenes[0].carriedFrom).toEqual(lunes);
  });

  it('lo arrastrado queda de primero y lo de hoy detrás', async () => {
    const { prisma, ordenes } = prismaFalso([
      abierta('hoy-1', { scheduledFor: HOY, scheduledSeq: 1 }),
      abierta('hoy-2', { scheduledFor: HOY, scheduledSeq: 2 }),
      abierta('ayer', { scheduledFor: dia('2026-08-31'), scheduledSeq: 1 }),
    ]);
    await arrastrarAlDiaDeHoy(prisma as any, HOY);
    const seq = Object.fromEntries(ordenes.map((o) => [o.id, o.scheduledSeq]));
    expect(seq).toEqual({ ayer: 1, 'hoy-1': 2, 'hoy-2': 3 });
  });

  it('no toca lo cerrado, lo de hoy ni lo que está sin agendar', async () => {
    const { prisma, ordenes } = prismaFalso([
      abierta('resuelta', { scheduledFor: dia('2026-08-31'), status: 'RESUELTO' }),
      abierta('de-hoy', { scheduledFor: HOY }),
      // Apartada por el técnico: volvió a la bandeja de la cajera y no tiene día.
      abierta('apartada', { scheduledFor: null }),
    ]);
    const r = await arrastrarAlDiaDeHoy(prisma as any, HOY);
    expect(r.movidas).toBe(0);
    expect(ordenes.map((o) => o.scheduledFor)).toEqual([dia('2026-08-31'), HOY, null]);
  });
});
