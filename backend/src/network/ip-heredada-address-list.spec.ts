import { MikrotikService } from './mikrotik.service';

/**
 * La IP que antes fue de otro abonado.
 *
 * RouterOS no deja dos entradas con la misma dirección en la misma address-list
 * ("failure: already have such entry"), y el servicio buscaba sólo por comment.
 * Abonado 510 (NELFA TORREZ, `activo_7940`) pagó el 21-09-2026: su IP 80.0.4.59
 * seguía en ACTIVOS de Villanueva EPON con `activo_9162` (una retirada), el `add`
 * rebotó DESPUÉS de sacarla de MOROSOS, y nexus lo dio por fallido: ficha en rojo y
 * una orden de reconexión que ya no hacía falta.
 *
 * El doble del router de abajo hace cumplir esa unicidad, igual que el de verdad.
 */
class RouterFalso {
  private seq = 1;
  lista: Array<Record<string, string>> = [];
  secrets: Array<Record<string, string>> = [];

  constructor(entradas: Array<{ list: string; address: string; comment: string }>, secrets: Array<Record<string, string>>) {
    for (const e of entradas) this.lista.push({ '.id': `*${this.seq++}`, dynamic: 'false', ...e });
    this.secrets = secrets;
  }

  async comm(cmd: string, args: Record<string, string> = {}): Promise<Array<Record<string, string>>> {
    const filtro = (rows: Array<Record<string, string>>) =>
      rows.filter((r) => Object.entries(args).every(([k, v]) => !k.startsWith('?') || r[k.slice(1)] === v));
    switch (cmd) {
      case '/ppp/secret/getall': return filtro(this.secrets);
      case '/ppp/active/getall': return [];
      case '/ip/firewall/address-list/print': return filtro(this.lista).map((r) => ({ ...r }));
      case '/ip/firewall/address-list/remove':
        this.lista = this.lista.filter((r) => r['.id'] !== args['.id']);
        return [];
      case '/ip/firewall/address-list/add':
        if (this.lista.some((r) => r.list === args.list && r.address === args.address)) {
          throw new Error('failure: already have such entry');
        }
        this.lista.push({ '.id': `*${this.seq++}`, dynamic: 'false', list: args.list, address: args.address, comment: args.comment });
        return [];
      case '/ip/firewall/address-list/set': {
        const e = this.lista.find((r) => r['.id'] === args['.id'])!;
        const address = args.address ?? e.address;
        if (this.lista.some((r) => r !== e && r.list === e.list && r.address === address)) {
          throw new Error('failure: already have such entry');
        }
        Object.assign(e, args);
        return [];
      }
      default: return [];
    }
  }

  en(list: string) {
    return this.lista.filter((r) => r.list === list).map((r) => `${r.address}=${r.comment}`);
  }
}

describe('MikrotikService · IP heredada de otro abonado en la address-list', () => {
  const svc = new MikrotikService({} as any, {} as any, {} as any) as any;
  const NELFA = { id: 's1', legacyId: 7940, pppUsername: 'NELFAYEDITHTORREZ', ipRemote: '80.0.4.59' };
  const SECRET = { '.id': '*1E0', name: 'NELFAYEDITHTORREZ', 'remote-address': '80.0.4.59', disabled: 'false' };

  it('reconectar ADOPTA la entrada ajena de ACTIVOS en vez de chocar con ella', async () => {
    const api = new RouterFalso(
      [
        { list: 'MOROSOS', address: '80.0.4.59', comment: 'activo_7940' },
        { list: 'ACTIVOS', address: '80.0.4.59', comment: 'activo_9162' },
      ],
      [SECRET],
    );
    const r = await svc.reconnectOnApi(api, NELFA, {} as any);

    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.wasCut).toBe(true);
    expect(api.en('MOROSOS')).toEqual([]);
    expect(api.en('ACTIVOS')).toEqual(['80.0.4.59=activo_7940']);
  });

  it('reconectar saca de MOROSOS también la entrada ajena con su IP (si no, sigue bloqueado)', async () => {
    const api = new RouterFalso([{ list: 'MOROSOS', address: '80.0.4.59', comment: 'activo_9162' }], [SECRET]);
    const r = await svc.reconnectOnApi(api, NELFA, {} as any);

    expect(r.ok).toBe(true);
    expect(api.en('MOROSOS')).toEqual([]);
    expect(api.en('ACTIVOS')).toEqual(['80.0.4.59=activo_7940']);
  });

  it('con su propia entrada y una ajena de la misma IP, la ajena sobra', async () => {
    const api = new RouterFalso(
      [
        { list: 'ACTIVOS', address: '80.0.9.9', comment: 'activo_7940' },
        { list: 'ACTIVOS', address: '80.0.4.59', comment: 'activo_9162' },
      ],
      [SECRET],
    );
    const r = await svc.reconnectOnApi(api, NELFA, {} as any);

    expect(r.ok).toBe(true);
    expect(api.en('ACTIVOS')).toEqual(['80.0.4.59=activo_7940']);
  });

  it('cortar no deja la IP en ACTIVOS bajo el comment de otro, ni choca al meterla en MOROSOS', async () => {
    const api = new RouterFalso(
      [
        { list: 'ACTIVOS', address: '80.0.4.59', comment: 'activo_9162' },
        { list: 'MOROSOS', address: '80.0.4.59', comment: 'activo_9162' },
      ],
      [SECRET],
    );
    const r = await svc.cutOnApi(api, NELFA);

    expect(r.ok).toBe(true);
    expect(api.en('ACTIVOS')).toEqual([]);
    expect(api.en('MOROSOS')).toEqual(['80.0.4.59=activo_7940']);
  });

  it('los otros routers de la sede (sólo listas) tampoco chocan', async () => {
    const api = new RouterFalso([{ list: 'ACTIVOS', address: '80.0.4.59', comment: 'activo_9162' }], []);
    const r = await svc.unmarkMorosoOnApi(api, NELFA, '80.0.4.59');

    expect(r.ok).toBe(true);
    expect(api.en('ACTIVOS')).toEqual(['80.0.4.59=activo_7940']);
  });
});
