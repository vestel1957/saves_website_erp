import 'reflect-metadata';
import { SupportWriteService } from './support-write.service';
import { esCambioDeMegas, sentidoDeMegas } from './order-types';

/**
 * La orden de MEGAS: el cliente se pasa a otro plan de internet.
 *
 * Hasta el 2026-09-02 'Subir megas' no decía A CUÁNTAS: el formulario no tenía
 * dónde escribirlo y la cascada de cierre dejaba la nota "aplica el nuevo plan
 * desde su ficha". El técnico salía sin saber a qué velocidad dejar al cliente y
 * el cambio de precio se hacía a mano.
 *
 * Lo que se comprueba aquí es lo que se rompe por su lado: que la orden porte el
 * plan destino, que el plan se le aplique al cliente al ABRIRLA —el botón de
 * "aplicar velocidad" contra la OLT lee el plan vigente, así que aplicarlo al
 * cerrar dejaría la ONU a la velocidad vieja— y que no se cuele una orden que dice
 * subir y baja.
 */
function armar(opts: { plan?: any; suyo?: any; cambio?: any } = {}) {
  const creados: any[] = [];
  const sub = { id: 'sub-1', nomenclature: {}, addressLine: null, neighborhood: '77' };
  const plan = opts.plan ?? { id: 'plan-400', name: '400 Megas F-26', kind: 'INTERNET', megas: 400, active: true };
  const suyo = opts.suyo === null
    ? []
    : [opts.suyo ?? { planId: 'plan-200', planName: '200 Megas F-25', megas: 200, status: 'ACTIVO', plan: { name: '200 Megas F-25', megas: 200 } }];
  const prisma = {
    subscriber: { findUnique: jest.fn().mockResolvedValue(sub) },
    plan: { findUnique: jest.fn().mockResolvedValue(plan) },
    subscriberService: { findMany: jest.fn().mockResolvedValue(suyo) },
    ticket: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: any) =>
      fn({
        ticket: { create: jest.fn((args: any) => { creados.push(args.data); return Promise.resolve({ id: 't-1', code: 500123 }); }) },
        subscriber: { update: jest.fn().mockResolvedValue({}) },
        $queryRaw: jest.fn().mockResolvedValue([{ tid: 500123n }]),
      }),
    ),
  };
  const porCargo = { notifyPost: jest.fn().mockResolvedValue(undefined) };
  const eventos = { emit: jest.fn() };
  const planes = {
    changePlan: opts.cambio ?? jest.fn().mockResolvedValue({
      ok: true, plan: { id: 'plan-400', name: '400 Megas F-26' }, router: { ok: true, message: 'Perfil aplicado.' },
    }),
  };
  const srv = new SupportWriteService(
    prisma as any, {} as any, {} as any, porCargo as any, eventos as any, {} as any, {} as any,
    undefined, undefined, undefined, planes as any,
  );
  return { srv, prisma, planes, creados };
}

const USUARIO = { id: 'u-1', name: 'Cajera', email: 'caja@vestel.com.co', areas: ['caja'] } as any;

