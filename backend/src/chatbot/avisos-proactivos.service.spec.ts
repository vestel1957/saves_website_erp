import { AvisosProactivosService } from './avisos-proactivos.service';
import { BOT_ACTOR } from './chatbot.identity';

/**
 * Los avisos proactivos son lo único que el bot le manda a alguien que no escribió
 * nada. El riesgo no es que falten: es que sobren. Un aviso de más no es un mensaje
 * raro en un chat — es una queja, y en Meta una queja baja la calificación del número
 * y con ella la capacidad de enviar. Por eso lo que se prueba aquí es, sobre todo,
 * CUÁNDO NO se manda.
 */

function armar(opts: { activo?: boolean; conv?: any } = {}) {
  const enviados: Array<{ phone: string; texto: string; opts?: any }> = [];
  const conv = opts.conv === undefined ? { phone: '573001112233', status: 'BOT' } : opts.conv;

  const prisma: any = {
    whatsappConversation: { findFirst: jest.fn(async () => conv) },
  };
  const whatsapp: any = {
    sendText: jest.fn(async (phone: string, texto: string, o?: any) => {
      enviados.push({ phone, texto, opts: o });
      return true;
    }),
  };
  const gate: any = {
    conductas: jest.fn(async () => ({
      confirmarSolucion: true,
      avisosProactivos: opts.activo ?? true,
    })),
  };
  return { svc: new AvisosProactivosService(prisma, whatsapp, gate), enviados };
}

const ASIGNADA = {
  ticketId: 'tk-1', code: 5001, type: 'Revision de Internet',
  subscriberId: 'sub-1', tecnico: 'Brayan Linares', abiertaPor: BOT_ACTOR.name,
};

const PAGO = { subscriberId: 'sub-1', monto: 85000, reconexion: 'reconectado' as const };

describe('interruptor', () => {
  it('apagado no manda nada, ni de órdenes ni de pagos', async () => {
    const { svc, enviados } = armar({ activo: false });
    await svc.alAsignar(ASIGNADA);
    await svc.alPagar(PAGO);
    expect(enviados).toHaveLength(0);
  });
});

describe('técnico asignado', () => {
  it('avisa con el número de la orden y el nombre del técnico', async () => {
    const { svc, enviados } = armar();
    await svc.alAsignar(ASIGNADA);

    expect(enviados).toHaveLength(1);
    expect(enviados[0].texto).toContain('#5001');
    expect(enviados[0].texto).toContain('Brayan Linares');
    // El técnico puede asignar días después del último mensaje del cliente: sin
    // plantilla, el aviso moriría por la ventana de 24 h de Meta.
    expect(enviados[0].opts?.reopenWithTemplate).toBe(true);
  });

  it('NO avisa de las órdenes que no nacieron en WhatsApp', async () => {
    // El freno principal: el ERP reparte órdenes todo el día. Sin esto, cada reparto
    // sería una campaña masiva.
    const { svc, enviados } = armar();
    await svc.alAsignar({ ...ASIGNADA, abiertaPor: 'Ana Gómez' });
    expect(enviados).toHaveLength(0);
  });

  it('no revienta si la orden viene sin técnico o sin cliente', async () => {
    const { svc, enviados } = armar();
    await svc.alAsignar({ ...ASIGNADA, tecnico: null });
    await svc.alAsignar({ ...ASIGNADA, subscriberId: null });
    expect(enviados).toHaveLength(1);
    expect(enviados[0].texto).toContain('técnico asignado');
  });
});

describe('pago aplicado', () => {
  it('avisa cuando el pago DEVOLVIÓ el servicio', async () => {
    const { svc, enviados } = armar();
    await svc.alPagar(PAGO);
    expect(enviados).toHaveLength(1);
    expect(enviados[0].texto).toContain('ya quedó activo');
  });

  it('NO avisa de un pago normal de alguien que nunca estuvo cortado', async () => {
    // Si no, sería un mensaje mensual a cada uno de los 7.000 abonados.
    const { svc, enviados } = armar();
    await svc.alPagar({ ...PAGO, reconexion: 'no-aplica' });
    expect(enviados).toHaveLength(0);
  });

  it('NO avisa si la reconexión falló: el servicio NO volvió', async () => {
    // Decirle "ya quedó activo" a quien sigue cortado es peor que no decir nada.
    const { svc, enviados } = armar();
    await svc.alPagar({ ...PAGO, reconexion: 'fallo' });
    expect(enviados).toHaveLength(0);
  });
});

describe('a quién no se le escribe nunca', () => {
  it('a quien jamás nos ha escrito por WhatsApp', async () => {
    // El canal lo abre el cliente. Sin conversación, no hay consentimiento.
    const { svc, enviados } = armar({ conv: null });
    await svc.alAsignar(ASIGNADA);
    await svc.alPagar(PAGO);
    expect(enviados).toHaveLength(0);
  });

  it('a quien está atendiendo una persona en ese momento', async () => {
    for (const status of ['ASIGNADA', 'PENDIENTE']) {
      const { svc, enviados } = armar({ conv: { phone: '573001112233', status } });
      await svc.alAsignar(ASIGNADA);
      expect(enviados).toHaveLength(0);
    }
  });
});

describe('tope diario', () => {
  it('corta la avalancha si una operación masiva dispara cientos de eventos', async () => {
    const { svc, enviados } = armar();
    for (let i = 0; i < 200; i += 1) await svc.alPagar(PAGO);
    // 150 es el tope; lo que importa es que exista un techo y no 200 mensajes.
    expect(enviados.length).toBeLessThanOrEqual(150);
    expect(enviados.length).toBeGreaterThan(0);
  });
});
