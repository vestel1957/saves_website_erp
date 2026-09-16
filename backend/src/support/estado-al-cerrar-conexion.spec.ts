import 'reflect-metadata';
import { SupportWriteService } from './support-write.service';
import { esTrabajoDeConexion } from './order-types';
import { modoDeOrden, puedeAutenticar } from './onu-provision.service';

/**
 * LOS CINCO TRABAJOS QUE DEJAN AL CLIENTE CONECTADO (pedido del usuario, 2026-09-08):
 * Instalación, Traslado, Migración, Cambio de equipo y Agregar Internet.
 *
 * Dos cosas tienen que ser verdad para los cinco, y hasta ahora sólo lo eran para
 * la instalación:
 *
 *  1. Que desde la orden SE PUEDA AUTENTICAR el equipo.
 *  2. Que cerrarlas NO deje al abonado en 'INSTALAR'. Es el agujero que ya costó
 *     caro: el legacy pone al cliente en 'Instalar' al abrir la visita y sólo su
 *     'Instalacion' lo devuelve; cerrando aquí un 'AgregarInternet', una
 *     'Migracion', un 'Traslado' o un 'Cambio de equipo' el abonado se quedaba
 *     "por instalar" para siempre — navegando y SIN QUE SE LE FACTURE, porque la
 *     corrida mensual sólo mira facturables.
 *
 * Lo que NO puede hacer esta red: pisar cualquier otro estado. Un CORTADO que
 * recibe un cambio de equipo sigue CORTADO — ahí el estado lo puso otra cosa.
 */

const CINCO = ['Instalacion', 'Traslado', 'Migracion', 'Cambio de equipo', 'AgregarInternet'];

describe('los cinco trabajos de conexión', () => {
  it('todos autentican el equipo desde la orden', () => {
    for (const tipo of CINCO) {
      expect([tipo, puedeAutenticar(modoDeOrden(tipo))]).toEqual([tipo, true]);
    }
    // Y las variantes con las que el legacy los escribe.
    for (const tipo of ['MIGRACION', 'migraci', 'agregarinternet']) {
      expect([tipo, puedeAutenticar(modoDeOrden(tipo))]).toEqual([tipo, true]);
    }
    // La REINSTALACIÓN es la excepción (2026-09-08): cierra dejando al cliente
    // conectado —por eso sigue siendo trabajo de conexión, abajo— pero no
    // autentica nada, porque el equipo ya está de alta en la OLT.
    expect(puedeAutenticar(modoDeOrden('Reinstalación'))).toBe(false);
  });

  it('los reconoce el mismo predicado que usa el cierre', () => {
    for (const tipo of CINCO) expect([tipo, esTrabajoDeConexion(tipo)]).toEqual([tipo, true]);
    // La reinstalación no autentica, pero cerrarla tampoco puede dejar al abonado
    // en 'INSTALAR': el trabajo se hizo y el cliente quedó conectado.
    expect(esTrabajoDeConexion('Reinstalación')).toBe(true);
    // Y no arrastra a las que no son: esas tienen su propia rama en la cascada.
    for (const tipo of ['Corte Internet', 'Reconexion Combo', 'Retiro voluntario', 'Subir megas']) {
      expect([tipo, esTrabajoDeConexion(tipo)]).toEqual([tipo, false]);
    }
  });
});

/** Doble de `SupportWriteService` con un abonado en el estado que se le diga. */
function armar(status: string) {
  const subscriber = {
    findUnique: jest.fn().mockResolvedValue({ id: 'sub-1', status }),
    update: jest.fn().mockResolvedValue({}),
  };
  const prisma = {
    subscriber,
    subscriberStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    subscriberService: {
      count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    subInvoice: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue({}) },
    appSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    plan: { findUnique: jest.fn().mockResolvedValue(null) },
    ticket: { update: jest.fn().mockResolvedValue({}) },
  };
  const mikrotik = {
    reconnect: jest.fn().mockResolvedValue({ ok: true, message: 'Reconectado' }),
    cut: jest.fn().mockResolvedValue({ ok: true }),
    provision: jest.fn().mockResolvedValue({ ok: true, message: 'Alta aplicada' }),
  };
  const planes = {
    changePlan: jest.fn().mockResolvedValue({ ok: true, plan: { id: 'plan-300', name: '300 Megas' } }),
    asegurarCredencialesPpp: jest.fn().mockResolvedValue({ ok: true, creado: false, pppUsername: 'ANAGOMEZ' }),
  };
  const srv = new SupportWriteService(
    prisma as any, mikrotik as any, {} as any, { notifyPost: jest.fn().mockResolvedValue(undefined) } as any,
    { emit: jest.fn() } as any, {} as any, {} as any,
    { aplicar: jest.fn().mockResolvedValue({ mensaje: 'sin prorrateo' }) } as any,
    undefined, undefined, planes as any,
  );
  return { srv, prisma };
}

const cerrar = (srv: any, type: string) =>
  srv.applyCloseCascade({ ticketId: 't-1', subscriberId: 'sub-1', type, code: 505600, planToId: 'plan-300' }, undefined);

describe('cerrar uno de los cinco no puede dejar al cliente en «por instalar»', () => {
  it.each(CINCO)('%s activa al que venía en INSTALAR', async (tipo) => {
    const { srv, prisma } = armar('INSTALAR');
    const cascade = await cerrar(srv, tipo);
    expect(cascade.statusSet).toBe('ACTIVO');
    expect(prisma.subscriber.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVO', previousStatus: 'INSTALAR' }) }),
    );
    // La fila de historial no es papeleo: es lo que el writeback lleva al legacy
    // antes de que su ida devuelva el 'Instalar' (15 min).
    expect(prisma.subscriberStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVO', originTicketId: 505600 }) }),
    );
    // Y se marca como ACTIVACIÓN, que es lo que dispara ese empuje inmediato.
    expect(cascade.activacion).toBe(true);
  });

  it('la instalación de SOLO televisión también lo activa', async () => {
    // Una orden de sólo TV no cambia el estado (cortarle la TV no lo deja
    // CORTADO), pero terminar de instalarle la televisión sí lo saca de «por
    // instalar»: el trabajo se hizo y ese cliente ya se factura.
    const { srv } = armar('INSTALAR');
    const cascade = await cerrar(srv, 'Instalacion Television');
    expect(cascade.statusSet).toBe('ACTIVO');
  });

  it.each(['CORTADO', 'RETIRADO', 'CARTERA', 'SUSPENDIDO'])(
    'no toca al que está %s: ese estado lo puso otra cosa',
    async (status) => {
      const { srv, prisma } = armar(status);
      const cascade = await cerrar(srv, 'Cambio de equipo');
      expect(cascade.statusSet).toBeUndefined();
      expect(prisma.subscriber.update).not.toHaveBeenCalled();
    },
  );

  it('en una orden que no es de conexión no se mira el estado siquiera', async () => {
    const { srv, prisma } = armar('INSTALAR');
    const cascade = await cerrar(srv, 'Revision de Internet');
    expect(cascade.statusSet).toBeUndefined();
    expect(prisma.subscriber.update).not.toHaveBeenCalled();
  });
});
