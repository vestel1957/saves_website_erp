import { MikrotikService } from './mikrotik.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';

/**
 * El interruptor manual de MOROSOS (port del botón «Activar / Desactivar» del legacy).
 *
 * Dos cosas se comprueban aquí, y las dos son el motivo de que exista este método en
 * vez de reusar `cut()` / `reconnect()`:
 *
 *  1. **Quién.** Se pidió para UNA persona, y `exigirPermisos` deja pasar a
 *     `system.admin` —veinte cuentas activas—, así que el candado de verdad es el
 *     permiso nominal comprobado dentro de la operación. Un superusuario SIN el
 *     permiso a su nombre tiene que rebotar igual que cualquiera.
 *  2. **Qué.** Mueve la IP de lista y nada más: no toca el estado de la ficha, no
 *     cierra la sesión PPP y no abre órdenes. Si algún día empieza a escribir en
 *     `subscriber`, la ficha y el router dejarán de contar lo mismo y el corte por
 *     mora del mes siguiente pasará por encima sin avisar.
 */
describe('MikrotikService · interruptor manual de MOROSOS', () => {
  const SANTIAGO = { id: 'u1', name: 'Santiago García', permissions: [APP_PERMISSIONS.NETWORK_MOROSOS_TOGGLE] } as any;
  const SUPERUSUARIO = { id: 'u2', name: 'Otro', permissions: [APP_PERMISSIONS.SYSTEM_ADMIN] } as any;

  const armar = () => {
    const prisma: any = {
      appSetting: { findUnique: jest.fn().mockResolvedValue({ value: 'false' }) }, // dry-run
      subscriber: {
        findUnique: jest.fn().mockResolvedValue({
          id: 's1', legacyId: 20970, pppUsername: 'OSTILOCONTRERASROJAS', ipRemote: '10.100.11.4',
          installTech: 'GPON', status: 'ACTIVO', branch: { legacyId: 7 }, services: [],
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      mikrotik: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'r1', name: 'ip_tauramena', ip: '10.0.0.1', port: '5051', tech: 'GPON', sedeLegacy: 7, isDefault: true },
          { id: 'r2', name: 'ip_tauramena_2', ip: '10.0.0.2', port: '5051', tech: 'RADIO', sedeLegacy: 7, isDefault: false },
        ]),
      },
      mikrotikActionLog: { create: jest.fn().mockResolvedValue({}) },
      subscriberStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    const svc = new MikrotikService(prisma as any, {} as any, {} as any);
    return { svc, prisma };
  };

  it('el superusuario que no lo tiene a su nombre no entra', async () => {
    const { svc, prisma } = armar();
    await expect(svc.toggleMoroso('s1', 'desactivar', SUPERUSUARIO)).rejects.toThrow(/reservado/i);
    // Y rebota ANTES de tocar nada: ni siquiera se leyó la ficha.
    expect(prisma.subscriber.findUnique).not.toHaveBeenCalled();
  });

  it('sin usuario tampoco (una llamada sin sesión no es "todos los permisos")', async () => {
    const { svc } = armar();
    await expect(svc.toggleMoroso('s1', 'activar', undefined)).rejects.toThrow(/reservado/i);
  });

  it('desactivar planea meter la IP en MOROSOS, en el router del cliente y en los demás de la sede', async () => {
    const { svc } = armar();
    const r = await svc.toggleMoroso('s1', 'desactivar', SANTIAGO);

    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.action).toBe('MOROSO_ON');
    const plan = r.steps.join(' | ');
    expect(plan).toContain('address-list ACTIVOS remove (comment=activo_20970)');
    expect(plan).toContain('address-list MOROSOS add/set (comment=activo_20970)');
    // El otro Mikrotik de la sede: si no, el cliente sigue navegando por ahí.
    expect(plan).toContain('[ip_tauramena_2] address-list MOROSOS add');
    // Lo que NO se hace: cerrar la sesión abierta ni deshabilitar el secret.
    expect(plan).not.toMatch(/ppp\/active/);
    expect(plan).not.toMatch(/disabled=yes/);
  });

  it('activar planea sacarla de MOROSOS y sanar el secret que un corte viejo dejó apagado', async () => {
    const { svc } = armar();
    const r = await svc.toggleMoroso('s1', 'activar', SANTIAGO);

    expect(r.action).toBe('MOROSO_OFF');
    const plan = r.steps.join(' | ');
    expect(plan).toContain('address-list MOROSOS remove (comment=activo_20970)');
    expect(plan).toContain('address-list ACTIVOS add/set (comment=activo_20970)');
    expect(plan).toContain('disabled=no');
    expect(plan).toContain('[ip_tauramena_2] address-list MOROSOS remove');
  });

  it('no le mueve el estado a la ficha (ni deja historial que se vaya al legacy)', async () => {
    const { svc, prisma } = armar();
    await svc.toggleMoroso('s1', 'desactivar', SANTIAGO);
    await svc.toggleMoroso('s1', 'activar', SANTIAGO);

    expect(prisma.subscriber.update).not.toHaveBeenCalled();
    expect(prisma.subscriber.updateMany).not.toHaveBeenCalled();
    expect(prisma.subscriberStatusHistory.create).not.toHaveBeenCalled();
  });

  it('queda auditado con su acción y su autor, también en simulación', async () => {
    const { svc, prisma } = armar();
    await svc.toggleMoroso('s1', 'desactivar', SANTIAGO);

    const [{ data }] = prisma.mikrotikActionLog.create.mock.calls[0];
    expect(data).toMatchObject({
      subscriberId: 's1',
      action: 'MOROSO_ON',
      ok: true,
      dryRun: true,
      userName: 'Santiago García',
      pppUsername: 'OSTILOCONTRERASROJAS',
    });
  });

  it('el abonado sin usuario PPPoE no tiene IP que mover: se dice, no se falla en silencio', async () => {
    const { svc, prisma } = armar();
    prisma.subscriber.findUnique.mockResolvedValue({
      id: 's1', legacyId: 20970, pppUsername: null, ipRemote: null,
      installTech: 'GPON', status: 'ACTIVO', branch: { legacyId: 7 }, services: [],
    });
    await expect(svc.toggleMoroso('s1', 'desactivar', SANTIAGO)).rejects.toThrow(/PPPoE/);
  });
});
