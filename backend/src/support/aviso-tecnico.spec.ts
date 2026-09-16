import { AvisoTecnicoService } from './aviso-tecnico.service';

/**
 * Lo que estas pruebas defienden es la queja que las trajo (2026-09-04): "los
 * técnicos están viendo de todo". La campanita del técnico tiene que quedarse con lo
 * que él tiene que HACER — la orden que es suya AHORA, con la caja que se lleva— y
 * soltar lo que dejó de serlo en cuanto deja de serlo.
 */
describe('AvisoTecnicoService', () => {
  const EVENTO = {
    ticketId: 't1', code: 500900, type: 'Instalacion', subscriberId: 'sub-1',
    tecnico: 'Miguel Angel Alvarez', abiertaPor: 'cajera',
  };

  const armar = (o: { ficha?: any; user?: any; reservado?: any } = {}) => {
    const avisados: any[] = [];
    const retirados: any[] = [];
    const prisma: any = {
      staff: { findFirst: jest.fn().mockResolvedValue(o.ficha === undefined ? { name: 'Miguel Angel Alvarez', email: 'miguel@vestel.com.co' } : o.ficha) },
      user: { findFirst: jest.fn().mockResolvedValue(o.user === undefined ? { id: 'u-miguel', name: 'Miguel Angel Alvarez' } : o.user) },
      equipment: { findMany: jest.fn().mockResolvedValue(o.reservado ? [o.reservado] : []) },
      // El aviso llega con el ticketId pelado: `equiposDeOrdenes` pregunta de quién
      // es la orden para poder mirar si el cliente ya tiene equipo a su nombre.
      ticket: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const avisos: any = {
      notify: jest.fn(async (ids: string[], input: any) => { avisados.push({ ids, input }); }),
      retirar: jest.fn(async (groupKey: string, kind: string, excepto: string[] = []) => { retirados.push({ groupKey, kind, excepto }); return 1; }),
    };
    return { svc: new AvisoTecnicoService(prisma, avisos), avisados, retirados, avisos };
  };

  it('le avisa al técnico de la orden que le asignaron', async () => {
    const { svc, avisados } = armar();
    await svc.alAsignar(EVENTO as never);
    expect(avisados).toHaveLength(1);
    expect(avisados[0].ids).toEqual(['u-miguel']);
    expect(avisados[0].input.kind).toBe('soporte.orden_asignada');
    expect(avisados[0].input.groupKey).toBe('ticket:t1');
  });

  it('le retira la orden al técnico anterior, y sólo a él', async () => {
    const { svc, retirados } = armar();
    await svc.alAsignar(EVENTO as never);
    expect(retirados).toEqual([
      { groupKey: 'ticket:t1', kind: 'soporte.orden_asignada', excepto: ['u-miguel'] },
    ]);
  });

  it('retira igual aunque el técnico nuevo no tenga login (los del legacy)', async () => {
    const { svc, retirados, avisados } = armar({ user: null });
    await svc.alAsignar(EVENTO as never);
    // El anterior deja de verla aunque al de ahora no se le pueda avisar: son dos
    // cosas distintas y la primera no depende de la segunda.
    expect(retirados[0].excepto).toEqual([]);
    expect(avisados).toHaveLength(0);
  });

  it('desasignar también le quita el aviso al que la tenía', async () => {
    const { svc, retirados } = armar();
    await svc.alDesasignar('t1');
    expect(retirados).toEqual([{ groupKey: 'ticket:t1', kind: 'soporte.orden_asignada', excepto: [] }]);
  });

  it('le dice qué equipo llevarse cuando la orden tiene uno apartado', async () => {
    const { svc, avisados } = armar({
      reservado: { id: 'e1', code: 4821, serial: 'HWTC12AB34CD', reservedTicketId: 't1', warehouse: { name: 'Yopal' } },
    });
    await svc.alAsignar(EVENTO as never);
    expect(avisados[0].input.body).toContain('Llévese el equipo 4821');
    expect(avisados[0].input.body).toContain('HWTC12AB34CD');
  });

  it('avisa EN ÁMBAR cuando la orden pide equipo y no hay ninguno apartado', async () => {
    const { svc, avisados } = armar();
    await svc.alAsignar(EVENTO as never);
    expect(avisados[0].input.body).toContain('no hay ninguno apartado');
  });

  it('no habla de equipo en las órdenes que no lo llevan', async () => {
    const { svc, avisados } = armar();
    await svc.alAsignar({ ...EVENTO, type: 'Revision de Internet' } as never);
    expect(avisados[0].input.body).toBe('Te asignaron esta orden. Está en Mi agenda.');
  });

  it('un fallo del aviso no puede tumbar la asignación', async () => {
    const { svc } = armar();
    (svc as any).avisos.notify = jest.fn().mockRejectedValue(new Error('BD caída'));
    await expect(svc.alAsignar(EVENTO as never)).resolves.toBeUndefined();
  });
});
