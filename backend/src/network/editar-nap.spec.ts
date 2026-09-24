import 'reflect-metadata';
import { NetworkWriteService } from './network-write.service';

/**
 * Editar una caja NAP (`PATCH /network/naps/:id`).
 *
 * El backend aceptaba este PATCH desde el principio, pero no había pantalla que lo
 * llamara: se podía CREAR una caja y no corregirla nunca. Al abrirle el formulario a
 * redes (2026-09-19) el campo delicado es el GPS — se teclea "lat, lng" y vaciarlo
 * tiene que BORRAR la coordenada, no guardar "" ni dejar la vieja pegada. La cadena
 * vacía es justo el valor con el que el legacy representa "sin dato" y que
 * `geo.util.ts` descarta a mano en cada lectura.
 */
describe('NetworkWriteService.updateNap', () => {
  const NAP = {
    id: 'n1', name: 'VLLC _03', address: 'POSTE 12',
    gpsLat: '5.324710', gpsLng: '-72.401492', vlanId: 'v-vieja', vlanLegacy: 310,
  };

  const armar = () => {
    const actualizado: any[] = [];
    const prisma = {
      nap: {
        findUnique: jest.fn().mockResolvedValue(NAP),
        update: jest.fn(async ({ data }: any) => { actualizado.push(data); return { id: 'n1', name: data.name ?? NAP.name }; }),
      },
      vlan: { findUnique: jest.fn().mockResolvedValue({ legacyId: 777 }) },
    };
    const svc = new NetworkWriteService(prisma as any, {} as any, {} as any, {} as any);
    return { svc, prisma, actualizado };
  };

  it('el campo de GPS en blanco borra la coordenada (null, no "")', async () => {
    const { svc, actualizado } = armar();
    await svc.updateNap('n1', { gpsLat: '', gpsLng: '' } as any);
    expect(actualizado[0].gpsLat).toBeNull();
    expect(actualizado[0].gpsLng).toBeNull();
  });

  it('no mandar GPS deja la coordenada que ya tenía', async () => {
    const { svc, actualizado } = armar();
    await svc.updateNap('n1', { name: 'VLLC _03 BIS' } as any);
    expect(actualizado[0].gpsLat).toBe('5.324710');
    expect(actualizado[0].gpsLng).toBe('-72.401492');
    expect(actualizado[0].name).toBe('VLLC _03 BIS');
  });

  it('una coordenada nueva se guarda tal cual, sin espacios', async () => {
    const { svc, actualizado } = armar();
    await svc.updateNap('n1', { gpsLat: ' 5.34005 ', gpsLng: ' -72.36908 ' } as any);
    expect(actualizado[0].gpsLat).toBe('5.34005');
    expect(actualizado[0].gpsLng).toBe('-72.36908');
  });

  it('cambiar de VLAN arrastra el `vlanLegacy`, que es lo que mira el legacy', async () => {
    const { svc, actualizado } = armar();
    await svc.updateNap('n1', { vlanId: 'v-nueva' } as any);
    expect(actualizado[0].vlanId).toBe('v-nueva');
    expect(actualizado[0].vlanLegacy).toBe(777);
  });

  it('"Sin VLAN" la suelta y deja el `vlanLegacy` en 0', async () => {
    const { svc, actualizado } = armar();
    await svc.updateNap('n1', { vlanId: '' } as any);
    expect(actualizado[0].vlanId).toBeNull();
    expect(actualizado[0].vlanLegacy).toBe(0);
  });

  it('no tocar la VLAN la deja como estaba', async () => {
    const { svc, actualizado } = armar();
    await svc.updateNap('n1', { address: 'POSTE 13' } as any);
    expect(actualizado[0].vlanId).toBeUndefined();
    expect(actualizado[0].vlanLegacy).toBe(310);
    expect(actualizado[0].address).toBe('POSTE 13');
  });
});
