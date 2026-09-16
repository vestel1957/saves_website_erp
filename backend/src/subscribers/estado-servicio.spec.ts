import 'reflect-metadata';
import { SubscribersService } from './subscribers.service';
import { ESTADO_SERVICIO_EVENT } from './subscribers.events';

/**
 * Cambiar A MANO el estado de un servicio (su TV o su internet).
 *
 * Existe porque hasta el 31-08-2026 ese estado sólo se movía cerrando una orden, y
 * cuando la orden no lo movía —la #502150— no había forma de corregirlo: la ficha
 * seguía diciendo que la televisión estaba al aire con el cliente suspendido en la
 * calle.
 */
function armar(factura: any = { id: 'fac-1', serviceTv: 'Television26', serviceCombo: '300Megas26F' }) {
  const facturas: any[] = [];
  const servicios: any[] = [];
  const notas: any[] = [];
  const emitidos: any[] = [];
  const prisma: any = {
    subscriber: { findUnique: jest.fn().mockResolvedValue({ id: 'sub-1' }) },
    subInvoice: { update: jest.fn(async (a: any) => { facturas.push(a.data); return {}; }) },
    subscriberService: { updateMany: jest.fn(async (a: any) => { servicios.push(a); return { count: 1 }; }) },
    subscriberNote: { create: jest.fn(async (a: any) => { notas.push(a.data); return {}; }) },
    $queryRaw: jest.fn().mockResolvedValue(factura ? [factura] : []),
  };
  const events: any = { emit: jest.fn((n: string, p: any) => { emitidos.push([n, p]); return true; }) };
  const ordenes: any = {
    registrarResuelta: jest.fn(async (i: any) => ({ id: 'ord-1', code: 500123, type: i.type, nueva: true, estado: 'RESUELTO' })),
  };
  const srv = new SubscribersService(prisma, {} as any, {} as any, {} as any, events, ordenes);
  // La ficha completa no se prueba aquí: sólo lo que este método escribe.
  (srv as any).detail = jest.fn().mockResolvedValue({ ok: true });
  const cambiar = (dto: any) => srv.cambiarEstadoDeServicio('sub-1', dto, { name: 'Nayme' } as any);
  return { cambiar, facturas, servicios, notas, emitidos, ordenes };
}

describe('cambio manual del estado de un servicio', () => {
  it('suspende la TV en la factura vigente y deja la marca que la salva de la ida', async () => {
    const { cambiar, facturas, emitidos } = armar();
    await cambiar({ servicio: 'TV', estado: 'SUSPENDIDO' });

    expect(facturas[0]).toMatchObject({ estadoTv: 'SUSPENDIDO', serviceStatusBy: 'Nayme' });
    expect(facturas[0].estadoCombo).toBeUndefined(); // su internet no se toca
    expect(facturas[0].serviceStatusAt).toBeInstanceOf(Date);
    // Al legacy en el acto: su ida trae esas columnas cada 15 minutos.
    expect(emitidos[0][0]).toBe(ESTADO_SERVICIO_EVENT);
  });

  it('devolver el servicio al aire escribe NULL, que es como el legacy dice "sin corte"', async () => {
    const { cambiar, facturas } = armar();
    await cambiar({ servicio: 'INTERNET', estado: 'ACTIVO' });
    expect(facturas[0].estadoCombo).toBeNull();
  });

  it('los puntos de TV corren la suerte de la televisión', async () => {
    const { cambiar, servicios } = armar();
    await cambiar({ servicio: 'TV', estado: 'CORTADO' });
    expect(servicios[0].where.kind).toEqual({ in: ['TV', 'PUNTOS'] });
    expect(servicios[0].data).toEqual({ status: 'CORTADO' });
  });

  it('deja constancia en las observaciones del cliente (no hay historial por servicio)', async () => {
    const { cambiar, notas } = armar();
    await cambiar({ servicio: 'TV', estado: 'SUSPENDIDO', note: 'daño del equipo' });
    expect(notas[0].body).toContain('Televisión: suspendido');
    expect(notas[0].body).toContain('daño del equipo');
  });

  it('no le inventa televisión a quien no la tiene en su factura', async () => {
    const { cambiar, facturas } = armar({ id: 'fac-1', serviceTv: 'no', serviceCombo: '300Megas26F' });
    await expect(cambiar({ servicio: 'TV', estado: 'SUSPENDIDO' })).rejects.toThrow(/no incluye televisión/i);
    expect(facturas).toHaveLength(0);
  });

  it('sin factura recurrente no hay dónde anotarlo, y se dice', async () => {
    const { cambiar } = armar(null);
    await expect(cambiar({ servicio: 'TV', estado: 'SUSPENDIDO' })).rejects.toThrow(/factura recurrente/i);
  });

  /**
   * El corte de TV se hace A MANO —el TR-069 no alcanza a la mayoría de los equipos—,
   * así que la orden que lo respalda tiene que nacer aquí: sin ella el trabajo no
   * existe para nadie (ni ficha, ni informes de campo, ni legacy) y la señal de
   * "¿sigue cortado?" mira un corte sin rastro.
   */
  it('el corte manual de TV deja su orden, ya cerrada', async () => {
    const { cambiar, ordenes } = armar();
    await cambiar({ servicio: 'TV', estado: 'CORTADO', note: 'corte por mora' });

    expect(ordenes.registrarResuelta).toHaveBeenCalledWith(
      expect.objectContaining({ subscriberId: 'sub-1', type: 'Corte Television', subject: 'servicio', autor: 'Nayme' }),
    );
    // El detalle largo cuenta por qué no hay rastro en los equipos, y arrastra el motivo.
    const arg = ordenes.registrarResuelta.mock.calls[0][0];
    expect(arg.section).toContain('manualmente');
    expect(arg.section).toContain('corte por mora');
  });

  it('cada estado tiene su orden, y por servicio', async () => {
    for (const [servicio, estado, tipo] of [
      ['TV', 'SUSPENDIDO', 'Suspension Television'],
      ['TV', 'ACTIVO', 'Reconexion Television'],
      ['INTERNET', 'CORTADO', 'Corte Internet'],
      ['INTERNET', 'ACTIVO', 'Reconexion Internet'],
    ] as const) {
      const { cambiar, ordenes } = armar();
      await cambiar({ servicio, estado });
      expect(ordenes.registrarResuelta.mock.calls[0][0].type).toBe(tipo);
    }
  });

  it('la reconexión NO se lleva por delante una "…2": ésa hay que cobrarla al cerrarla', async () => {
    const { cambiar, ordenes } = armar();
    await cambiar({ servicio: 'TV', estado: 'ACTIVO' });
    expect(ordenes.registrarResuelta.mock.calls[0][0].tiposEquivalentes).toBeUndefined();
  });

  it('el número de la orden viaja en la respuesta (el toast lo enseña)', async () => {
    const { cambiar } = armar();
    await expect(cambiar({ servicio: 'TV', estado: 'CORTADO' })).resolves.toMatchObject({
      orden: { code: 500123, type: 'Corte Television' },
    });
  });

  it('si la orden no se puede escribir, el cambio de estado se guarda igual', async () => {
    const { cambiar, facturas, ordenes } = armar();
    ordenes.registrarResuelta.mockResolvedValueOnce(null);
    await expect(cambiar({ servicio: 'TV', estado: 'CORTADO' })).resolves.toMatchObject({ orden: null });
    expect(facturas[0]).toMatchObject({ estadoTv: 'CORTADO' });
  });
});
