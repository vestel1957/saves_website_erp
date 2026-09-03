import { MikrotikService } from './mikrotik.service';

/**
 * Un perfil ambiguo dejaba al abonado ACTIVO y sin navegar.
 *
 * RouterOS no compara `profile=` literalmente: lo resuelve por PREFIJO. Los
 * planes activos guardaban la velocidad pelada ("100") y el router respondía
 * `ambiguous value of profile, more than one possible value matches input`
 * porque coincidía con 100Megas, 100MegasD y 100MegasSt a la vez. Ese error
 * tumbaba el /ppp/secret/add ENTERO: el cliente quedaba ACTIVO en el sistema,
 * sin secret en el router, y la sesión se le colaba por el RADIUS a un pool que
 * no sale a internet. El módem decía "conectado" y el abonado no navegaba.
 *
 * El arreglo es mandar el `.id` del perfil, que no admite interpretación, y
 * fallar con un mensaje que diga qué se pidió y qué hay cuando no se puede.
 */
describe('MikrotikService · el perfil PPP se resuelve a .id, nunca por prefijo', () => {
  const PERFILES = [
    { '.id': '*0', name: 'default' },
    { '.id': '*24', name: '100Megas' },
    { '.id': '*25', name: '100MegasD' },
    { '.id': '*26', name: '100MegasSt' },
    { '.id': '*2B', name: '30MegasSt ' }, // con espacio al final, como en el router real
  ];

  const armar = () => {
    const svc = new MikrotikService({} as any, {} as any, {} as any);
    const api = { comm: jest.fn().mockResolvedValue(PERFILES) };
    const resolver = (perfil: string) =>
      (svc as any).resolveProfileId(api, perfil, 'Ip_Villanueva_GPON');
    return { resolver };
  };

  it('el nombre exacto gana aunque sea prefijo de otros', async () => {
    const { resolver } = armar();
    await expect(resolver('100Megas')).resolves.toEqual({ id: '*24', name: '100Megas' });
  });

  it('la velocidad pelada del plan ya no se manda: avisa cuál es el perfil bueno', async () => {
    const { resolver } = armar();
    await expect(resolver('100')).rejects.toThrow(/ambiguo.*100Megas, 100MegasD, 100MegasSt/s);
  });

  it('un perfil que no existe dice qué hay en ESE router', async () => {
    const { resolver } = armar();
    await expect(resolver('600Megas')).rejects.toThrow(/no existe en Ip_Villanueva_GPON/);
  });

  it('resuelve ignorando mayúsculas y el espacio sobrante del router', async () => {
    const { resolver } = armar();
    await expect(resolver('100MEGASST')).resolves.toEqual({ id: '*26', name: '100MegasSt' });
    await expect(resolver('30MegasSt')).resolves.toEqual({ id: '*2B', name: '30MegasSt' });
  });

  it('un prefijo que sólo cuadra con uno sigue sirviendo', async () => {
    const { resolver } = armar();
    await expect(resolver('100MegasD')).resolves.toEqual({ id: '*25', name: '100MegasD' });
  });

  it('sin perfil cae en default, que existe en todo router', async () => {
    const { resolver } = armar();
    await expect(resolver('')).resolves.toEqual({ id: '*0', name: 'default' });
  });
});
