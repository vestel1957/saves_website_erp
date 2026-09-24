import 'reflect-metadata';
import { SubscribersService } from './subscribers.service';
import { ESTADO_ABONADO_EVENT } from './subscribers.events';

/**
 * Cambio MANUAL del estado del abonado desde la ficha.
 *
 * Lo que se prueba aquí no es el UPDATE —eso es una línea de Prisma— sino las dos cosas
 * de las que depende que el cambio DURE: la fila de historial con el sello "Cambio
 * manual" (es el único rastro por el que `pushEstadoManual` distingue lo que tecleó una
 * persona de lo que bajó de la ida) y el evento que dispara el empuje inmediato al
 * legacy. Sin cualquiera de las dos, el estado escrito a mano se deshace solo en la
 * siguiente ida, que es justo el agujero que destapó el abonado 56755: retirado por
 * devolución de equipo, con saldo pendiente, al que Cartera quiere devolverle el estado.
 */
function armar(actual = 'RETIRADO') {
  const historial: any[] = [];
  const fichas: any[] = [];
  const emitidos: any[] = [];
  const prisma: any = {
    subscriber: { findUnique: jest.fn().mockResolvedValue({ id: 'sub-1', status: actual }) },
    subscriberStatusHistory: { create: jest.fn((a: any) => { historial.push(a.data); return a; }) },
    subscriberNote: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (ops: any[]) => ops),
  };
  prisma.subscriber.update = jest.fn((a: any) => { fichas.push(a.data); return a; });
  const events: any = { emit: jest.fn((n: string, p: any) => { emitidos.push([n, p]); return true; }) };
  const srv = new SubscribersService(prisma, {} as any, {} as any, {} as any, events, {} as any);
  (srv as any).detail = jest.fn().mockResolvedValue({ ok: true });
  const cambiar = (dto: any) => srv.changeStatus('sub-1', dto, { name: 'Paula Andrea' } as any);
  return { cambiar, historial, fichas, emitidos };
}

describe('cambio manual del estado del abonado', () => {
  it('sale al legacy EN EL ACTO: sin eso la ida lo deshace a los 15 minutos', async () => {
    const { cambiar, emitidos } = armar('RETIRADO');
    await cambiar({ status: 'CARTERA', note: 'se retiró debiendo 77.000' });

    expect(emitidos).toHaveLength(1);
    expect(emitidos[0][0]).toBe(ESTADO_ABONADO_EVENT);
    expect(emitidos[0][1]).toMatchObject({ subscriberId: 'sub-1', estado: 'CARTERA', anterior: 'RETIRADO' });
  });

  it('el historial lleva el sello "Cambio manual", que es lo que mira el writeback', async () => {
    const { cambiar, historial } = armar('RETIRADO');
    await cambiar({ status: 'CARTERA', note: 'se retiró debiendo' });

    expect(historial[0].status).toBe('CARTERA');
    // El sello va al PRINCIPIO: `pushEstadoManual` filtra por `startsWith`.
    expect(historial[0].note.startsWith('Cambio manual')).toBe(true);
    expect(historial[0].note).toContain('Paula Andrea');
    expect(historial[0].note).toContain('se retiró debiendo');
  });

  it('guarda el estado anterior en la ficha (es el `ultimo_estado` del legacy)', async () => {
    const { cambiar, fichas } = armar('RETIRADO');
    await cambiar({ status: 'CORTADO' });
    expect(fichas[0]).toMatchObject({ previousStatus: 'RETIRADO', status: 'CORTADO' });
    expect(fichas[0].statusChangedAt).toBeInstanceOf(Date);
  });

  it('no se puede "cambiar" al estado que ya tiene: sería una fila de historial en balde', async () => {
    const { cambiar, emitidos } = armar('CARTERA');
    await expect(cambiar({ status: 'CARTERA' })).rejects.toThrow(/ya está en ese estado/i);
    expect(emitidos).toHaveLength(0);
  });
});
