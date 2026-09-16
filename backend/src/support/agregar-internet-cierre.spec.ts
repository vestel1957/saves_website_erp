import 'reflect-metadata';
import { SupportWriteService } from './support-write.service';
import { esAgregarInternet, ordenLlevaPlanInternet } from './order-types';

/**
 * AGREGAR INTERNET: cerrar la orden tiene que MONTARLE el internet al cliente.
 *
 * El 07-09-2026 se cerró la orden #505503 (abonado 2169, «SoloTelevision22») y no
 * pasó nada: se le habían cobrado los 30.000 del cargo al abrirla y su ficha seguía
 * enseñando la televisión sola. La causa eran dos agujeros encadenados: el
 * formulario no pedía el plan de internet —así que la orden salía sin `planToId`— y
 * 'AgregarInternet' no caía en ninguna rama de `applyCloseCascade` (no contiene
 * 'megas', ni 'plan', ni 'instalac', ni 'reconex'), con lo cual cerrarla era, en
 * cuanto al servicio, exactamente igual que no cerrarla.
 *
 * Lo que se comprueba aquí es lo que se rompe por su lado: que la orden porte el
 * plan, que el cierre deje el `SubscriberService` de internet —que es lo que factura
 * la corrida mensual y lo que la ficha lee como "sus servicios"—, que cree el secret
 * en el router (y el usuario PPPoE si el legacy lo dejó en relleno), que cobre los
 * días que quedan del mes y no el mes entero, y que nada de eso tumbe el cierre.
 */
function armar(opts: { plan?: any; suyo?: any[]; cambio?: any; provision?: any; cred?: any; prorrateo?: any } = {}) {
  const sub = { id: 'sub-1', nomenclature: {}, addressLine: null, neighborhood: '77' };
  const plan = opts.plan ?? { id: 'plan-300', name: '300 Megas --', kind: 'INTERNET', megas: 300, active: true, price: 80000, taxRate: 0 };
  const prisma = {
    subscriber: { findUnique: jest.fn().mockResolvedValue(sub), update: jest.fn().mockResolvedValue({}) },
    plan: { findUnique: jest.fn().mockResolvedValue(plan) },
    subscriberService: { findMany: jest.fn().mockResolvedValue(opts.suyo ?? []) },
    subscriberStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    ticket: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: any) =>
      fn({
        ticket: { create: jest.fn(() => Promise.resolve({ id: 't-1', code: 505503 })) },
        subscriber: { update: jest.fn().mockResolvedValue({}) },
        $queryRaw: jest.fn().mockResolvedValue([{ tid: 505503n }]),
      }),
    ),
  };
  const planes = {
    changePlan: opts.cambio ?? jest.fn().mockResolvedValue({ ok: true, plan: { id: plan.id, name: plan.name }, router: null }),
    asegurarCredencialesPpp: opts.cred ?? jest.fn().mockResolvedValue({ ok: true, creado: true, pppUsername: 'WINDYMUNOZ' }),
  };
  const mikrotik = {
    provision: opts.provision ?? jest.fn().mockResolvedValue({ ok: true, message: 'Alta aplicada: WINDYMUNOZ provisionado en MK-Yopal.' }),
  };
  const prorrateo = {
    aplicar: opts.prorrateo ?? jest.fn().mockResolvedValue({
      aplica: true, cobrado: true, dias: 24, total: 64000,
      mensaje: 'Cobrados 24 día(s) de 300 Megas -- = $64.000 en la factura Nº 505017.',
    }),
  };
  const srv = new SupportWriteService(
    prisma as any, mikrotik as any, {} as any, { notifyPost: jest.fn().mockResolvedValue(undefined) } as any,
    { emit: jest.fn() } as any, {} as any, {} as any,
    prorrateo as any, undefined, undefined, planes as any,
  );
  return { srv, prisma, planes, mikrotik, prorrateo };
}

const USUARIO = { id: 'u-1', name: 'Santiago García', email: 'soporte@vestel.com.co', areas: ['soporte'] } as any;
const cerrar = (srv: any, planToId: string | null = 'plan-300') =>
  srv.applyCloseCascade({ ticketId: 't-1', subscriberId: 'sub-1', type: 'AgregarInternet', planToId, code: 505503 }, USUARIO);

describe('qué órdenes llevan plan de internet', () => {
  it('las de megas y la de agregar internet, y sólo ésas', () => {
    expect(ordenLlevaPlanInternet('Subir megas')).toBe(true);
    expect(ordenLlevaPlanInternet('Bajar megas')).toBe(true);
    expect(ordenLlevaPlanInternet('AgregarInternet')).toBe(true);
    expect(ordenLlevaPlanInternet(' agregarinternet ')).toBe(true);
    expect(ordenLlevaPlanInternet('AgregarTelevision')).toBe(false);
    expect(ordenLlevaPlanInternet('Reconexion Internet')).toBe(false);
    expect(ordenLlevaPlanInternet('Instalacion')).toBe(false);
    // El detalle se escribe pegado y sin tilde porque así está en el legacy.
    expect(esAgregarInternet('Agregar Internet')).toBe(false);
  });
});

