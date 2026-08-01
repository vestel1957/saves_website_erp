import { TicketConfirmacionService } from './ticket-confirmacion.service';
import { BOT_ACTOR } from './chatbot.identity';
import type { TicketResueltoEvent } from '../support/support.events';

/**
 * El bucle que SAM cerraba con botones de Telegram. Lo que se fija aquí es el alcance
 * —a QUIÉN se le pregunta— y qué pasa con cada respuesta, porque los dos extremos
 * hacen daño: preguntarle a todo el mundo es spam a 7.000 abonados, y no preguntarle a
 * nadie es lo que hay hoy (el cliente se queda sin saber que su orden se cerró).
 */

const ORDEN_DEL_BOT: TicketResueltoEvent = {
  ticketId: 'tk-1',
  code: 5001,
  type: 'Revision de Internet',
  subscriberId: 'sub-1',
  abiertaPor: BOT_ACTOR.name,
};

function armar(opts: { conv?: any; ticket?: any } = {}) {
  const enviados: Array<{ phone: string; texto: string; opts?: any }> = [];
  const notas: Array<{ ticketId: string; mensaje: string }> = [];
  const creados: any[] = [];
  const updates: any[] = [];

  const conv = opts.conv === undefined
    ? { phone: '573001112233', status: 'BOT', awaitingTicketId: null, awaitingSince: null }
    : opts.conv;

  const prisma: any = {
    whatsappConversation: {
      findFirst: jest.fn(async () => conv),
      findUnique: jest.fn(async () => conv),
      update: jest.fn(async ({ data }: any) => { updates.push(data); return {}; }),
    },
    ticket: {
      findUnique: jest.fn(async () => opts.ticket ?? {
        id: 'tk-1', code: 5001, type: 'Revision de Internet', subscriberId: 'sub-1',
      }),
    },
  };
  const whatsapp: any = {
    sendText: jest.fn(async (phone: string, texto: string, o?: any) => {
      enviados.push({ phone, texto, opts: o });
      return true;
    }),
  };
  const soporte: any = {
    createTicket: jest.fn(async (dto: any) => { creados.push(dto); return { id: 'tk-9', code: 5099 }; }),
    addThread: jest.fn(async (ticketId: string, dto: any) => { notas.push({ ticketId, mensaje: dto.message }); return { ok: true }; }),
  };

  // El interruptor de Configuración → Agente de WhatsApp, encendido.
  const gate: any = { conductas: jest.fn(async () => ({ confirmarSolucion: true, avisosProactivos: false })) };

  return {
    svc: new TicketConfirmacionService(prisma, whatsapp, soporte, gate),
    enviados, notas, creados, updates, prisma, gate,
  };
}

describe('a quién se le pregunta al cerrar una orden', () => {
  it('a un cliente cuya orden nació en WhatsApp, y le deja la espera marcada', async () => {
    const { svc, enviados, updates } = armar();
    await svc.alResolver(ORDEN_DEL_BOT);

    expect(enviados).toHaveLength(1);
    expect(enviados[0].phone).toBe('573001112233');
    expect(enviados[0].texto).toContain('#5001');
    expect(enviados[0].texto).toContain('¿Me confirma');
    // Clave: el técnico puede cerrar la orden al día siguiente y la ventana de 24 h de
    // Meta ya estaría cerrada. Sin plantilla, justo este mensaje no saldría.
    expect(enviados[0].opts?.reopenWithTemplate).toBe(true);
    expect(updates[0].awaitingTicketId).toBe('tk-1');
  });

  it('a NADIE cuando la orden no la abrió el bot', async () => {
    // Es el freno que evita la campaña de spam: el ERP cierra cientos de cortes y
    // reconexiones al día, y por esos no se le pregunta nada a nadie.
    const { svc, enviados } = armar();
    await svc.alResolver({ ...ORDEN_DEL_BOT, abiertaPor: 'Ana Gómez' });
    await svc.alResolver({ ...ORDEN_DEL_BOT, abiertaPor: null });
    expect(enviados).toHaveLength(0);
  });

  it('a nadie si un compañero está atendiendo ese chat a mano', async () => {
    for (const status of ['ASIGNADA', 'PENDIENTE']) {
      const { svc, enviados } = armar({ conv: { phone: '573001112233', status, awaitingTicketId: null, awaitingSince: null } });
      await svc.alResolver(ORDEN_DEL_BOT);
      expect(enviados).toHaveLength(0);
    }
  });

  it('a nadie si ese cliente nunca nos ha escrito (no hay conversación)', async () => {
    const { svc, enviados } = armar({ conv: null });
    await svc.alResolver(ORDEN_DEL_BOT);
    expect(enviados).toHaveLength(0);
  });

  it('no apila una segunda pregunta si la primera sigue sin responder', async () => {
    const { svc, enviados } = armar({
      conv: { phone: '573001112233', status: 'BOT', awaitingTicketId: 'tk-otra', awaitingSince: new Date() },
    });
    await svc.alResolver(ORDEN_DEL_BOT);
    expect(enviados).toHaveLength(0);
  });

  it('no revienta ni deshace el cierre si el envío falla', async () => {
    const { svc, updates, prisma } = armar();
    prisma.whatsappConversation.findFirst = jest.fn(async () => { throw new Error('BD caída'); });
    await expect(svc.alResolver(ORDEN_DEL_BOT)).resolves.toBeUndefined();
    expect(updates).toHaveLength(0);
  });
});

