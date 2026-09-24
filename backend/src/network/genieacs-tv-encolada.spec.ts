import { GenieacsService } from './genieacs.service';

/**
 * La TV que el equipo NO aceptó no puede contar como restaurada.
 *
 * El NBI de GenieACS contesta 200 cuando el CPE ejecutó la tarea y 202 cuando la
 * ENCOLÓ porque el equipo no contestó al connection request. Los dos son "ok" para
 * fetch, y confundirlos tenía una consecuencia cara: al pagar, el sistema daba la
 * TV por restaurada, cerraba la orden de "Reconexion Television" y marcaba el
 * servicio ACTIVO — con el cliente mirando una pantalla en negro. En el corte da
 * igual (el tag lo sostiene y el provision lo aplica en el próximo inform), pero en
 * el alta se quita el tag y la tarea encolada es lo ÚNICO que devuelve la señal.
 */
describe('GenieacsService · TV: la tarea encolada no es una TV restaurada', () => {
  const server = { id: 's1', name: 'ACS', nbiUrl: 'http://acs', username: '', password: '' };

  const armar = (respuestas: Record<string, { ok: boolean; status: number; queued: boolean }>) => {
    const prisma: any = {
      appSetting: {
        // La TV "sólo en el sistema" se apaga aquí: estas pruebas van por la red.
        findUnique: jest.fn(async ({ where }: any) =>
          where?.key === 'network.tvSoloSistema' ? { value: 'false' } : { value: 'true' }),
      },
      genieacsServer: { findFirst: jest.fn().mockResolvedValue(server) },
      genieacsActionLog: { create: jest.fn().mockResolvedValue({}) },
      subscriber: { findMany: jest.fn() },
      oltOnu: { findMany: jest.fn().mockResolvedValue([]) },
      subscriberService: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const svc = new GenieacsService(prisma, {} as any);
    const nbi = {
      removeTag: jest.fn().mockResolvedValue(true),
      addTag: jest.fn().mockResolvedValue(true),
      setBool: jest.fn(async (id: string) => respuestas[id]),
    };
    (svc as any).nbi = () => nbi;
    return { svc, prisma, nbi };
  };

  const ok200 = { ok: true, status: 200, queued: false };
  const encolada202 = { ok: true, status: 202, queued: true };

  it('el ALTA con 202 se reporta FALLIDA: el equipo no contestó', async () => {
    const { svc } = armar({ 'cpe-1': encolada202 });
    const r: any = await svc.restoreTv(['cpe-1']);
    expect(r.ok).toBe(false);
    expect(r.done).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.encoladas).toBe(1);
    expect(r.porDispositivo['cpe-1'].ok).toBe(false);
    expect(r.porDispositivo['cpe-1'].detalle).toMatch(/no contestó/i);
  });

  it('el ALTA con 200 sí cuenta como aplicada', async () => {
    const { svc } = armar({ 'cpe-1': ok200 });
    const r: any = await svc.restoreTv(['cpe-1']);
    expect(r.ok).toBe(true);
    expect(r.done).toBe(1);
    expect(r.porDispositivo['cpe-1'].ok).toBe(true);
  });

  it('el CORTE con 202 sigue siendo válido: el tag lo sostiene hasta el próximo inform', async () => {
    const { svc } = armar({ 'cpe-1': encolada202 });
    const r: any = await svc.cutTv(['cpe-1']);
    expect(r.ok).toBe(true);
    expect(r.done).toBe(1);
  });

  it('por abonado: el que quedó encolado NO se marca ACTIVO ni se da por reconectado', async () => {
    const { svc, prisma } = armar({ 'cpe-ok': ok200, 'cpe-mudo': encolada202 });
    prisma.subscriber.findMany.mockResolvedValue([
      { id: 'sub-ok', abonado: 1, fullName: 'A', pppUsername: 'USUARIO-OK' },
      { id: 'sub-mudo', abonado: 2, fullName: 'B', pppUsername: 'USUARIO-MUDO' },
    ]);
    (svc as any).devicesOf = async () => [
      { id: 'cpe-ok', pppUser: 'USUARIO-OK' },
      { id: 'cpe-mudo', pppUser: 'USUARIO-MUDO' },
    ];

    const r: any = await svc.tvBatchBySubscribers(['sub-ok', 'sub-mudo'], true);
    const fila = (id: string) => r.results.find((x: any) => x.subscriberId === id);
    expect(fila('sub-ok').ok).toBe(true);
    expect(fila('sub-mudo').ok).toBe(false);
    expect(fila('sub-mudo').detail).toMatch(/no contestó/i);
    // Solo el que de verdad volvió cambia de estado en la ficha.
    expect(prisma.subscriberService.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ subscriberId: { in: ['sub-ok'] } }) }),
    );
  });

  it('con más de 10 fallos, el nº 11 sigue contando como fallo (ya no se lee de `errors`)', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `cpe-${i}`);
    const { svc } = armar(Object.fromEntries(ids.map((id) => [id, encolada202])) as any);
    const r: any = await svc.restoreTv(ids);
    expect(r.failed).toBe(12);
    expect(r.errors.length).toBe(10);
    expect(r.porDispositivo['cpe-11'].ok).toBe(false);
  });
});