describe('orden de megas', () => {
  it('reconoce las órdenes que cambian la velocidad, y hacia dónde', () => {
    expect(esCambioDeMegas('Subir megas')).toBe(true);
    expect(esCambioDeMegas(' BAJAR MEGAS ')).toBe(true);
    expect(esCambioDeMegas('Revision de Internet')).toBe(false);
    expect(sentidoDeMegas('Subir megas')).toBe('SUBIR');
    expect(sentidoDeMegas('Bajar megas')).toBe('BAJAR');
    expect(sentidoDeMegas('Instalacion')).toBeNull();
  });

  it('guarda a cuántas megas va y de cuántas venía, SIN moverle el plan al cliente', async () => {
    const { srv, planes, creados, prisma } = armar();

    const creada: any = await srv.createTicket(
      { subscriberId: 'sub-1', subject: 'servicio', type: 'Subir megas', planToId: 'plan-400' } as any,
      USUARIO,
    );

    // La orden porta las dos mitades de la frase: de cuánto a cuánto.
    expect(creados[0]).toMatchObject({
      type: 'Subir megas',
      planToId: 'plan-400',
      planToName: '400 Megas F-26',
      planToMegas: 400,
      planFromName: '200 Megas F-25',
      planFromMegas: 200,
    });
    // Y viaja en la observación, que es lo que ve el técnico en el sistema viejo.
    expect(creados[0].section).toContain('400 Megas');

    // Pero el cliente NO se mueve al abrirla: sigue en su plan —y pagando su
    // precio— hasta que el técnico cierre. Eso pasa en la cascada del cierre.
    expect(planes.changePlan).not.toHaveBeenCalled();
    expect(prisma.ticket.update).not.toHaveBeenCalled();
    expect(creada.megas).toMatchObject({ de: 200, a: 400, plan: '400 Megas F-26', aplicado: false });
    expect(creada.megas.mensaje).toMatch(/cuando se cierre la orden/i);
  });

  it('no abre una orden de megas sin decir a cuántas', async () => {
    const { srv } = armar();
    await expect(srv.createTicket({ subscriberId: 'sub-1', type: 'Subir megas' } as any, USUARIO))
      .rejects.toThrow(/qué plan/i);
  });

  it('no deja que un "Subir megas" baje la velocidad (ni al revés)', async () => {
    const { srv } = armar({ plan: { id: 'plan-100', name: '100 Megas', kind: 'INTERNET', megas: 100, active: true } });
    await expect(srv.createTicket(
      { subscriberId: 'sub-1', type: 'Subir megas', planToId: 'plan-100' } as any, USUARIO,
    )).rejects.toThrow(/no sube nada/i);

    const bajando = armar();
    await expect(bajando.srv.createTicket(
      { subscriberId: 'sub-1', type: 'Bajar megas', planToId: 'plan-400' } as any, USUARIO,
    )).rejects.toThrow(/no baja nada/i);
  });

  it('no acepta un plan que no es de internet ni uno oculto del catálogo', async () => {
    const tv = armar({ plan: { id: 'plan-tv', name: 'TV Full', kind: 'TV', megas: null, active: true } });
    await expect(tv.srv.createTicket(
      { subscriberId: 'sub-1', type: 'Subir megas', planToId: 'plan-tv' } as any, USUARIO,
    )).rejects.toThrow(/no es un plan de internet/i);

    const oculto = armar({ plan: { id: 'plan-x', name: '600 Megas viejo', kind: 'INTERNET', megas: 600, active: false } });
    await expect(oculto.srv.createTicket(
      { subscriberId: 'sub-1', type: 'Subir megas', planToId: 'plan-x' } as any, USUARIO,
    )).rejects.toThrow(/oculto/i);
  });

  it('la pedida por chat se abre sin plan: lo confirma quien la atienda', async () => {
    const { srv, planes, creados } = armar();

    const creada: any = await srv.createTicket(
      { subscriberId: 'sub-1', type: 'Subir megas', section: 'Quiere más megas, pregunta precio' } as any,
      USUARIO,
      { planOpcional: true },
    );

    expect(creada.code).toBe(500123);
    expect(creada.megas).toBeUndefined();
    expect(creados[0].planToId).toBeUndefined();
    expect(planes.changePlan).not.toHaveBeenCalled();
  });

  it('en cualquier otra orden el plan se ignora: nadie lo va a aplicar', async () => {
    const { srv, planes, creados } = armar();

    await srv.createTicket(
      { subscriberId: 'sub-1', type: 'Revision de Internet', planToId: 'plan-400' } as any, USUARIO,
    );

    expect(creados[0].planToId).toBeUndefined();
    expect(planes.changePlan).not.toHaveBeenCalled();
  });
});

/**
 * El mismo montaje, pero para CORREGIR una orden que ya existe.
 *
 * Corregir el plan hace falta por dos caminos distintos: las órdenes que nacen sin
 * él —las del legacy, donde el plan destino vive en su tabla `temporales`, y las
 * que abre el chatbot con el plan por confirmar— y el error de dedo de elegir el
 * plan de al lado en el desplegable.
 */