describe('abrir una orden de agregar internet', () => {
  it('exige decir con qué plan queda el cliente', async () => {
    const { srv } = armar();
    await expect(
      srv.createTicket({ subscriberId: 'sub-1', subject: 'servicio', type: 'AgregarInternet' } as any, USUARIO),
    ).rejects.toThrow(/con qué plan de internet queda/i);
  });

  it('no se le agrega internet al que ya lo tiene: eso es un cambio de plan', async () => {
    const { srv } = armar({
      suyo: [{ planId: 'plan-100', planName: '100 MEGAS --', megas: 100, status: 'ACTIVO', plan: { name: '100 MEGAS --', megas: 100 } }],
    });
    await expect(
      srv.createTicket({ subscriberId: 'sub-1', subject: 'servicio', type: 'AgregarInternet', planToId: 'plan-300' } as any, USUARIO),
    ).rejects.toThrow(/ya tiene internet/i);
  });

  it('la observación dice CON QUÉ queda, no "de … a …": no viene de ningún plan', async () => {
    const { srv } = armar();
    const megas: any = await (srv as any).prepararCambioDeMegas(
      { type: 'AgregarInternet', planToId: 'plan-300' }, 'sub-1',
    );
    expect(megas.notaObservacion).toBe('AgregarInternet: con 300 Megas (plan «300 Megas --»).');
    expect(megas.notaObservacion).not.toMatch(/plan sin registrar/);
  });
});

describe('cerrar una orden de agregar internet', () => {
  it('deja el servicio contratado, el secret en el router y los días del mes cobrados', async () => {
    const { srv, planes, mikrotik, prorrateo, prisma } = armar();

    const cascade = await cerrar(srv);

    // 1) El servicio en la ficha. `pushRouter: false` porque el secret todavía no
    // existe: lo crea `provision` con el perfil que este paso acaba de escribir.
    expect(planes.changePlan).toHaveBeenCalledWith('sub-1', 'plan-300', USUARIO, { allowInactive: true, pushRouter: false });
    // 2 y 3) Usuario PPPoE y alta en el Mikrotik.
    expect(planes.asegurarCredencialesPpp).toHaveBeenCalledWith('sub-1', USUARIO);
    expect(mikrotik.provision).toHaveBeenCalledWith('sub-1', USUARIO);
    // 4) Los días que quedan del mes, por el mismo prorrateo de una reconexión.
    expect(prorrateo.aplicar).toHaveBeenCalledWith('sub-1', ['INTERNET'], expect.objectContaining({ ctx: 'orden #505503' }));
    // Y el sello, que es lo que dice que esta orden ya movió al cliente.
    expect(prisma.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 't-1' }, data: { planAppliedAt: expect.any(Date) } }),
    );

    expect(cascade.internet.aplicado).toBe(true);
    expect(cascade.note).toMatch(/quedó con internet «300 Megas --» \(300 Megas\)/);
    expect(cascade.note).toMatch(/WINDYMUNOZ/);
    expect(cascade.note).toMatch(/24 día\(s\)/);
  });

  it('NO le cambia el estado ni le toca la televisión: sólo suma un servicio', async () => {
    const { srv, prisma } = armar();

    const cascade = await cerrar(srv);

    // Un ACTIVO con televisión que estrena internet sigue igual de ACTIVO. Escribir
    // el estado aquí sería la trampa de siempre (ver `soloTv` en la cascada).
    expect(cascade.statusSet).toBeUndefined();
    expect(prisma.subscriberStatusHistory.create).not.toHaveBeenCalled();
    expect(cascade.tv).toBeUndefined();
  });

  it('sin plan en la orden no inventa uno: dice qué falta y dónde', async () => {
    const { srv, planes, prorrateo } = armar();

    const cascade = await cerrar(srv, null);

    expect(planes.changePlan).not.toHaveBeenCalled();
    expect(prorrateo.aplicar).not.toHaveBeenCalled();
    expect(cascade.internet.aplicado).toBe(false);
    expect(cascade.note).toMatch(/no dice con qué plan/i);
  });

  it('el router que no responde no deshace el contrato: se cobra igual y se avisa', async () => {
    const { srv, planes, prorrateo } = armar({
      provision: jest.fn().mockResolvedValue({ ok: false, message: 'Fallo el alta.', error: 'no route to host' }),
    });

    const cascade = await cerrar(srv);

    expect(planes.changePlan).toHaveBeenCalled();
    expect(prorrateo.aplicar).toHaveBeenCalled();
    expect(cascade.internet.aplicado).toBe(true);
    expect(cascade.note).toMatch(/El router no tomó el alta: no route to host/);
  });

  it('si el plan no se pudo asignar, no se cobra nada y el cierre lo dice', async () => {
    const { srv, prorrateo, mikrotik } = armar({
      cambio: jest.fn().mockRejectedValue(new Error('El plan está inactivo; actívalo antes de asignarlo.')),
    });

    const cascade = await cerrar(srv);

    expect(mikrotik.provision).not.toHaveBeenCalled();
    expect(prorrateo.aplicar).not.toHaveBeenCalled();
    expect(cascade.internet.aplicado).toBe(false);
    expect(cascade.note).toMatch(/No se le pudo montar el internet/);
  });

  it('sin nombre del que derivar el usuario PPPoE no se crea un secret basura', async () => {
    const { srv, mikrotik, prorrateo } = armar({
      cred: jest.fn().mockResolvedValue({ ok: false, creado: false, pppUsername: null, motivo: 'El cliente no tiene nombre del que derivar el usuario PPPoE: escríbelo en su ficha.' }),
    });

    const cascade = await cerrar(srv);

    expect(mikrotik.provision).not.toHaveBeenCalled();
    // El servicio sí queda contratado y los días se cobran: lo que falta es la red.
    expect(prorrateo.aplicar).toHaveBeenCalled();
    expect(cascade.note).toMatch(/No se creó el secret/);
  });
});
