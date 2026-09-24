import 'reflect-metadata';
import { SupportWriteService } from './support-write.service';
import { TIPOS_DE_CAMPO_POR_DEFECTO } from './geofence.policy';

/**
 * DATOS DEL CLIENTE ANTES DE EMPEZAR (2026-09-18): el candado dentro de
 * `updateStatus` cuando la orden pasa a REALIZANDO. Lo que la política pura no puede
 * comprobar y aquí sí: que se mire al abonado DE ESTA orden, que no se le pregunte a
 * la base cuando el requisito no aplica, que el 422 llegue con el `code` y el desglose
 * que la pantalla convierte en botones — y, sobre todo, que **cerrar no se frene**:
 * este candado es del arranque, y frenar también el cierre dejaría abiertas para
 * siempre las órdenes que ya se empezaron.
 */
function armar(
  sub: { gpsLat?: string | null; gpsLng?: string | null } | null,
  opts: { fotosVivienda?: number; tipo?: string; estadoActual?: string; centinelaCerca?: Error } = {},
) {
  const ticket = {
    id: 't-1', code: 505901, type: opts.tipo ?? 'Instalacion',
    subscriberId: sub ? 'sub-1' : null,
    signatureName: 'Quien recibe', status: opts.estadoActual ?? 'PENDIENTE', score: null,
  };
  const prisma = {
    ticket: { findUnique: jest.fn().mockResolvedValue(ticket), update: jest.fn().mockResolvedValue({}) },
    subscriber: { findUnique: jest.fn().mockResolvedValue(sub), update: jest.fn().mockResolvedValue({}) },
    subscriberFile: { count: jest.fn().mockResolvedValue(opts.fotosVivienda ?? 0) },
    ticketThread: { count: jest.fn().mockResolvedValue(1), create: jest.fn().mockResolvedValue({}) },
    staff: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) },
    user: { findUnique: jest.fn().mockResolvedValue({ sedesAccede: [], cajaLegacyId: null }) },
  };
  const geofence = {
    tiposCampo: jest.fn().mockResolvedValue(TIPOS_DE_CAMPO_POR_DEFECTO),
    modo: jest.fn().mockResolvedValue('exigir'),
    evaluar: opts.centinelaCerca
      ? jest.fn().mockRejectedValue(opts.centinelaCerca)
      : jest.fn().mockResolvedValue(null),
  };
  const srv = new SupportWriteService(
    prisma as any, { garantizarIpRemota: jest.fn() } as any, geofence as any,
    { notifyPost: jest.fn().mockResolvedValue(undefined) } as any,
    { emit: jest.fn() } as any, {} as any, { puntajeDe: jest.fn().mockResolvedValue(3) } as any,
  );
  return { srv, prisma, geofence };
}

const TECNICO = { id: 'u-1', name: 'Santiago García', permissions: ['area.tecnicos'] } as any;
const CON_TODO = { gpsLat: '5.340050', gpsLng: '-72.369080' };
const empezar = (srv: any, user: any = TECNICO) => srv.updateStatus('t-1', { status: 'REALIZANDO' }, user);

