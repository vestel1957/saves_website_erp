import { esIpRemotaUtil, faltaLaIpRemota } from './ip-remota.policy';
import { TIPOS_DE_CAMPO_POR_DEFECTO } from './geofence.policy';

const BASE = {
  activo: true,
  tipoOrden: 'Instalacion',
  tiposCampo: TIPOS_DE_CAMPO_POR_DEFECTO,
  permisosUsuario: ['area.tecnicos'],
  hayUsuario: true,
  hayCliente: true,
  tieneInternet: true,
  ipRemota: null as string | null,
};

describe('esIpRemotaUtil', () => {
  it('acepta una dirección de cliente de verdad', () => {
    expect(esIpRemotaUtil('10.100.13.25')).toBe(true);
    expect(esIpRemotaUtil(' 80.0.4.120 ')).toBe(true);
  });

  it('rechaza la herencia del legacy: vacío, "0" y "0.0.0.0"', () => {
    // 9.509 abonados en blanco y 1.611 con "0" el 2026-09-10.
    expect(esIpRemotaUtil(null)).toBe(false);
    expect(esIpRemotaUtil('')).toBe(false);
    expect(esIpRemotaUtil('0')).toBe(false);
    expect(esIpRemotaUtil('0.0.0.0')).toBe(false);
  });

  it('rechaza lo que no es dirección de un cliente', () => {
    expect(esIpRemotaUtil('127.0.0.1')).toBe(false);
    expect(esIpRemotaUtil('255.255.255.255')).toBe(false);
    expect(esIpRemotaUtil('10.100.13.0')).toBe(false); // red
    expect(esIpRemotaUtil('10.100.13.255')).toBe(false); // broadcast
    expect(esIpRemotaUtil('999.1.1.1')).toBe(false);
    expect(esIpRemotaUtil('10.100.13')).toBe(false);
    expect(esIpRemotaUtil('dhcp')).toBe(false);
  });
});

describe('faltaLaIpRemota', () => {
  it('frena al técnico que cierra una instalación dejando al cliente sin IP fija', () => {
    expect(faltaLaIpRemota(BASE)).toBe(true);
  });

  it('con IP buena en la ficha, pasa', () => {
    expect(faltaLaIpRemota({ ...BASE, ipRemota: '10.20.4.88' })).toBe(false);
  });

  it('un "0" heredado del legacy no cuenta como IP activa', () => {
    expect(faltaLaIpRemota({ ...BASE, ipRemota: '0' })).toBe(true);
  });

  it('una reconexión NO es de campo: se cierra sin mirar la IP (es el 85% del trabajo)', () => {
    expect(faltaLaIpRemota({ ...BASE, tipoOrden: 'Reconexion Internet' })).toBe(false);
  });

  it('el cliente de sólo televisión no tiene secret PPPoE: no se le pide', () => {
    expect(faltaLaIpRemota({ ...BASE, tipoOrden: 'Revision de television', tieneInternet: false })).toBe(false);
  });

  it('en un retiro voluntario el servicio se va: no se exige acceso remoto', () => {
    expect(faltaLaIpRemota({ ...BASE, tipoOrden: 'Retiro voluntario' })).toBe(false);
  });

  it('una orden sin cliente (solicitud del call center) no tiene IP que exigir', () => {
    expect(faltaLaIpRemota({ ...BASE, hayCliente: false })).toBe(false);
  });

  it('los procesos internos (cron del pago, sync) cierran sin usuario y sin IP', () => {
    expect(faltaLaIpRemota({ ...BASE, hayUsuario: false, permisosUsuario: undefined })).toBe(false);
  });

  it('gerencia, administración y superusuario están exentos, como en la foto y la cerca', () => {
    expect(faltaLaIpRemota({ ...BASE, permisosUsuario: ['area.administracion'] })).toBe(false);
    expect(faltaLaIpRemota({ ...BASE, permisosUsuario: ['area.gerencia'] })).toBe(false);
    expect(faltaLaIpRemota({ ...BASE, permisosUsuario: ['system.admin'] })).toBe(false);
  });

  it('apagado el requisito (TICKET_REQUIRE_REMOTE_IP=false), no frena a nadie', () => {
    expect(faltaLaIpRemota({ ...BASE, activo: false })).toBe(false);
  });

  it('el tipo se compara sin tildes ni mayúsculas', () => {
    expect(faltaLaIpRemota({ ...BASE, tipoOrden: 'MIGRACIÓN' })).toBe(true);
    expect(faltaLaIpRemota({ ...BASE, tipoOrden: 'RETIRO VOLUNTARIO' })).toBe(false);
  });
});