describe('cuando el cliente contesta', () => {
  const esperando = {
    phone: '573001112233', status: 'BOT',
    awaitingTicketId: 'tk-1', awaitingSince: new Date(),
  };

  it('"ya quedó" cierra el caso, lo agradece y lo anota en la orden', async () => {
    const { svc, enviados, notas, creados } = armar({ conv: esperando });
    const manejado = await svc.intentarResponder('573001112233', 'ya quedó, gracias');

    expect(manejado).toBe(true);
    expect(enviados[0].texto).toContain('funcionando');
    expect(notas[0].mensaje).toContain('confirmó');
    // Lo importante: NO se abre una re-visita que nadie necesita.
    expect(creados).toHaveLength(0);
  });

  it('"sigue igual" abre una re-visita en prioridad Alta, del mismo tipo', async () => {
    const { svc, enviados, notas, creados } = armar({ conv: esperando });
    const manejado = await svc.intentarResponder('573001112233', 'no, sigue igual');

    expect(manejado).toBe(true);
    expect(creados).toHaveLength(1);
    expect(creados[0].priority).toBe('Alta');
    expect(creados[0].type).toBe('Revision de Internet');
    expect(creados[0].subject).toContain('#5001');
    // El cliente recibe el número nuevo, no un "ya escalé su caso" sin nada agarrable.
    expect(enviados[0].texto).toContain('#5099');
    expect(notas[0].mensaje).toContain('#5099');
  });

  it('"bueno" NO abre una re-visita (el bug de SAM, de punta a punta)', async () => {
    const { svc, creados } = armar({ conv: esperando });
    await svc.intentarResponder('573001112233', 'bueno');
    expect(creados).toHaveLength(0);
  });

  it('si escribe otra cosa, suelta la espera y lo atiende el bot', async () => {
    const { svc, enviados, creados, updates } = armar({ conv: esperando });
    const manejado = await svc.intentarResponder('573001112233', '¿cuánto debo este mes?');

    // false = el mensaje sigue su camino normal hacia el bot. Es la diferencia con SAM,
    // que respondía "¿el servicio está funcionando? (responde sí o no)" en bucle.
    expect(manejado).toBe(false);
    expect(enviados).toHaveLength(0);
    expect(creados).toHaveLength(0);
    expect(updates[0].awaitingTicketId).toBeNull();
  });

  it('una espera de hace tres días ya no se interpreta como respuesta', async () => {
    const vieja = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const { svc, enviados, creados } = armar({
      conv: { ...esperando, awaitingSince: vieja },
    });
    const manejado = await svc.intentarResponder('573001112233', 'no');
    expect(manejado).toBe(false);
    expect(creados).toHaveLength(0);
    expect(enviados).toHaveLength(0);
  });

  it('sin espera pendiente no toca nada', async () => {
    const { svc, enviados, creados } = armar({
      conv: { phone: '573001112233', status: 'BOT', awaitingTicketId: null, awaitingSince: null },
    });
    expect(await svc.intentarResponder('573001112233', 'no')).toBe(false);
    expect(enviados).toHaveLength(0);
    expect(creados).toHaveLength(0);
  });
});