describe('empezar una visita exige los datos del cliente', () => {
  it('frena con 422 DATOS_CLIENTE_REQUERIDOS y dice qué falta', async () => {
    const { srv } = armar({ gpsLat: null, gpsLng: null }, { fotosVivienda: 0 });
    await expect(empezar(srv)).rejects.toMatchObject({
      status: 422,
      cuerpo: { code: 'DATOS_CLIENTE_REQUERIDOS', falta: { ubicacion: true, foto: true }, subscriberId: 'sub-1' },
    });
  });

  it('con ubicación pero sin foto pide sólo la foto', async () => {
    const { srv } = armar(CON_TODO, { fotosVivienda: 0 });
    await expect(empezar(srv)).rejects.toMatchObject({
      cuerpo: { falta: { ubicacion: false, foto: true } },
    });
  });

  it('con foto pero sin ubicación pide sólo la ubicación', async () => {
    const { srv } = armar({ gpsLat: null, gpsLng: null }, { fotosVivienda: 2 });
    await expect(empezar(srv)).rejects.toMatchObject({
      cuerpo: { falta: { ubicacion: true, foto: false } },
    });
  });

  it('con las dos cosas, la orden arranca', async () => {
    const { srv, prisma } = armar(CON_TODO, { fotosVivienda: 1 });
    await empezar(srv);
    expect(prisma.ticket.update).toHaveBeenCalled();
  });

  // El 85% del trabajo son cortes y reconexiones: ni se mira al abonado.
  it('no toca las órdenes que no son de campo, y ni consulta la base', async () => {
    const { srv, prisma } = armar({ gpsLat: null, gpsLng: null }, { tipo: 'Corte Internet' });
    await empezar(srv);
    expect(prisma.subscriberFile.count).not.toHaveBeenCalled();
  });

  it('los procesos sin usuario (reconexión automática) pasan', async () => {
    const { srv } = armar({ gpsLat: null, gpsLng: null });
    await srv.updateStatus('t-1', { status: 'REALIZANDO' });
  });

  /**
   * SÓLO AL TÉCNICO DE CAMPO (2026-09-18). Al resto del personal la orden le arranca
   * sin pedirle nada: no están en la vivienda, así que no pueden tomar ni la foto ni
   * el punto, y el candado los dejaría con la orden trabada.
   */
  it('sistemas, caja y contabilidad empiezan sin que se les pida nada', async () => {
    for (const area of ['area.sistemas', 'area.caja', 'area.contabilidad']) {
      const { srv, prisma } = armar({ gpsLat: null, gpsLng: null }, { fotosVivienda: 0 });
      await empezar(srv, { id: 'u-7', name: 'Oficina', permissions: [area] });
      expect(prisma.subscriberFile.count).not.toHaveBeenCalled();
      expect(prisma.ticket.update).toHaveBeenCalled();
    }
  });

  it('gerencia y superusuario están exentos', async () => {
    const { srv } = armar({ gpsLat: null, gpsLng: null });
    await empezar(srv, { id: 'u-9', name: 'Gerencia', permissions: ['area.gerencia'] });
    const { srv: srv2 } = armar({ gpsLat: null, gpsLng: null });
    await empezar(srv2, { id: 'u-8', name: 'Root', permissions: ['system.admin'] });
  });

  it('y al técnico que además es jefe de bodega tampoco (no es técnico "puro")', async () => {
    const { srv } = armar({ gpsLat: null, gpsLng: null }, { fotosVivienda: 0 });
    await empezar(srv, { id: 'u-6', name: 'Jefe bodega', permissions: ['area.tecnicos', 'inventory.admin'] });
  });

  it('una orden sin cliente no tiene datos que pedir', async () => {
    const { srv } = armar(null);
    await empezar(srv);
  });

  /**
   * La regla que no se puede romper: el candado es del ARRANQUE. Una orden ya
   * empezada con un cliente sin datos tiene que poder cerrarse, o queda abierta para
   * siempre — es el mismo motivo por el que "una orden a la vez" tampoco frena el
   * cierre.
   */
  it('CERRAR nunca se frena por esto (llega hasta la geo-cerca)', async () => {
    const CENTINELA = new Error('el cierre siguió su camino');
    const { srv } = armar(
      { gpsLat: null, gpsLng: null },
      { fotosVivienda: 0, estadoActual: 'REALIZANDO', centinelaCerca: CENTINELA },
    );
    // Se para en la cerca, no en este candado: ése es justamente el punto.
    await expect(srv.updateStatus('t-1', { status: 'RESUELTO' }, TECNICO)).rejects.toBe(CENTINELA);
  });

  it('devolver la orden a PENDIENTE tampoco', async () => {
    const { srv, prisma } = armar({ gpsLat: null, gpsLng: null }, { estadoActual: 'REALIZANDO' });
    await srv.updateStatus('t-1', { status: 'PENDIENTE' }, TECNICO);
    expect(prisma.ticket.update).toHaveBeenCalled();
  });

  it('se apaga con TICKET_REQUIRE_CLIENT_DATA=false', async () => {
    process.env.TICKET_REQUIRE_CLIENT_DATA = 'false';
    try {
      const { srv } = armar({ gpsLat: null, gpsLng: null }, { fotosVivienda: 0 });
      await empezar(srv);
    } finally {
      delete process.env.TICKET_REQUIRE_CLIENT_DATA;
    }
  });
});
