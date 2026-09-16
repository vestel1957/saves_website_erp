import { OnuProvisionService } from './onu-provision.service';

/**
 * EL ALTA EN LA MIKROTIK, ANTES DE AUTENTICAR EL EQUIPO.
 *
 * Autenticar la ONU deja al cliente con ENLACE, no con internet: quien le da
 * internet es su `/ppp/secret`. El abonado que estrena servicio —una instalación,
 * o el que solo tenía televisión y pide 'AgregarInternet'— puede no tener todavía
 * usuario PPPoE (o traer el relleno del legacy: '0', '-', 'null'), y entonces la
 * orden se cerraba en verde con la ONU online y el cliente sin navegar.
 *
 * Lo que estas pruebas defienden:
 *   · en esas órdenes los datos de red se crean SOLOS y ANTES de tocar la OLT;
 *   · un secret que ya funciona no se reescribe nunca;
 *   · en las demás órdenes no se toca la Mikrotik;
 *   · y que la Mikrotik falle no puede impedir autenticar la ONU.
 */
describe('OnuProvisionService · el alta en la Mikrotik al autenticar', () => {
  const SUB = 'sub-1';
  const SN = '48575443A1B2C3D4';

  const armar = (opts: {
    /** Tipo de la orden. Por defecto, una instalación. */
    tipo?: string;
    /** Lo que trae la ficha en `name_s`: null y '0' significan lo mismo (nada). */
    pppUsername?: string | null;
    /** ¿El router dice que su secret ya está puesto? */
    secretExiste?: boolean;
    /** El alta en el router responde que no (router caído, perfil ambiguo…). */
    provisionFalla?: boolean;
    /** Plan DESTINO de la orden: 'AgregarInternet' solo vale con él. */
    planToId?: string;
  } = {}) => {
    const prisma: any = {
      ticket: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1', code: 900, type: opts.tipo ?? 'Instalacion', subscriberId: SUB,
          planToId: opts.planToId ?? null, planToName: opts.planToId ? '100 Megas F-26' : null,
          planToMegas: opts.planToId ? 100 : null, planAppliedAt: null,
        }),
      },
      subscriber: {
        findUnique: jest.fn().mockResolvedValue({
          id: SUB, abonado: 57439, branchId: 'br-1', fullName: 'ANA GOMEZ',
          firstName: 'ANA', secondName: null, lastName1: 'GOMEZ', lastName2: null, companyName: null,
          installTech: 'GPON', pppUsername: opts.pppUsername ?? null, legacyId: 4021, ipRemote: null,
          status: 'INSTALAR', branch: { name: 'Yopal', legacyId: 2 },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      olt: { findFirst: jest.fn().mockResolvedValue({ id: 'olt-1', name: 'YOPAL', ip: '10.0.0.1', defaultVlan: 100 }) },
      subscriberService: {
        findMany: jest.fn().mockResolvedValue([
          { planId: 'plan-100', planName: '100 Megas F-26', megas: 100, status: 'ACTIVO', plan: { megas: 100 } },
        ]),
      },
      plan: { findUnique: jest.fn().mockResolvedValue({ id: 'plan-100', name: '100 Megas F-26', megas: 100, pppProfile: '100Megas' }) },
      oltOnu: { findFirst: jest.fn().mockResolvedValue(null) },
      equipment: { findMany: jest.fn().mockResolvedValue([]) },
      ticketThread: { create: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const olt: any = {
      mode: jest.fn().mockResolvedValue({ live: true }),
      autofind: jest.fn().mockResolvedValue({ ok: true, onus: [{ sn: SN, fsp: '0/1/3' }] }),
      sugerencia: jest.fn().mockResolvedValue({ sugerencia: { lineprofile: 'LP', srvprofile: 'SP', vlan: 100 } }),
      // dryRun para que la prueba se quede en lo que interesa: lo que se hizo
      // ANTES del alta, no el inventario que se cuadra después.
      provision: jest.fn().mockResolvedValue({ ok: true, dryRun: true, ontId: 3 }),
    };
    const planProfiles: any = {
      resolve: jest.fn().mockResolvedValue({ trafficIn: 11, trafficOut: 9, vlan: 100 }),
      resolveConEtiqueta: jest.fn().mockResolvedValue({ trafficIn: 11, trafficOut: 9 }),
    };
    const mikrotik: any = {
      isLive: true,
      resolveRouter: jest.fn().mockResolvedValue({ id: 'mk-1', name: 'YOPAL-GPON', ip: '10.0.0.2', port: 8728, tech: 'GPON' }),
      liveStatus: jest.fn().mockResolvedValue({
        ok: true, dryRun: false, mikrotik: { name: 'YOPAL-GPON' },
        live: { secretExists: !!opts.secretExiste },
      }),
      provision: jest.fn().mockResolvedValue(
        opts.provisionFalla
          ? { ok: false, dryRun: false, steps: [], message: 'Fallo el alta', error: 'router sin responder' }
          : { ok: true, dryRun: false, steps: ['secret creado'], message: 'Alta aplicada: ANAGOMEZ provisionado en YOPAL-GPON.', mikrotik: { name: 'YOPAL-GPON' } },
      ),
      applyProfile: jest.fn(),
    };
    const reserva: any = { conciliarTrasAutenticar: jest.fn().mockResolvedValue(null) };
    const subs: any = {
      asegurarCredencialesPpp: jest.fn().mockResolvedValue({ ok: true, creado: true, pppUsername: 'ANAGOMEZ' }),
    };
    const svc = new OnuProvisionService(prisma, olt, planProfiles, mikrotik, reserva, subs);
    return { svc, prisma, olt, mikrotik, subs };
  };

  it('al cliente sin usuario PPPoE se lo crea y le da de alta el secret ANTES de tocar la OLT', async () => {
    const { svc, mikrotik, subs, olt } = armar({ pppUsername: null });
    const r: any = await svc.autenticar('t1', { sn: SN });

    expect(subs.asegurarCredencialesPpp).toHaveBeenCalledWith(SUB, undefined);
    expect(mikrotik.provision).toHaveBeenCalledWith(SUB, undefined);
    // El orden importa: primero sus datos de red, después el alta en la planta.
    expect(mikrotik.provision.mock.invocationCallOrder[0])
      .toBeLessThan(olt.provision.mock.invocationCallOrder[0]);
    expect(r.altaMikrotik.ok).toBe(true);
    expect(r.altaMikrotik.usuarioCreado).toBe(true);
    expect(r.altaMikrotik.pppUsername).toBe('ANAGOMEZ');
  });

  it("el relleno del legacy ('0') no cuenta como usuario: también se le crea", async () => {
    const { svc, subs, mikrotik } = armar({ pppUsername: '0' });
    await svc.autenticar('t1', { sn: SN });
    expect(subs.asegurarCredencialesPpp).toHaveBeenCalled();
    expect(mikrotik.provision).toHaveBeenCalled();
  });

  it('el secret nace con el perfil del PLAN, no con "default"', async () => {
    const { svc, prisma } = armar({ pppUsername: null });
    const r: any = await svc.autenticar('t1', { sn: SN });
    // `provision` escribe el perfil que encuentra en la ficha: se le deja puesto
    // antes, y con `editedAt` para que el sync no lo devuelva al valor viejo.
    expect(prisma.subscriber.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ pppProfile: '100Megas' }) }),
    );
    expect(prisma.subscriber.update.mock.calls[0][0].data.editedAt).toBeInstanceOf(Date);
    expect(r.altaMikrotik.perfil).toBe('100Megas');
  });

  it('un secret que ya funciona no se reescribe', async () => {
    const { svc, mikrotik, subs } = armar({ pppUsername: 'ANAGOMEZ', secretExiste: true });
    const r: any = await svc.autenticar('t1', { sn: SN });
    expect(subs.asegurarCredencialesPpp).not.toHaveBeenCalled();
    expect(mikrotik.provision).not.toHaveBeenCalled();
    expect(r.altaMikrotik.ok).toBe(true);
    expect(r.altaMikrotik.creado).toBe(false);
  });

  it('en una orden que no estrena internet no se toca la Mikrotik', async () => {
    const { svc, mikrotik, subs } = armar({ tipo: 'Cambio de equipo', pppUsername: null });
    const r: any = await svc.autenticar('t1', { sn: SN });
    expect(subs.asegurarCredencialesPpp).not.toHaveBeenCalled();
    expect(mikrotik.provision).not.toHaveBeenCalled();
    expect(r.altaMikrotik).toBeNull();
  });

  it('AgregarInternet también estrena internet: se le crea el alta', async () => {
    const { svc, mikrotik } = armar({ tipo: 'AgregarInternet', pppUsername: null, planToId: 'plan-100' });
    await svc.autenticar('t1', { sn: SN });
    expect(mikrotik.provision).toHaveBeenCalled();
  });

  it('que la Mikrotik falle NO impide autenticar la ONU: se autentica y se dice qué faltó', async () => {
    const { svc, olt, prisma } = armar({ pppUsername: null, provisionFalla: true });
    const r: any = await svc.autenticar('t1', { sn: SN });
    expect(olt.provision).toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.altaMikrotik.ok).toBe(false);
    expect(r.altaMikrotik.mensaje).toContain('router sin responder');
    // Y queda escrito en la orden, que es donde alguien lo va a buscar.
    expect(prisma.ticketThread.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ticketCode: 900 }) }),
    );
  });
});