function armarEdicion(opts: { ticket?: any; plan?: any; suyo?: any; cambio?: any } = {}) {
  const ticket = {
    id: 't-1', code: 505251, subject: 'servicio', type: 'Subir megas', status: 'PENDIENTE',
    problem: null, section: null, created: new Date('2026-09-02T00:00:00Z'), graceDays: null,
    subscriberId: 'sub-1', moveToText: null, moveFromText: null,
    planToId: null, planToName: null, planToMegas: null, planFromName: null, planFromMegas: null,
    ...opts.ticket,
  };
  const plan = opts.plan ?? { id: 'plan-400', name: '400 Megas F-26', kind: 'INTERNET', megas: 400, active: true };
  const suyo = opts.suyo === null
    ? []
    : [opts.suyo ?? { planId: 'plan-200', planName: '200 Megas F-25', megas: 200, status: 'ACTIVO', plan: { name: '200 Megas F-25', megas: 200 } }];
  const updates: any[] = [];
  const hilo: any[] = [];
  const prisma = {
    ticket: {
      findUnique: jest.fn().mockResolvedValue(ticket),
      update: jest.fn((args: any) => { updates.push(args.data); return Promise.resolve({}); }),
    },
    plan: { findUnique: jest.fn().mockResolvedValue(plan) },
    subscriberService: { findMany: jest.fn().mockResolvedValue(suyo) },
    subscriber: { update: jest.fn().mockResolvedValue({}) },
    ticketThread: { create: jest.fn((args: any) => { hilo.push(args.data); return Promise.resolve({}); }) },
  };
  const planes = {
    changePlan: opts.cambio ?? jest.fn().mockResolvedValue({
      ok: true, plan: { id: plan.id, name: plan.name }, router: { ok: true, message: 'Perfil aplicado.' },
    }),
  };
  const srv = new SupportWriteService(
    prisma as any, {} as any, {} as any, { notifyPost: jest.fn() } as any, { emit: jest.fn() } as any,
    {} as any, {} as any, undefined, undefined, undefined, planes as any,
  );
  return { srv, prisma, planes, updates, hilo };
}

