import { MikrotikService } from './mikrotik.service';
import { OltHuawei } from './olt/olt-huawei.driver';

/**
 * Las dos piezas que ESCRIBEN en los equipos al configurar una VLAN, probadas
 * sin equipos (2026-09-23): nunca se ejecutaron contra la OLT ni los Mikrotik de
 * producción, así que su contrato queda fijado aquí.
 */

describe('MikrotikService.configurarVlanEnRouter', () => {
  const router = { id: 'mk1', name: 'Ip_Villanueva_GPON', ip: '10.0.0.1', port: '5050', tech: 'GPON', username: 'u', password: 'p' };
  const montar = (live: boolean) => {
    const logs: any[] = [];
    const prisma: any = {
      mikrotik: { findUnique: async () => router },
      appSetting: { findUnique: async () => ({ value: live ? 'true' : 'false' }) },
      mikrotikActionLog: { create: async (x: any) => { logs.push(x.data); return x.data; } },
    };
    return { svc: new MikrotikService(prisma, undefined as any, undefined as any), logs };
  };

  it('rechaza cualquier paso que no sea /interface/vlan/add o /interface/pppoe-server/server/add', async () => {
    const { svc, logs } = montar(true);
    await expect(svc.configurarVlanEnRouter('mk1', 590, [{ cmd: '/interface/vlan/remove', params: { numbers: '*1' } } as any]))
      .rejects.toThrow(/no permitido/);
    await expect(svc.configurarVlanEnRouter('mk1', 590, [{ cmd: '/interface/pppoe-server/server/set', params: {} } as any]))
      .rejects.toThrow(/no permitido/);
    expect(logs).toEqual([]);
  });

  it('en dry-run no abre conexión: devuelve los pasos y deja rastro con el usuario', async () => {
    const { svc, logs } = montar(false);
    const r = await svc.configurarVlanEnRouter('mk1', 590, [
      { cmd: '/interface/vlan/add', params: { name: 'vlan590', 'vlan-id': '590', interface: 'sfp-sfpplus2_OLT' } },
    ], { id: 'u1', name: 'Ana', email: '', roles: [], permissions: [] });
    expect(r).toEqual({ ok: true, dryRun: true, steps: ['DRY-RUN /interface/vlan add name=vlan590 vlan-id=590 interface=sfp-sfpplus2_OLT'] });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'VLAN', dryRun: true, ok: true, userName: 'Ana', mikrotikName: 'Ip_Villanueva_GPON' });
  });

  it('sin pasos no hace nada', async () => {
    const { svc, logs } = montar(true);
    expect(await svc.configurarVlanEnRouter('mk1', 590, [])).toEqual({ ok: true, dryRun: false, steps: [] });
    expect(logs).toEqual([]);
  });
});

describe('OltHuawei.configurarVlan', () => {
  const driver = (respuestas: Record<string, string>) => {
    const d = new OltHuawei('10.0.0.1', 22, 'u', 'p');
    const enviados: string[] = [];
    (d as any).sendCommand = async (cmd: string) => { enviados.push(cmd); return respuestas[cmd] ?? ''; };
    return { d, enviados };
  };

  it('crear + uplink: los dos comandos, en ese orden, y nada de `save`', async () => {
    const { d, enviados } = driver({});
    const r = await d.configurarVlan({ vlan: 610, crear: true, uplink: '0/8/0' });
    expect(r).toMatchObject({ ok: true });
    expect(enviados).toEqual(['vlan 610 smart', 'port vlan 610 0/8 0']);
  });

  it('si la OLT rechaza el primero, no manda el segundo', async () => {
    const { d, enviados } = driver({ 'vlan 610 smart': '  Failure: The VLAN already exists' });
    const r: any = await d.configurarVlan({ vlan: 610, crear: true, uplink: '0/8/0' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/La OLT rechazó la configuración de la VLAN: The VLAN already exists/);
    expect(enviados).toEqual(['vlan 610 smart']);
  });

  it('detalleVlan solo manda `display vlan N`', async () => {
    const { d, enviados } = driver({ 'display vlan 590': '  VLAN ID: 590\n  VLAN type: smart\n  Standard port number: 0\n  Service virtual port number: 1' });
    expect(await d.detalleVlan(590)).toMatchObject({ vlan: 590, existe: true, uplinks: [], servicePorts: 1 });
    expect(enviados).toEqual(['display vlan 590']);
  });
});
