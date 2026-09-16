import { OnuProvisionService } from './onu-provision.service';

/**
 * EL TRASLADO NO ESTRENA EQUIPO: se desautentica la ONU y se vuelve a autenticar.
 *
 * La regla la puso el usuario (2026-09-04): «las órdenes de traslado no tienen que
 * asignar un equipo nuevo de la bodega, simplemente se desautentica y se vuelve a
 * autenticar donde tiene que ser». El cliente se muda con SU ONU debajo del brazo,
 * así que lo único que cambia es el puerto —o la OLT, si se muda de sede—.
 *
 * Lo que estas pruebas defienden es el orden de las dos escrituras contra la OLT:
 * primero se BORRA el alta vieja y después se hace la nueva. Al revés, `ont add`
 * choca con "SN already exists"; y si en vez de borrar se adopta lo que ya está
 * —que es lo correcto en una instalación normal— el service-port se queda colgando
 * del PON de la casa anterior y el abonado no navega, con la orden ya cerrada.
 */
describe('traslado · desautenticar y volver a autenticar', () => {
  const SN = '48575443A1B2C3D4';

  const armar = (opts: { tipo?: string; fantasmaEnOtraOlt?: boolean } = {}) => {
    const oltOnuDelete = jest.fn().mockResolvedValue({});
    const notas: string[] = [];
    const prisma: any = {
      ticket: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1', code: 900, type: opts.tipo ?? 'Traslado', subscriberId: 'sub-1',
          planToId: null, planToName: null, planToMegas: null, planAppliedAt: null,
        }),
      },
      subscriber: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sub-1', abonado: 57439, branchId: 'br-1', fullName: 'ANA GOMEZ',
          firstName: 'ANA', secondName: null, lastName1: 'GOMEZ', lastName2: null, companyName: null,
          branch: { name: 'Yopal', legacyId: 2 },
        }),
      },
      olt: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'olt-1', name: 'YOPAL', ip: '10.0.0.1',
          defaultLineProfile: null, defaultSrvProfile: null, defaultVlan: null, defaultGemport: null, defaultUserVlan: null,
        }),
      },
      subscriberService: {
        findMany: jest.fn().mockResolvedValue([
          { planId: 'plan-100', planName: '100 Megas F-26', megas: 100, status: 'ACTIVO', plan: { megas: 100 } },
        ]),
      },
      oltOnu: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue(
          opts.fantasmaEnOtraOlt ? [{ id: 'onu-vieja', oltId: 'olt-2', olt: { name: 'VILLANUEVA' } }] : []),
        update: jest.fn().mockResolvedValue({}),
        delete: oltOnuDelete,
      },
      // El cruce SN↔inventario: la ONU del cliente no está rotulada en el almacén.
      $queryRaw: jest.fn().mockResolvedValue([]),
      ticketThread: { create: jest.fn(async ({ data }: any) => { notas.push(data.message); return data; }) },
    };
    const orden: string[] = [];
    const olt: any = {
      mode: jest.fn().mockResolvedValue({ live: true }),
      autofind: jest.fn().mockResolvedValue({
        ok: true,
        onus: [{ sn: SN, fsp: '0/2/7', vendor: 'HWTC', autofind_time: new Date().toISOString() }],
      }),
      // La OLT dice dónde está el alta anterior: en el puerto de la casa VIEJA.
      findBySn: jest.fn(async (oltId: string) => ({ ok: true, onu: { fsp: oltId === 'olt-2' ? '0/0/1' : '0/1/3', ont_id: 12 } })),
      remove: jest.fn(async (oltId: string, p: any) => {
        orden.push(`remove ${oltId} ${p.frame}/${p.slot}/${p.port}:${p.ont_id}`);
        return { ok: true, dryRun: false, message: 'ONT borrada' };
      }),
      sugerencia: jest.fn().mockResolvedValue({ sugerencia: { vlan: 100, lineprofile: 'LP', srvprofile: 'SP', gemport: 1, user_vlan: 100 } }),
      provision: jest.fn(async (oltId: string, p: any) => {
        orden.push(`provision ${oltId} ${p.frame}/${p.slot}/${p.port}`);
        return { ok: true, dryRun: false, message: 'ONT agregada', ontId: 4, verificacion: { run_state: 'online', config_state: 'normal', servicePorts: [1] } };
      }),
      adoptar: jest.fn(),
    };
    const planProfiles: any = {
      resolve: jest.fn().mockResolvedValue({ vlan: 100, lineprofile: 'LP', srvprofile: 'SP', gemport: 1, userVlan: 100, trafficIn: 11, trafficOut: 9 }),
      resolveConEtiqueta: jest.fn().mockResolvedValue({ trafficIn: 11, trafficOut: 9 }),
    };
    const reserva: any = { conciliarTrasAutenticar: jest.fn().mockResolvedValue({ liberados: [], devuelto: null }) };
    return { svc: new OnuProvisionService(prisma, olt, planProfiles, reserva), olt, orden, notas, oltOnuDelete, prisma };
  };

  it('borra el alta vieja ANTES de dar de alta en el puerto nuevo', async () => {
    const { svc, olt, orden } = armar();
    const r: any = await svc.autenticar('t1', { sn: SN });
    expect(r.ok).toBe(true);
    // El orden es lo que importa: borrar y luego autenticar.
    expect(orden).toEqual(['remove olt-1 0/1/3:12', 'provision olt-1 0/2/7']);
    expect(r.liberacion.borrado).toBe(true);
    expect(r.liberacion.anterior).toBe('0/1/3:12');
    expect(r.fsp).toBe('0/2/7');
    // Y NADA de adoptar el alta anterior: es la de la casa de antes.
    expect(olt.adoptar).not.toHaveBeenCalled();
  });

  it('el traslado entre sedes también deja limpia la OLT vieja', async () => {
    const { svc, orden, oltOnuDelete } = armar({ fantasmaEnOtraOlt: true });
    const r: any = await svc.autenticar('t1', { sn: SN });
    expect(orden).toContain('remove olt-2 0/0/1:12');
    expect(r.liberacion.tambienEn).toEqual(['VILLANUEVA 0/0/1:12']);
    // El registro local de la ONU en el nodo viejo se va con ella.
    expect(oltOnuDelete).toHaveBeenCalledWith({ where: { id: 'onu-vieja' } });
  });

  it('lo deja anotado en la orden, y dice que no se descuenta equipo de la bodega', async () => {
    const { svc, notas } = armar();
    await svc.autenticar('t1', { sn: SN });
    const nota = notas.find((n) => n.startsWith('TRASLADO ·'));
    expect(nota).toBeTruthy();
    expect(nota).toMatch(/desautenticada/i);
    expect(nota).toMatch(/no se descuenta ningún equipo de la bodega/i);
  });

  it('el traslado INTERNO no toca el alta: el equipo no cambia de puerto', async () => {
    // 'Traslado interno De Equipos Red en cliente final' es mover el aparato de
    // sitio dentro de la misma casa. Borrarle el alta sería dejarlo sin servicio.
    const { svc, olt, orden } = armar({ tipo: 'Traslado interno De Equipos Red en cliente final' });
    await svc.autenticar('t1', { sn: SN });
    expect(olt.remove).not.toHaveBeenCalled();
    expect(orden).toEqual(['provision olt-1 0/2/7']);
  });
});
