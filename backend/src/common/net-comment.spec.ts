import { conVlanEnComentario, vlanDeComentario } from './net-comment';

describe('vlanDeComentario', () => {
  it('lee la VLAN de la receta del legacy', () => {
    expect(vlanDeComentario('CENTRO COMERCIAL EL HOBO 57517 VLAN 290 FTTH')).toBe(290);
    expect(vlanDeComentario('PALMARES 57514  vlan 430 ftth')).toBe(430);
    expect(vlanDeComentario('BELLO HORIZONTE 57505 VLAN  500 FTTH')).toBe(500);
  });

  it('aguanta las variantes de captura', () => {
    // La tecnología colada entre la palabra y el número.
    expect(vlanDeComentario('Ciudad Jardin 3096 VLAN FTTH 310')).toBe(310);
    expect(vlanDeComentario('La Victoria 51490  VLAN FTTH 80')).toBe(80);
  });

  it('no confunde el número de abonado con la VLAN', () => {
    // Lo de antes de 'vlan' es el abonado; sin número después, no hay VLAN.
    expect(vlanDeComentario('EL MORICHAL 56855 FTTH VLAN')).toBeNull();
    expect(vlanDeComentario('Conjunto Residencial Prados De Valverde 1218 VLAN ')).toBeNull();
    expect(vlanDeComentario('VILLA LUCIA 3362 VLAN -- FTTH')).toBeNull();
    expect(vlanDeComentario('ALGARROBO 57509 EPON')).toBeNull();
  });

  it('descarta lo que no es una VLAN válida', () => {
    expect(vlanDeComentario('X 1 VLAN 0')).toBeNull();
    expect(vlanDeComentario('X 1 VLAN 4095')).toBeNull();
    expect(vlanDeComentario(null)).toBeNull();
    expect(vlanDeComentario('')).toBeNull();
  });
});

describe('conVlanEnComentario', () => {
  it('cambia el número en su sitio y respeta el resto del texto', () => {
    expect(conVlanEnComentario('MIRADOR 54519 VLAN 200 FTTH', 340)).toBe('MIRADOR 54519 VLAN 340 FTTH');
    expect(conVlanEnComentario('PALMARES 57514  vlan 430 ftth', 80)).toBe('PALMARES 57514  vlan 80 ftth');
    expect(conVlanEnComentario('Ciudad Jardin 3096 VLAN FTTH 310', 311)).toBe('Ciudad Jardin 3096 VLAN FTTH 311');
  });

  it('la añade donde la pone la receta del legacy: antes de la tecnología', () => {
    expect(conVlanEnComentario('ALGARROBO 57509 EPON', 290)).toBe('ALGARROBO 57509 VLAN 290 EPON');
    expect(conVlanEnComentario('EL OASIS 57506', 290)).toBe('EL OASIS 57506 VLAN 290');
    expect(conVlanEnComentario(null, 290)).toBe('VLAN 290');
  });

  it('quitarla no deja ni la palabra ni el hueco', () => {
    expect(conVlanEnComentario('MIRADOR 54519 VLAN 200 FTTH', null)).toBe('MIRADOR 54519 FTTH');
    expect(conVlanEnComentario('VLAN 200', null)).toBeNull();
    expect(conVlanEnComentario(null, null)).toBeNull();
  });

  it('lo que escribe se vuelve a leer igual', () => {
    for (const c of ['MIRADOR 54519 VLAN 200 FTTH', 'ALGARROBO 57509 EPON', 'EL OASIS 57506', null]) {
      expect(vlanDeComentario(conVlanEnComentario(c, 777))).toBe(777);
    }
  });
});
