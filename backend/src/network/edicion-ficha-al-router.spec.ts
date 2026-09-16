import { conciliarSecret } from './mikrotik.service';

/**
 * Lo que se ve en «Plan y conexión» tiene que estar TAMBIÉN en el `/ppp/secret`.
 *
 * El caso que lo destapó es la abonada 57458: su ficha decía `local-address`
 * 10.1.100.1 y comentario "VLAN 130" desde antes de que la edición viajara al
 * router, así que en el guardado siguiente no había ningún CAMBIO que detectar
 * —y su secret seguía sin IP local y con el comentario viejo, "124 57458"—.
 * Por eso no se compara contra lo que se acaba de teclear sino contra lo que el
 * router tiene de verdad.
 *
 * Con dos reglas distintas: comentario e IP los manda la ficha siempre; el
 * usuario, la clave y el perfil sólo viajan si alguien acaba de editarlos,
 * porque pisarlos desde una ficha vieja deja al abonado sin autenticar o con
 * otra velocidad.
 */
describe('conciliarSecret · la ficha y el secret dicen lo mismo', () => {
  /** El secret de la abonada 57458 tal como estaba en ip_Monterrey. */
  const EN_EL_ROUTER = {
    '.id': '*BD7',
    name: 'DIANAMARIARESTREPOZAPATA2',
    service: 'pppoe',
    password: '24203232',
    profile: '300Megas',
    'remote-address': '10.100.12.29',
    comment: '124 57458',
  };
  const FICHA = {
    pppUsername: 'DIANAMARIARESTREPOZAPATA2', pppPassword: '24203232', pppProfile: '300Megas',
    ipRemote: '10.100.12.29', ipLocal: '10.1.100.1', netComment: 'VLAN 130',
  };

  it('escribe la IP local y el comentario aunque en ESE guardado no cambiara nada', () => {
    const { set, unset, avisos } = conciliarSecret(FICHA, EN_EL_ROUTER, []);
    expect(set).toEqual({ 'local-address': '10.1.100.1', comment: 'VLAN 130' });
    expect(unset).toEqual([]);
    expect(avisos).toEqual([]);
  });

  it('si el router ya coincide con la ficha no manda nada', () => {
    const alDia = { ...EN_EL_ROUTER, comment: 'VLAN 130', 'local-address': '10.1.100.1' };
    expect(conciliarSecret(FICHA, alDia, [])).toEqual({ set: {}, unset: [], avisos: [] });
  });

  it('la IP remota de la ficha manda sobre la del router', () => {
    const { set } = conciliarSecret({ ...FICHA, ipRemote: '10.100.12.99' }, EN_EL_ROUTER, ['ipRemote']);
    expect(set['remote-address']).toBe('10.100.12.99');
  });

  it('la basura del legacy no se toma por IP ("0" y vacíos no se escriben)', () => {
    const { set, unset, avisos } = conciliarSecret({ ...FICHA, ipRemote: '0', ipLocal: '' }, EN_EL_ROUTER, []);
    expect(set['remote-address']).toBeUndefined();
    expect(unset).toEqual([]); // nadie pidió borrarla: se deja la del router
    expect(avisos.join(' ')).toMatch(/IP remota y el router tiene 10\.100\.12\.29/);
  });

  it('vaciar la IP a mano SÍ la borra del secret (RouterOS no acepta cadena vacía)', () => {
    const { set, unset } = conciliarSecret({ ...FICHA, ipRemote: '' }, EN_EL_ROUTER, ['ipRemote']);
    expect(unset).toContain('remote-address');
    expect(set['remote-address']).toBeUndefined();
  });

  it('el comentario se puede dejar vacío: es texto, no una dirección', () => {
    const { set, unset } = conciliarSecret({ ...FICHA, netComment: '' }, EN_EL_ROUTER, ['netComment']);
    expect(set.comment).toBe('');
    expect(unset).toEqual([]);
  });

  it('la clave y el perfil sólo viajan si alguien los editó; si no, avisan', () => {
    const distinta = { ...FICHA, pppPassword: 'otra', pppProfile: '100Megas' };
    const sinEditar = conciliarSecret(distinta, EN_EL_ROUTER, []);
    expect(sinEditar.set.password).toBeUndefined();
    expect(sinEditar.set.profile).toBeUndefined();
    expect(sinEditar.avisos.join(' ')).toMatch(/clave PPP de la ficha no es la del router/);
    expect(sinEditar.avisos.join(' ')).toMatch(/perfil de la ficha \(100Megas\) no es el del router \(300Megas\)/);

    const editando = conciliarSecret(distinta, EN_EL_ROUTER, ['pppPassword', 'pppProfile']);
    expect(editando.set).toMatchObject({ password: 'otra', profile: '100Megas' });
  });

  it('una clave vaciada por error no se replica: dejaría al abonado sin autenticar', () => {
    const { set, avisos } = conciliarSecret({ ...FICHA, pppPassword: '' }, EN_EL_ROUTER, ['pppPassword']);
    expect(set.password).toBeUndefined();
    expect(avisos.join(' ')).toMatch(/clave PPP quedó vacía/);
  });

  it('renombrar el usuario PPP renombra el secret', () => {
    const { set } = conciliarSecret({ ...FICHA, pppUsername: 'DIANARESTREPO3' }, EN_EL_ROUTER, ['pppUsername']);
    expect(set.name).toBe('DIANARESTREPO3');
  });

  it('las MAC no tienen dónde ir: nunca salen en el /set', () => {
    const conMacs = { ...FICHA, macEquipo: 'AA:BB:CC:DD:EE:FF', macOnt: '11:22:33:44:55:66' } as any;
    const { set } = conciliarSecret(conMacs, { ...EN_EL_ROUTER, comment: 'VLAN 130', 'local-address': '10.1.100.1' }, []);
    expect(set).toEqual({});
  });
});
