import 'reflect-metadata';
import { SupportWriteService } from './support-write.service';
import { esRetiroVoluntario, motivoDeRetiroCanonico, MOTIVOS_RETIRO, RETIRO_VOLUNTARIO, DETALLES_POR_CLASE } from './order-types';

/**
 * POR QUÉ SE VA EL CLIENTE (2026-09-02).
 *
 * La orden de retiro es la única que pregunta el motivo, y ese motivo cae en
 * `Ticket.problem` —la misma columna (`tickets.problema`) por la que el legacy
 * agrupa desde siempre los 1.914 retiros ya registrados—. Por eso aquí se
 * comprueban las dos formas de estropear ese informe: dejar la orden sin motivo,
 * y meter en esa columna un texto que no es ninguno de los veinte.
 */
function armar() {
  const creados: any[] = [];
  const prisma = {
    subscriber: { findUnique: jest.fn().mockResolvedValue({ id: 'sub-1', nomenclature: {}, addressLine: null, neighborhood: '77' }) },
    ticket: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: any) =>
      fn({
        ticket: { create: jest.fn((args: any) => { creados.push(args.data); return Promise.resolve({ id: 't-1', code: 500123 }); }) },
        subscriber: { update: jest.fn().mockResolvedValue({}) },
        $queryRaw: jest.fn().mockResolvedValue([{ tid: 500123n }]),
      }),
    ),
  };
  const srv = new SupportWriteService(
    prisma as any, {} as any, {} as any, { notifyPost: jest.fn().mockResolvedValue(undefined) } as any,
    { emit: jest.fn() } as any, {} as any, {} as any, undefined, undefined,
    { cobrar: jest.fn().mockResolvedValue(null) } as any,
  );
  return { srv, prisma, creados };
}

const USUARIO = { id: 'u-1', name: 'Cajera', email: 'caja@vestel.com.co', areas: ['caja'] } as any;
const retiro = (problem?: string) =>
  ({ subscriberId: 'sub-1', subject: 'servicio', type: RETIRO_VOLUNTARIO, problem }) as any;

describe('catálogo de motivos de retiro', () => {
  it('son los del legacy y el detalle sigue ofreciéndose en la web', () => {
    expect(MOTIVOS_RETIRO).toHaveLength(20);
    // Los tres que se eligen a diario, con su texto EXACTO: cambiarle una letra
    // parte en dos el histórico por el que agrupan los informes.
    expect(MOTIVOS_RETIRO).toContain('mal servicio');
    expect(MOTIVOS_RETIRO).toContain('No necesita el servicio');
    expect(MOTIVOS_RETIRO).toContain('Traslado de municipio');
    expect(DETALLES_POR_CLASE.servicio).toContain(RETIRO_VOLUNTARIO);
  });

  it('reconoce el tipo de orden escrito de cualquier forma', () => {
    expect(esRetiroVoluntario('Retiro voluntario')).toBe(true);
    expect(esRetiroVoluntario('  retiro VOLUNTARIO ')).toBe(true);
    expect(esRetiroVoluntario('Retiro y Desinstalacion por Cartera')).toBe(false);
    expect(esRetiroVoluntario(null)).toBe(false);
  });

  it('devuelve el motivo TAL COMO se guarda, no como lo escribieron', () => {
    expect(motivoDeRetiroCanonico('MAL SERVICIO')).toBe('mal servicio');
    expect(motivoDeRetiroCanonico('  Cambio de Proveedor ')).toBe('Cambio de proveedor');
    expect(motivoDeRetiroCanonico('se aburrió')).toBeNull();
    expect(motivoDeRetiroCanonico('')).toBeNull();
  });
});

describe('abrir una orden de retiro', () => {
  it('sin motivo no se abre: la pregunta solo se puede contestar hoy', async () => {
    const { srv, prisma } = armar();
    await expect(srv.createTicket(retiro(), USUARIO)).rejects.toThrow(/por qué se retira/i);
    // Y no se quema un consecutivo por el camino.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('un motivo inventado tampoco: la columna es de la que sale el informe', async () => {
    const { srv, prisma } = armar();
    await expect(srv.createTicket(retiro('se aburrió'), USUARIO)).rejects.toThrow(/no es un motivo de retiro válido/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('con motivo se guarda en `problem`, con el texto del catálogo', async () => {
    const { srv, creados } = armar();
    await srv.createTicket(retiro('MAL SERVICIO'), USUARIO);
    expect(creados[0]).toMatchObject({ type: RETIRO_VOLUNTARIO, problem: 'mal servicio', subject: 'servicio' });
  });

  it('en el resto de las órdenes esa casilla sigue siendo la falla, en texto libre', async () => {
    const { srv, creados } = armar();
    await srv.createTicket(
      { subscriberId: 'sub-1', subject: 'reclamo', type: 'Revision de Internet', problem: 'no le llega señal desde anoche' } as any,
      USUARIO,
    );
    expect(creados[0]).toMatchObject({ problem: 'no le llega señal desde anoche' });
  });
});
