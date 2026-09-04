import 'reflect-metadata';
import { autorDeOrden, autorSistema } from './autor-orden';
import { BOT_ACTOR } from '../chatbot/chatbot.identity';
import { SupportWriteService } from './support-write.service';
import { OrdenesAutomaticasService } from './ordenes-automaticas.service';

/**
 * QUIÉN GENERÓ la orden.
 *
 * Una orden de servicio es una instrucción de trabajo: hasta ahora se sabía quién
 * la iba a hacer (`assigned`) pero no quién la mandó — eso vivía en `col`, el texto
 * libre del legacy, y ninguna pantalla lo mostraba. Lo que se comprueba aquí es que
 * las cuatro puertas por las que nace una orden la firmen, y que se distinga a la
 * persona del proceso: una reconexión que abre el sistema al recibir el pago no se
 * le reclama a nadie.
 */
function armarWrite() {
  const creados: any[] = [];
  const prisma = {
    subscriber: { findUnique: jest.fn().mockResolvedValue({ id: 'sub-1', nomenclature: {}, addressLine: null, neighborhood: '77' }) },
    staff: { findFirst: jest.fn().mockResolvedValue(null) },
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
    { emit: jest.fn() } as any, {} as any, {} as any,
  );
  return { srv, creados };
}

function armarAutomaticas() {
  const creados: any[] = [];
  const prisma = {
    ticket: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: any) =>
      fn({
        ticket: { create: jest.fn((args: any) => { creados.push(args.data); return Promise.resolve({ id: 't-9', code: 500900, type: args.data.type }); }) },
        $queryRaw: jest.fn().mockResolvedValue([{ tid: 500900n }]),
      }),
    ),
  };
  const srv = new OrdenesAutomaticasService(prisma as any, { notifyPost: jest.fn().mockResolvedValue(undefined) } as any);
  return { srv, creados };
}

const CAJERA = { id: 'u-1', name: 'Sonia Barreto', email: 'sonia@vestel.com.co', roles: [], permissions: [] } as any;

describe('autor de la orden', () => {
  it('un funcionario firma con su nombre y su id de usuario', () => {
    expect(autorDeOrden(CAJERA)).toEqual({
      col: 'Sonia Barreto',
      createdByName: 'Sonia Barreto',
      createdById: 'u-1',
      createdBySource: 'USUARIO',
    });
  });

  it('sin nombre cae al correo, que es lo único que identifica a esa cuenta', () => {
    expect(autorDeOrden({ id: 'u-2', email: 'nueva@vestel.com.co' } as any)).toMatchObject({
      createdByName: 'nueva@vestel.com.co',
      createdById: 'u-2',
      createdBySource: 'USUARIO',
    });
  });

  it('el bot se marca como CHATBOT y NO deja un id de usuario que no existe', () => {
    // `BOT_ACTOR.id` es 'chatbot', no una cuenta: guardarlo como `createdById`
    // dejaría una orden apuntando a un `User` inexistente.
    expect(autorDeOrden(BOT_ACTOR)).toEqual({
      col: 'Bot WhatsApp',
      createdByName: 'Bot WhatsApp',
      createdById: null,
      createdBySource: 'CHATBOT',
    });
  });

  it('un proceso automático firma como sistema, con el nombre del proceso si lo da', () => {
    expect(autorSistema()).toMatchObject({ createdByName: 'Sistema', createdBySource: 'SISTEMA', createdById: null });
    expect(autorSistema('Reconexión al pagar')).toMatchObject({
      col: 'Reconexión al pagar',
      createdByName: 'Reconexión al pagar',
      createdBySource: 'SISTEMA',
    });
  });

  it('la orden que abre un funcionario queda firmada por él', async () => {
    const { srv, creados } = armarWrite();
    await srv.createTicket({ subscriberId: 'sub-1', type: 'Revision de Internet' } as any, CAJERA);
    expect(creados[0]).toMatchObject({
      createdByName: 'Sonia Barreto',
      createdById: 'u-1',
      createdBySource: 'USUARIO',
      // `col` sigue escribiéndose igual: es la columna que viaja al legacy y de la
      // que cuelga el aviso proactivo del bot.
      col: 'Sonia Barreto',
    });
  });

  it('la orden que abre el sistema NO queda a nombre de una persona', async () => {
    const { srv, creados } = armarAutomaticas();
    await srv.abrirSiNoHay({ subscriberId: 'sub-1', type: 'Reconexion Television', autor: 'Reconexión al pagar' });
    expect(creados[0]).toMatchObject({
      createdByName: 'Reconexión al pagar',
      createdById: null,
      createdBySource: 'SISTEMA',
    });
  });

  it('también la que el sistema abre y cierra en el acto (la constancia del trabajo hecho)', async () => {
    const { srv, creados } = armarAutomaticas();
    await srv.registrarResuelta({ subscriberId: 'sub-1', type: 'Reconexion Internet' });
    expect(creados[0]).toMatchObject({ createdByName: 'Sistema', createdBySource: 'SISTEMA', status: 'RESUELTO' });
  });
});
