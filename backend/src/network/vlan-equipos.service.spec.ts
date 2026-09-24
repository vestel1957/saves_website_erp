import { VlanEquiposService } from './vlan-equipos.service';
import type { LecturaMikrotikVlans, LecturaOltVlans } from './vlan-salud';

/**
 * "Configurar en equipos" (2026-09-23) con OLT y Mikrotik FALSOS: el camino de
 * escritura no se puede probar contra los equipos de producción, así que aquí
 * se comprueba el orden (OLT primero, Mikrotik después), que no se sigue si la
 * OLT rechaza, los permisos y la relectura. El caso es el de la 590 de
 * Villanueva antes del arreglo: creada, sin uplink, con el Mikrotik listo.
 */

const lectura = (con590EnUplink: boolean): LecturaOltVlans => ({
  vlans: [
    { vlan: 1, tipo: 'smart', atributo: 'common', estandar: 8, servicePorts: 0 },
    { vlan: 580, tipo: 'smart', atributo: 'common', estandar: 1, servicePorts: 5 },
    { vlan: 590, tipo: 'smart', atributo: 'common', estandar: con590EnUplink ? 1 : 0, servicePorts: 1 },
    { vlan: 600, tipo: 'smart', atributo: 'common', estandar: 1, servicePorts: 17 },
  ],
  puertosDeRed: [{ fsp: '0/8/0', estado: 'up' }, { fsp: '0/8/1', estado: 'down' }],
  vlansPorPuertoDeRed: { '0/8/0': con590EnUplink ? [1, 580, 590, 600] : [1, 580, 600], '0/8/1': [1] },
  puertos: [
    { frame: 0, slot: 2, port: 12, servicios: 5, vlans: [{ vlan: 580, servicios: 5 }] },
    { frame: 0, slot: 2, port: 13, servicios: 1, vlans: [{ vlan: 590, servicios: 1 }] },
    { frame: 0, slot: 2, port: 14, servicios: 17, vlans: [{ vlan: 600, servicios: 17 }] },
  ],
});

const router = (con590: boolean): LecturaMikrotikVlans => ({
  id: 'mk1', name: 'Ip_Villanueva_GPON',
  vlans: [580, 600, ...(con590 ? [590] : [])].map((n) => ({ name: `vlan${n}`, vlanId: n, interfaz: 'sfp-sfpplus2_OLT', disabled: false, running: true })),
  pppoe: [580, 600, ...(con590 ? [590] : [])].map((n) => ({
    interfaz: `vlan${n}`, serviceName: `pppoe${n}`, disabled: false,
    params: { 'default-profile': 'default', authentication: 'pap,chap,mschap1,mschap2', 'one-session-per-host': 'false' },
  })),
});

function montar(o: { mkCon590?: boolean; oltRechaza?: boolean } = {}) {
  let oltArreglada = false;
  let mkArreglado = !!o.mkCon590;
  const llamadas: string[] = [];
  const prisma: any = {
    vlan: {
      findUnique: async () => ({ id: 'v590', vlan: 590, branchId: 'vill', oltId: 'olt-v' }),
      findMany: async () => [{ id: 'v590', vlan: 590, detail: 'VILLA CAMPESTRE 3', tray: 2, oltPort: 13, oltId: 'olt-v' }],
    },
    olt: { findMany: async () => [{ id: 'olt-v', name: 'VILLANUEVA' }] },
  };
  const olt: any = {
    lecturaVlansDeOlt: async () => ({ ok: true, error: '', leidoEn: 'x', data: lectura(oltArreglada) }),
    configurarVlanEnOlt: async (_id: string, p: any) => {
      llamadas.push(`OLT ${JSON.stringify(p)}`);
      if (o.oltRechaza) return { ok: false, dryRun: false, commands: [], error: 'La OLT rechazó la configuración de la VLAN: X' };
      oltArreglada = true;
      return { ok: true, dryRun: false, commands: ['port vlan 590 0/8 0'], respuestas: [{ cmd: 'port vlan 590 0/8 0', out: '' }] };
    },
  };
  const mikrotik: any = {
    vlansDeRoutersDeSede: async () => ({ routers: [router(mkArreglado)], errores: [] }),
    configurarVlanEnRouter: async (_id: string, _v: number, pasos: any[]) => {
      llamadas.push(`MK ${pasos.map((p) => p.cmd).join(',')}`);
      mkArreglado = true;
      return { ok: true, dryRun: false, steps: pasos.map((p) => p.cmd) };
    },
  };
  return { svc: new VlanEquiposService(prisma, olt, mikrotik), llamadas };
}

const admin = { id: 'u', email: 'a@b', name: 'Admin', roles: [], permissions: ['system.admin'] } as any;
const tecnico = { id: 't', email: 't@b', name: 'Técnico', roles: [], permissions: ['area.tecnicos'] } as any;

describe('VlanEquiposService.configurarEquipos', () => {
  it('dry-run (por defecto): la 590 sin uplink → solo `port vlan 590 0/8 0`, nada ejecutado', async () => {
    const { svc, llamadas } = montar({ mkCon590: true });
    const r: any = await svc.configurarEquipos('v590', {}, admin);
    expect(r).toMatchObject({ ok: true, dryRun: true, vlan: 590, nadaQueHacer: false });
    expect(r.olt.comandos).toEqual(['port vlan 590 0/8 0']);
    expect(r.mikrotik.comandos).toEqual([]);
    expect(llamadas).toEqual([]);
  });

  it('real: OLT primero, Mikrotik después, y relee para confirmar que quedó OK', async () => {
    const { svc, llamadas } = montar({ mkCon590: false });
    const r: any = await svc.configurarEquipos('v590', { dryRun: false }, admin);
    expect(llamadas[0]).toBe('OLT {"vlan":590,"crear":false,"uplink":"0/8/0"}');
    expect(llamadas[1]).toBe('MK /interface/vlan/add,/interface/pppoe-server/server/add');
    expect(r.ok).toBe(true);
    expect(r.despues).toMatchObject({ vlan: 590, estado: 'OK' });
  });

  it('si la OLT rechaza, el Mikrotik NO se toca', async () => {
    const { svc, llamadas } = montar({ mkCon590: false, oltRechaza: true });
    const r: any = await svc.configurarEquipos('v590', { dryRun: false }, admin);
    expect(llamadas).toHaveLength(1);
    expect(r.ok).toBe(false);
    expect(r.resultado.mikrotikOmitido).toMatch(/no se tocó el Mikrotik/i);
  });

  it('sin permiso de OLT/routers se puede VER el plan pero no aplicarlo', async () => {
    const { svc, llamadas } = montar({ mkCon590: false });
    await expect(svc.configurarEquipos('v590', {}, tecnico)).resolves.toMatchObject({ dryRun: true });
    await expect(svc.configurarEquipos('v590', { dryRun: false }, tecnico)).rejects.toThrow(/network\.olt\.manage/);
    expect(llamadas).toEqual([]);
  });

  it('uplink pedido que no es de la OLT: 400, no se inventa', async () => {
    const { svc } = montar({ mkCon590: true });
    await expect(svc.configurarEquipos('v590', { uplink: '0/9/9' }, admin)).rejects.toThrow(/no es uno de los de la OLT/);
  });
});
