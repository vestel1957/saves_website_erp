import 'reflect-metadata';
import { SupportWriteService } from './support-write.service';
import { TIPOS_DE_CAMPO_POR_DEFECTO } from './geofence.policy';

/**
 * IP REMOTA OBLIGATORIA AL CERRAR (2026-09-10): el candado dentro de `updateStatus`,
 * que es lo que la política pura no puede comprobar — que se mire al abonado de la
 * orden, que se mire sólo cuando hace falta, y que el 422 llegue con el `code` que la
 * pantalla sabe convertir en el botón de «Asignar IP remota».
 *
 * El orden entre candados también se prueba: la foto va delante (es lo más barato de
 * arreglar en la puerta del cliente) y la geo-cerca detrás (es lo único que no tiene
 * arreglo si el técnico no está allí).
 */
const CENTINELA = new Error('la cerca se evaluó');

function armar(sub: { pppUsername?: string | null; ipRemote?: string | null } | null, opts: { fotos?: number } = {}) {
  const ticket = {
    id: 't-1', code: 505900, type: 'Instalacion', subscriberId: sub ? 'sub-1' : null,
    signatureName: 'Quien recibe', status: 'REALIZANDO', score: null,
  };
  const prisma = {
    ticket: { findUnique: jest.fn().mockResolvedValue(ticket), update: jest.fn().mockResolvedValue({}) },
    subscriber: { findUnique: jest.fn().mockResolvedValue(sub), update: jest.fn().mockResolvedValue({}) },
    ticketThread: { count: jest.fn().mockResolvedValue(opts.fotos ?? 1), create: jest.fn().mockResolvedValue({}) },
    staff: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) },
    user: { findUnique: jest.fn().mockResolvedValue({ sedesAccede: [], cajaLegacyId: null }) },
  };
  const geofence = {
    tiposCampo: jest.fn().mockResolvedValue(TIPOS_DE_CAMPO_POR_DEFECTO),
    modo: jest.fn().mockResolvedValue('exigir'),
    evaluar: jest.fn().mockRejectedValue(CENTINELA),
  };
  const mikrotik = {
    garantizarIpRemota: jest.fn().mockResolvedValue({
      ok: true, ip: '10.20.4.88', dryRun: false, steps: ['remote-address (vacío) → 10.20.4.88'],
      message: 'WINDYMUNOZ quedó con IP remota 10.20.4.88 en Ip_Villanueva_GPON.', mikrotik: { name: 'Ip_Villanueva_GPON' },
    }),
  };
  const srv = new SupportWriteService(
    prisma as any, mikrotik as any, geofence as any,
    { notifyPost: jest.fn().mockResolvedValue(undefined) } as any,
    { emit: jest.fn() } as any, {} as any, { puntajeDe: jest.fn().mockResolvedValue(3) } as any,
  );
  return { srv, prisma, geofence, mikrotik };
}

const TECNICO = { id: 'u-1', name: 'Santiago García', permissions: ['area.tecnicos'] } as any;
const cerrar = (srv: any, user: any = TECNICO) => srv.updateStatus('t-1', { status: 'RESUELTO' }, user);

describe('cerrar una visita exige IP remota activa', () => {
  it('frena con 422 e IP_REMOTA_REQUERIDA al cliente sin IP', async () => {
    const { srv } = armar({ pppUsername: 'WINDYMUNOZ', ipRemote: null });
    await expect(cerrar(srv)).rejects.toMatchObject({
      status: 422,
      cuerpo: { code: 'IP_REMOTA_REQUERIDA' },
    });
  });

  it('el "0" heredado del legacy tampoco deja cerrar', async () => {
    const { srv } = armar({ pppUsername: 'WINDYMUNOZ', ipRemote: '0' });
    await expect(cerrar(srv)).rejects.toMatchObject({ cuerpo: { code: 'IP_REMOTA_REQUERIDA' } });
  });

  it('con IP buena el cierre sigue su camino y llega a la geo-cerca', async () => {
    const { srv, geofence } = armar({ pppUsername: 'WINDYMUNOZ', ipRemote: '10.20.4.88' });
    await expect(cerrar(srv)).rejects.toBe(CENTINELA);
    expect(geofence.evaluar).toHaveBeenCalled();
  });

  it('al cliente de sólo televisión no se le pide (no tiene secret PPPoE)', async () => {
    const { srv } = armar({ pppUsername: '0', ipRemote: null });
    await expect(cerrar(srv)).rejects.toBe(CENTINELA);
  });

  it('la foto va ANTES: sin evidencia se pide la foto, no la IP', async () => {
    const { srv, prisma } = armar({ pppUsername: 'WINDYMUNOZ', ipRemote: null }, { fotos: 0 });
    await expect(cerrar(srv)).rejects.toMatchObject({ cuerpo: { code: 'FOTO_REQUERIDA' } });
    // Y no se fue a buscar al abonado: la orden se paró antes.
    expect(prisma.subscriber.findUnique).not.toHaveBeenCalled();
  });

  it('no se consulta al abonado en los cierres que no son de campo (el 85%)', async () => {
    const { srv, prisma } = armar({ pppUsername: 'WINDYMUNOZ', ipRemote: null });
    prisma.ticket.findUnique.mockResolvedValue({
      id: 't-2', code: 505901, type: 'Reconexion Internet', subscriberId: 'sub-1',
      signatureName: null, status: 'REALIZANDO', score: null,
    });
    await expect(cerrar(srv)).rejects.toBe(CENTINELA);
    expect(prisma.subscriber.findUnique).not.toHaveBeenCalled();
  });

  it('apagado con TICKET_REQUIRE_REMOTE_IP=false, no frena a nadie', async () => {
    const antes = process.env.TICKET_REQUIRE_REMOTE_IP;
    process.env.TICKET_REQUIRE_REMOTE_IP = 'false';
    try {
      const { srv } = armar({ pppUsername: 'WINDYMUNOZ', ipRemote: null });
      await expect(cerrar(srv)).rejects.toBe(CENTINELA);
    } finally {
      if (antes === undefined) delete process.env.TICKET_REQUIRE_REMOTE_IP;
      else process.env.TICKET_REQUIRE_REMOTE_IP = antes;
    }
  });
});

describe('activar la IP remota desde la propia orden', () => {
  it('se la pide al router y lo deja escrito en el hilo de la orden', async () => {
    const { srv, mikrotik, prisma } = armar({ pppUsername: 'WINDYMUNOZ', ipRemote: null });
    const r = await srv.activarIpRemota('t-1', TECNICO);
    expect(mikrotik.garantizarIpRemota).toHaveBeenCalledWith('sub-1', TECNICO);
    expect(r).toMatchObject({ ok: true, ip: '10.20.4.88' });
    expect(prisma.ticketThread.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ticketCode: 505900, message: expect.stringContaining('10.20.4.88') }),
      }),
    );
  });

  it('una orden sin cliente no tiene IP que activar', async () => {
    const { srv } = armar(null);
    await expect(srv.activarIpRemota('t-1', TECNICO)).rejects.toThrow(/no tiene cliente/i);
  });
});
