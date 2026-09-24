import {
  aplicaDatosDelCliente,
  datosQueFaltan,
  faltanDatosDelCliente,
  mensajeDatosCliente,
  type EntradaDatosCliente,
} from './datos-cliente.policy';
import { TIPOS_DE_CAMPO_POR_DEFECTO } from './geofence.policy';

const BASE: EntradaDatosCliente = {
  activo: true,
  tipoOrden: 'Instalacion',
  tiposCampo: TIPOS_DE_CAMPO_POR_DEFECTO,
  permisosUsuario: ['area.tecnicos'],
  hayUsuario: true,
  esTecnicoDeCampo: true,
  hayCliente: true,
  tieneUbicacion: false,
  tieneFotoVivienda: false,
};

describe('datos del cliente antes de empezar la visita', () => {
  it('frena la visita de campo a la que le faltan los dos', () => {
    expect(faltanDatosDelCliente(BASE)).toBe(true);
    expect(datosQueFaltan(BASE)).toEqual({ ubicacion: true, foto: true });
  });

  it('pide sólo lo que falta', () => {
    expect(datosQueFaltan({ ...BASE, tieneUbicacion: true })).toEqual({ ubicacion: false, foto: true });
    expect(datosQueFaltan({ ...BASE, tieneFotoVivienda: true })).toEqual({ ubicacion: true, foto: false });
  });

  it('deja empezar cuando el cliente ya tiene las dos cosas', () => {
    expect(faltanDatosDelCliente({ ...BASE, tieneUbicacion: true, tieneFotoVivienda: true })).toBe(false);
  });

  // El 85% del trabajo: cortes y reconexiones. Pedirles foto de la vivienda pararía
  // la facturación y la reconexión automática el primer día.
  it('no toca las órdenes que no son de campo', () => {
    expect(faltanDatosDelCliente({ ...BASE, tipoOrden: 'Corte Internet' })).toBe(false);
    expect(faltanDatosDelCliente({ ...BASE, tipoOrden: 'Reconexion Internet' })).toBe(false);
    expect(aplicaDatosDelCliente({ ...BASE, tipoOrden: 'Autenticacion' })).toBe(false);
  });

  it('las visitas de campo sí, todas las de la lista', () => {
    for (const tipo of TIPOS_DE_CAMPO_POR_DEFECTO) {
      expect(faltanDatosDelCliente({ ...BASE, tipoOrden: tipo })).toBe(true);
    }
  });

  // Los procesos internos mueven órdenes a REALIZANDO sin usuario (reconexión
  // automática al entrar el pago): no hay nadie a quien pedirle una foto.
  it('no frena a los procesos sin usuario', () => {
    expect(
      faltanDatosDelCliente({ ...BASE, hayUsuario: false, esTecnicoDeCampo: false, permisosUsuario: undefined }),
    ).toBe(false);
  });

  /**
   * SÓLO AL TÉCNICO DE CAMPO (2026-09-18). Sistemas, caja, contabilidad y cualquier
   * otro que mueva una orden desde la oficina no están en la vivienda: pedirles la
   * foto de la casa dejaría la orden trabada sin forma de destrabarla.
   */
  it('a quien no es técnico de campo no se le pide nada', () => {
    expect(faltanDatosDelCliente({ ...BASE, esTecnicoDeCampo: false, permisosUsuario: ['area.sistemas'] })).toBe(false);
    expect(faltanDatosDelCliente({ ...BASE, esTecnicoDeCampo: false, permisosUsuario: ['area.caja'] })).toBe(false);
    expect(aplicaDatosDelCliente({ ...BASE, esTecnicoDeCampo: false })).toBe(false);
  });

  it('exentos: gerencia, administración y superusuario', () => {
    // `esTecnicoDeCampo` ya los deja fuera, y el candado de exentos se comprueba
    // igual: si mañana se amplía a quién se le pide, ellos siguen exentos.
    expect(faltanDatosDelCliente({ ...BASE, esTecnicoDeCampo: false, permisosUsuario: ['area.gerencia'] })).toBe(false);
    expect(faltanDatosDelCliente({ ...BASE, esTecnicoDeCampo: false, permisosUsuario: ['area.administracion'] })).toBe(false);
    expect(faltanDatosDelCliente({ ...BASE, esTecnicoDeCampo: false, permisosUsuario: ['system.admin'] })).toBe(false);
    expect(faltanDatosDelCliente({ ...BASE, permisosUsuario: ['area.tecnicos', 'area.gerencia'] })).toBe(false);
  });

  it('una orden sin cliente no tiene a quién fotografiar', () => {
    expect(faltanDatosDelCliente({ ...BASE, hayCliente: false })).toBe(false);
  });

  it('el interruptor lo apaga entero', () => {
    expect(faltanDatosDelCliente({ ...BASE, activo: false })).toBe(false);
    expect(datosQueFaltan({ ...BASE, activo: false })).toEqual({ ubicacion: false, foto: false });
  });

  it('el tipo se compara sin tildes ni mayúsculas', () => {
    expect(faltanDatosDelCliente({ ...BASE, tipoOrden: '  MIGRACIÓN ' })).toBe(true);
  });

  describe('el mensaje', () => {
    it('nombra sólo lo que falta', () => {
      expect(mensajeDatosCliente({ ubicacion: true, foto: true })).toContain('la ubicación del cliente y la foto');
      expect(mensajeDatosCliente({ ubicacion: true, foto: false })).not.toContain('foto de la vivienda');
      expect(mensajeDatosCliente({ ubicacion: false, foto: true })).not.toContain('ubicación del cliente');
    });

    it('dice qué hacer, no sólo qué falta', () => {
      expect(mensajeDatosCliente({ ubicacion: true, foto: false })).toContain('Capturar GPS aquí');
      expect(mensajeDatosCliente({ ubicacion: false, foto: true })).toContain('foto de la casa');
    });
  });
});
