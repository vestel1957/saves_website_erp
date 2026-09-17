import { faltaDocumentar, MIN_DETALLE } from './documentacion-cierre.policy';
import { partirDocumentacion } from './soluciones';

const DOC = 'Entrega de servicio a satisfacción/ Se instaló la ONU en la sala y se probó la navegación.';
const FOTO = { message: 'Foto de la visita', attach: 'a.jpg', authorId: 'u1' };
const NOTA = { message: DOC, attach: null, authorId: 'u1' };

const BASE = { activo: true, esTecnico: true, userId: 'u1', tieneNumero: true, renglones: [FOTO, NOTA] };

describe('faltaDocumentar', () => {
  it('con foto y documentación propias, deja cerrar', () => {
    expect(faltaDocumentar(BASE)).toBeNull();
  });

  it('sin nada, pide las dos cosas', () => {
    expect(faltaDocumentar({ ...BASE, renglones: [] })).toEqual({ foto: true, documentacion: true });
  });

  it('una foto con la solución y el detalle en su mensaje cuenta como las dos', () => {
    expect(faltaDocumentar({ ...BASE, renglones: [{ ...FOTO, message: DOC }] })).toBeNull();
  });

  it('sin solución de la lista no está documentada', () => {
    const r = [FOTO, { ...NOTA, message: 'Se instaló la ONU en la sala y se probó todo.' }];
    expect(faltaDocumentar({ ...BASE, renglones: r })).toEqual({ foto: false, documentacion: true });
  });

  it(`con un detalle de menos de ${MIN_DETALLE} letras no está documentada`, () => {
    const r = [FOTO, { ...NOTA, message: 'Fibra Rota/ se cambió' }];
    expect(faltaDocumentar({ ...BASE, renglones: r })?.documentacion).toBe(true);
  });

  it('lo que escribió otra persona no documenta la visita del técnico', () => {
    const ajenos = [
      { ...FOTO, authorId: 'u2' },
      { ...NOTA, authorId: 'u2' },
      { ...NOTA, authorId: null },
    ];
    expect(faltaDocumentar({ ...BASE, renglones: ajenos })).toEqual({ foto: true, documentacion: true });
  });

  it('aplica a cualquier tipo de orden: no mira si es de campo', () => {
    expect(faltaDocumentar({ ...BASE, renglones: [NOTA] })).toEqual({ foto: true, documentacion: false });
  });

  it('no frena a procesos internos, a mando ni a órdenes sin número', () => {
    expect(faltaDocumentar({ ...BASE, userId: null, renglones: [] })).toBeNull();
    expect(faltaDocumentar({ ...BASE, esTecnico: false, renglones: [] })).toBeNull();
    expect(faltaDocumentar({ ...BASE, tieneNumero: false, renglones: [] })).toBeNull();
  });

  it('apagado (TICKET_REQUIRE_DOCUMENTATION=false), no frena', () => {
    expect(faltaDocumentar({ ...BASE, activo: false, renglones: [] })).toBeNull();
  });
});

describe('partirDocumentacion', () => {
  it('reconoce la solución sin importar mayúsculas', () => {
    expect(partirDocumentacion('fibra rota/ se empalmó')).toEqual({ solucion: 'fibra rota', detalle: 'se empalmó' });
  });

  it('una barra cualquiera no es una solución', () => {
    expect(partirDocumentacion('Cra 14/ casa verde')).toEqual({ solucion: null, detalle: 'Cra 14/ casa verde' });
  });
});
