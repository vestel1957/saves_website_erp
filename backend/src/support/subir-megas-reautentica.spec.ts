import { OnuProvisionService } from './onu-provision.service';

/**
 * SUBIR MEGAS: se desautentica la ONU y se vuelve a autenticar con las megas de
 * la orden (pedido por el usuario, 2026-09-14).
 *
 * Lo que defienden estas pruebas: el alta nueva es la MISMA que había (puerto,
 * ONT-ID, perfiles, VLAN, GEM, comentario) salvo la velocidad; el orden es borrar
 * y luego autenticar; y si el alta nueva falla, se deja la ONU como estaba.
 */
describe('subir megas · desautenticar y volver a autenticar con el plan de la orden', () => {
  const SN = '48575443A1B2C3D4';

  const armar = (opts: { tipo?: string; servicePorts?: any[]; altaFalla?: boolean } = {}) => {
    const notas: string[] = [];
    const orden: string[] = [];
    const prisma: any = {
      ticket: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1', code: 901, type: opts.tipo ?? 'Subir megas', subscriberId: 'sub-1',
          planToId: 'plan-300', planToName: '300 Megas', planToMegas: 300, planAppliedAt: null,
        }),
      },
      subscriber: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sub-1', abonado: 57439, branchId: 'br-1', fullName: 'ANA GOMEZ', installTech: 'GPON',
          branch: { name: 'Yopal', legacyId: 2 },
        }),
      },
      olt: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'olt-1', name: 'YOPAL', ip: '10.0.0.1',
          defaultLineProfile: null, defaultSrvProfile: null, defaultVlan: null, defaultGemport: null, defaultUserVlan: null,
        }),
      },
      plan: { findUnique: jest.fn().mockResolvedValue({ id: 'plan-300', name: '300 Megas', megas: 300 }) },
      oltOnu: {
        findFirst: jest.fn().mockResolvedValue({ sn: SN, oltId: 'olt-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      ticketThread: { create: jest.fn(async ({ data }: any) => { notas.push(data.message); return data; }) },
    };
    let altas = 0;
    const olt: any = {
      estadoPorSn: jest.fn().mockResolvedValue({
        ok: true, error: '',
        estado: {
          fsp: '0/1/4', frame: 0, slot: 1, port: 4, ont_id: 28, description: '57439ANAGOMEZ',
          lineprofile: '250', srvprofile: '7',
          servicePorts: opts.servicePorts ?? [{ index: '1200', vlan: '250', gemport: '250', rx: '11', tx: '9' }],
        },
      }),
      sugerencia: jest.fn().mockResolvedValue({ sugerencia: { vlan: 100, lineprofile: 'LP', srvprofile: 'SP', gemport: 1, user_vlan: 250 } }),
      remove: jest.fn(async (_o: string, p: any) => {
        orden.push(`remove ${p.frame}/${p.slot}/${p.port}:${p.ont_id}`);
        return { ok: true, dryRun: false };
      }),
      provision: jest.fn(async (_o: string, p: any) => {
        altas++;
        orden.push(`provision ${p.frame}/${p.slot}/${p.port}:${p.ont_id} tt ${p.traffic_in}/${p.traffic_out}`);
        if (opts.altaFalla && altas === 1) return { ok: false, dryRun: false, error: 'Failure: boom' };
        return { ok: true, dryRun: false, ontId: '28', verificacion: { run_state: 'online', config_state: 'normal', servicePorts: [1] } };
      }),
      setSpeed: jest.fn(),
    };
    const planProfiles: any = {
      resolve: jest.fn().mockResolvedValue({ vlan: 100, lineprofile: 'LP', srvprofile: 'SP', gemport: 1, userVlan: 100, trafficIn: 70, trafficOut: 73 }),
    };
    return { svc: new OnuProvisionService(prisma, olt, planProfiles, {} as any, {} as any), olt, orden, notas };
  };

  it('borra la ONU y la vuelve a dar de alta igual, con la velocidad del plan de la orden', async () => {
    const { svc, olt, orden } = armar();
    const r: any = await svc.aplicarVelocidad('t1');
    expect(r.ok).toBe(true);
    expect(r.reautenticada).toBe(true);
    expect(orden).toEqual(['remove 0/1/4:28', 'provision 0/1/4:28 tt 70/73']);
    // Lo que la ONT tenía manda sobre el mapeo del plan: solo cambia la velocidad.
    expect(olt.provision.mock.calls[0][1]).toMatchObject({
      lineprofile: 250, srvprofile: 7, vlan: 250, gemport: 250, desc: '57439ANAGOMEZ',
    });
    expect(olt.setSpeed).not.toHaveBeenCalled();
  });

  it('lo anota en la orden', async () => {
    const { svc, notas } = armar();
    await svc.aplicarVelocidad('t1');
    expect(notas.find((n) => n.startsWith('SUBIR MEGAS ·'))).toMatch(/bajada 11 → 70/);
  });

  it('si el alta nueva falla, deja la ONU como estaba', async () => {
    const { svc, orden } = armar({ altaFalla: true });
    const r: any = await svc.aplicarVelocidad('t1');
    expect(r.ok).toBe(false);
    expect(r.restaurada).toBe(true);
    expect(orden[2]).toBe('provision 0/1/4:28 tt 11/9');
  });

  it('no desautentica una ONU con TV/voz (varios service-ports)', async () => {
    const { svc, olt } = armar({ servicePorts: [{ vlan: '250', gemport: '1', rx: '11', tx: '9' }, { vlan: '300', gemport: '2', rx: '6', tx: '6' }] });
    await expect(svc.aplicarVelocidad('t1')).rejects.toThrow(/service-ports/);
    expect(olt.remove).not.toHaveBeenCalled();
  });

  it('bajar megas sigue sin tocar el alta', async () => {
    const { svc, olt } = armar({ tipo: 'Bajar megas' });
    olt.setSpeed.mockResolvedValue({ ok: true, dryRun: false });
    await svc.aplicarVelocidad('t1');
    expect(olt.remove).not.toHaveBeenCalled();
    expect(olt.setSpeed).toHaveBeenCalled();
  });
});
