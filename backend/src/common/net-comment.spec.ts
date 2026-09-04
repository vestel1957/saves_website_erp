import { vlanDeComentario } from './net-comment';

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