describe('corregir el plan de una orden de megas', () => {
  it('registra el plan en una orden que nació sin él, sin moverle nada al cliente', async () => {
    const { srv, planes, updates } = armarEdicion();

    const r: any = await srv.updateTicket('t-1', { planToId: 'plan-400' } as any, USUARIO);

    // De cuánto viene sale de lo que el cliente tiene HOY: la orden no lo ha movido.
    expect(updates[0]).toMatchObject({
      planToId: 'plan-400', planToName: '400 Megas F-26', planToMegas: 400,
      planFromName: '200 Megas F-25', planFromMegas: 200,
    });
    expect(planes.changePlan).not.toHaveBeenCalled();
    expect(r.cambios.join(' ')).toMatch(/se registró el plan destino/i);
    expect(r.cambios.join(' ')).toMatch(/cuando se cierre la orden/i);
  });

  it('la frase de las megas queda en la observación, que es lo que viaja al legacy', async () => {
    const { srv, updates } = armarEdicion({
      ticket: { section: 'usuaria solicita aumento, vive en el segundo piso' },
    });

    await srv.updateTicket('t-1', { planToId: 'plan-400' } as any, USUARIO);

    expect(updates[0].section).toBe(
      'usuaria solicita aumento, vive en el segundo piso\nSubir megas: de 200 Megas a 400 Megas (plan «400 Megas F-26»).',
    );
  });

  it('al corregir el plan mide contra el ORIGEN de la orden, no contra el que ella misma puso', async () => {
    // La orden ya movió al cliente de 5 a 100 Megas; se corrige a 50, que sigue
    // siendo subir respecto de los 5 de los que venía.
    const { srv, updates, hilo } = armarEdicion({
      ticket: {
        planToId: 'plan-100', planToName: '100 MEGAS', planToMegas: 100,
        planFromName: '5MegasV', planFromMegas: 5, planAppliedAt: new Date('2026-09-02T19:09:12Z'),
        section: 'Subir megas: de 5 Megas a 100 Megas (plan «100 MEGAS»).\nusuaria pidió 50',
      },
      plan: { id: 'plan-50', name: '50 Megas F-26', kind: 'INTERNET', megas: 50, active: true },
      suyo: { planId: 'plan-100', planName: '100 MEGAS', megas: 100, status: 'ACTIVO', plan: { name: '100 MEGAS', megas: 100 } },
    });

    const r: any = await srv.updateTicket('t-1', { planToId: 'plan-50' } as any, USUARIO);

    expect(updates[0]).toMatchObject({ planToId: 'plan-50', planToMegas: 50, planFromMegas: 5 });
    // Y la frase vieja no se queda al lado de la nueva: la orden diría dos velocidades.
    expect(updates[0].section).toBe('usuaria pidió 50\nSubir megas: de 5 Megas a 50 Megas (plan «50 Megas F-26»).');
    expect(r.cambios.join(' ')).toMatch(/«100 MEGAS» → «50 Megas F-26»/);
    expect(hilo[0].message).toMatch(/Orden corregida/);
  });

  it("no deja dejar una orden que dice 'Subir megas' bajando la velocidad", async () => {
    const { srv } = armarEdicion({
      ticket: { planToId: 'plan-100', planToName: '100 MEGAS', planToMegas: 100, planFromName: '5MegasV', planFromMegas: 5, planAppliedAt: new Date() },
      plan: { id: 'plan-3', name: '3 Megas', kind: 'INTERNET', megas: 3, active: true },
    });

    await expect(srv.updateTicket('t-1', { planToId: 'plan-3' } as any, USUARIO))
      .rejects.toThrow(/no sube nada/i);
  });

  it('el mismo plan no cambia nada: ni ficha, ni hilo, ni sello', async () => {
    const { srv, prisma, planes } = armarEdicion({
      ticket: { planToId: 'plan-400', planToName: '400 Megas F-26', planToMegas: 400 },
    });

    const r: any = await srv.updateTicket('t-1', { planToId: 'plan-400' } as any, USUARIO);

    expect(r.cambios).toEqual([]);
    expect(prisma.ticket.update).not.toHaveBeenCalled();
    expect(planes.changePlan).not.toHaveBeenCalled();
  });

  it('en una orden que no es de megas el plan se ignora: nadie lo va a aplicar', async () => {
    const { srv, prisma, planes } = armarEdicion({ ticket: { type: 'Revision de Internet' } });

    const r: any = await srv.updateTicket('t-1', { planToId: 'plan-400' } as any, USUARIO);

    expect(r.cambios).toEqual([]);
    expect(planes.changePlan).not.toHaveBeenCalled();
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  it('corregir una orden YA cerrada avisa de que el plan viejo se le quedó puesto', async () => {
    const { srv, updates, planes } = armarEdicion({
      ticket: {
        status: 'RESUELTO', planToId: 'plan-100', planToName: '100 MEGAS', planToMegas: 100,
        planFromName: '5MegasV', planFromMegas: 5, planAppliedAt: new Date('2026-09-02T19:09:12Z'),
      },
    });

    const r: any = await srv.updateTicket('t-1', { planToId: 'plan-400' } as any, USUARIO);

    // El sello se cae: la ficha tiene el plan de la corrección vieja, no el nuevo.
    expect(updates[0]).toMatchObject({ planToId: 'plan-400', planAppliedAt: null });
    expect(planes.changePlan).not.toHaveBeenCalled();
    expect(r.cambios.join(' ')).toMatch(/OJO/);
    expect(r.cambios.join(' ')).toMatch(/desde su ficha/i);
  });
});

/**
 * El CIERRE de una orden de megas: aquí es donde el cliente cambia de plan y donde
 * se le reprecia la factura del mes (decisión del usuario, 2026-09-02).
 */
function armarCierre(opts: { factura?: any; items?: any[]; plan?: any; cambio?: any } = {}) {
  const plan = opts.plan ?? { id: 'plan-100', name: '100 MEGAS', megas: 100, price: 65000, taxRate: 0 };
  const items = opts.items ?? [
    { id: 'it-1', productName: '5MegasV', description: '5MegasV', qty: 1, price: 36000, taxRate: 0, taxTotal: 0, subtotal: 36000 },
    { id: 'it-2', productName: 'Television26', description: 'Television26', qty: 1, price: 22269, taxRate: 19, taxTotal: 4231, subtotal: 22269 },
  ];
  const factura = opts.factura === null ? null : {
    id: 'inv-1', tid: 502274, status: 'DUE', subtotal: 58269, tax: 4231, total: 62500, paidAmount: 0,
    items, electronicInvoices: [], ...opts.factura,
  };
  const itemUpdates: any[] = [];
  const invUpdates: any[] = [];
  const prisma = {
    plan: {
      findUnique: jest.fn().mockResolvedValue(plan),
      // El catálogo de nombres de internet, para reconocer el renglón de la factura.
      findMany: jest.fn().mockResolvedValue([{ name: '5MegasV' }, { name: '100 MEGAS' }, { name: '400 Megas F-26' }]),
    },
    ticket: { update: jest.fn().mockResolvedValue({}) },
    subscriberService: { count: jest.fn().mockResolvedValue(1) },
    subInvoice: { findFirst: jest.fn().mockResolvedValue(factura) },
    $transaction: jest.fn(async (fn: any) => fn({
      subInvoiceItem: { update: jest.fn((a: any) => { itemUpdates.push(a); return Promise.resolve({}); }) },
      subInvoice: { update: jest.fn((a: any) => { invUpdates.push(a.data); return Promise.resolve({}); }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    })),
  };
  const planes = {
    changePlan: opts.cambio ?? jest.fn().mockResolvedValue({ ok: true, plan, router: { ok: true, message: 'Perfil aplicado.' } }),
  };
  const srv = new SupportWriteService(
    prisma as any, {} as any, {} as any, { notifyPost: jest.fn() } as any, { emit: jest.fn() } as any,
    {} as any, {} as any, undefined, undefined, undefined, planes as any,
  );
  const cerrar = () => (srv as any).applyCloseCascade(
    { ticketId: 't-1', subscriberId: 'sub-1', type: 'Subir megas', code: 505251, planToId: plan.id }, USUARIO,
  );
  return { srv, prisma, planes, cerrar, itemUpdates, invUpdates };
}

describe('cerrar una orden de megas', () => {
  it('le cambia el plan al cliente y reprecia la factura del mes al valor del plan', async () => {
    const { cerrar, prisma, planes, itemUpdates, invUpdates } = armarCierre();

    const cascade = await cerrar();

    // 1) El plan, en la ficha. `allowInactive`: la venta se acordó al abrir la orden.
    expect(planes.changePlan).toHaveBeenCalledWith('sub-1', 'plan-100', USUARIO, { allowInactive: true });
    expect(prisma.ticket.update).toHaveBeenCalledWith({ where: { id: 't-1' }, data: { planAppliedAt: expect.any(Date) } });

    // 2) El RENGLÓN del internet, al valor del plan nuevo (no un renglón más).
    expect(itemUpdates).toHaveLength(1);
    expect(itemUpdates[0].where).toEqual({ id: 'it-1' });
    expect(itemUpdates[0].data).toMatchObject({ productName: '100 MEGAS', price: 65000, taxRate: 0, taxTotal: 0, subtotal: 65000 });

    // 3) El encabezado se mueve por la DIFERENCIA (65.000 - 36.000 = 29.000).
    expect(invUpdates[0]).toMatchObject({
      subtotal: 87269, tax: 4231, total: 91500, status: 'DUE',
      // Lo que el legacy lee para saber en qué plan está el cliente.
      serviceCombo: '100 MEGAS',
      editedAt: expect.any(Date),
    });
    expect(cascade.note).toMatch(/100 MEGAS/);
    expect(cascade.note).toMatch(/91.500/);
  });

  it('no toca una factura ya timbrada ante la DIAN, pero sí le cambia el plan', async () => {
    const { cerrar, planes, itemUpdates } = armarCierre({
      factura: { electronicInvoices: [{ type: 'FACTURADA', dianNumber: 'VES-123' }] },
    });

    const cascade = await cerrar();

    expect(planes.changePlan).toHaveBeenCalled();
    expect(itemUpdates).toHaveLength(0);
    expect(cascade.note).toMatch(/nota crédito/i);
  });

  it('no deja la factura por debajo de lo ya pagado al bajar megas', async () => {
    const { cerrar, itemUpdates } = armarCierre({
      plan: { id: 'plan-3', name: '3 Megas', megas: 3, price: 20000, taxRate: 0 },
      factura: { status: 'PAID', paidAmount: 62500 },
    });

    const cascade = await cerrar();

    expect(itemUpdates).toHaveLength(0);
    expect(cascade.note).toMatch(/nota crédito/i);
  });

  it('sin factura de este mes el plan igual se cambia: se cobra en la próxima corrida', async () => {
    const { cerrar, planes } = armarCierre({ factura: null });

    const cascade = await cerrar();

    expect(planes.changePlan).toHaveBeenCalled();
    expect(cascade.note).toMatch(/próxima corrida/i);
  });

  it('si el cambio de plan falla, la orden se cierra igual y dice qué falta', async () => {
    const { cerrar, prisma } = armarCierre({
      cambio: jest.fn().mockRejectedValue(new Error('El plan está inactivo; actívalo antes de asignarlo.')),
    });

    const cascade = await cerrar();

    expect(prisma.ticket.update).not.toHaveBeenCalled();
    expect(cascade.note).toMatch(/desde su ficha/i);
  });

  it('una orden de megas sin plan sigue pidiendo que se aplique a mano', async () => {
    const { srv, planes } = armarCierre();

    const cascade = await (srv as any).applyCloseCascade(
      { ticketId: 't-1', subscriberId: 'sub-1', type: 'Subir megas', code: 505251, planToId: null }, USUARIO,
    );

    expect(planes.changePlan).not.toHaveBeenCalled();
    expect(cascade.note).toMatch(/no porta el plan destino/i);
  });
});
