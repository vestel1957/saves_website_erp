import { faltaLaFoto } from './foto-cierre.policy';
import { TIPOS_DE_CAMPO_POR_DEFECTO } from './geofence.policy';

const BASE = {
  activo: true,
  tipoOrden: 'Instalacion',
  tiposCampo: TIPOS_DE_CAMPO_POR_DEFECTO,
  permisosUsuario: ['area.tecnicos'],
  hayUsuario: true,
  fotos: 0,
};

describe('faltaLaFoto', () => {
  it('frena al técnico que cierra una instalación sin evidencia', () => {
    expect(faltaLaFoto(BASE)).toBe(true);
  });

  it('con una foto ya subida, pasa', () => {
    expect(faltaLaFoto({ ...BASE, fotos: 1 })).toBe(false);
  });

  it('una reconexión NO es de campo: se cierra sin foto (es el 85% del trabajo)', () => {
    expect(faltaLaFoto({ ...BASE, tipoOrden: 'Reconexion' })).toBe(false);
  });

  it('los procesos internos (cron del pago, sync) cierran sin usuario y sin foto', () => {
    expect(faltaLaFoto({ ...BASE, hayUsuario: false, permisosUsuario: undefined })).toBe(false);
  });

  it('gerencia y administración están exentas, como en la cerca', () => {
    expect(faltaLaFoto({ ...BASE, permisosUsuario: ['area.administracion'] })).toBe(false);
    expect(faltaLaFoto({ ...BASE, permisosUsuario: ['area.gerencia'] })).toBe(false);
    expect(faltaLaFoto({ ...BASE, permisosUsuario: ['system.admin'] })).toBe(false);
  });

  it('apagado el requisito (TICKET_REQUIRE_PHOTO=false), no frena a nadie', () => {
    expect(faltaLaFoto({ ...BASE, activo: false })).toBe(false);
  });

  it('el tipo se compara sin tildes ni mayúsculas, como en la cerca', () => {
    expect(faltaLaFoto({ ...BASE, tipoOrden: 'Revisión de Televisión' })).toBe(true);
  });
});
