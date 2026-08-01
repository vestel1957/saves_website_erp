import { MIMES_DOCUMENTO, MIMES_IMAGEN, MIMES_IMAGEN_Y_PDF, disposicionAdjunto, mimeAceptado, nombreEnDisco } from './uploads';

describe('listas de MIME permitidos', () => {
  it('agregar Word NO lo habilita en los módulos que solo aceptan imagen y PDF', () => {
    // Esta es la regresión concreta: las listas se derivaban del mapa de
    // extensiones, así que sumar Word para las hojas de vida habría dejado subir
    // un .docx como comprobante de caja o evidencia de una orden.
    expect(MIMES_IMAGEN_Y_PDF).not.toContain('application/msword');
    expect(MIMES_IMAGEN_Y_PDF).not.toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(MIMES_IMAGEN).not.toContain('application/pdf');
  });

  it('los documentos de funcionario sí aceptan Word, PDF e imagen', () => {
    expect(mimeAceptado('application/msword', MIMES_DOCUMENTO)).toBe(true);
    expect(mimeAceptado('application/vnd.openxmlformats-officedocument.wordprocessingml.document', MIMES_DOCUMENTO)).toBe(true);
    expect(mimeAceptado('application/pdf', MIMES_DOCUMENTO)).toBe(true);
    expect(mimeAceptado('image/jpeg', MIMES_DOCUMENTO)).toBe(true);
  });

  it('rechaza lo ejecutable en todas las listas', () => {
    for (const lista of [MIMES_IMAGEN, MIMES_IMAGEN_Y_PDF, MIMES_DOCUMENTO]) {
      expect(mimeAceptado('text/html', lista)).toBe(false);
      expect(mimeAceptado('application/javascript', lista)).toBe(false);
      expect(mimeAceptado('image/svg+xml', lista)).toBe(false); // SVG lleva script adentro
    }
  });
});

describe('nombreEnDisco', () => {
  it('deriva la extensión del MIME validado, nunca del nombre recibido', () => {
    expect(nombreEnDisco('abc123', 'application/pdf')).toBe('abc123.pdf');
    expect(nombreEnDisco('abc123', 'image/jpeg')).toBe('abc123.jpg');
    expect(nombreEnDisco('abc123', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('abc123.docx');
  });

  it('un MIME desconocido cae a .bin y no a algo ejecutable', () => {
    expect(nombreEnDisco('abc123', 'text/html')).toBe('abc123.bin');
  });
});

describe('disposicionAdjunto', () => {
  it('conserva las tildes en el nombre del archivo', () => {
    // Sin `filename*`, el navegador guardaba "Hoja de vida Andr?s.pdf": las
    // cabeceras HTTP son ISO-8859-1 y la é no sobrevive.
    const h = disposicionAdjunto('Hoja de vida Andrés.pdf');
    expect(h).toContain("filename*=UTF-8''Hoja%20de%20vida%20Andr%C3%A9s.pdf");
    // Y deja un respaldo ASCII legible para clientes que no entiendan filename*.
    expect(h).toContain('filename="Hoja de vida Andr_s.pdf"');
  });

  it('no deja inyectar cabeceras con saltos de línea', () => {
    const h = disposicionAdjunto('malo\r\nSet-Cookie: robada=1');
    expect(h).not.toContain('\n');
    expect(h).not.toContain('\r');
  });

  it('no deja romper el entrecomillado con una comilla', () => {
    expect(disposicionAdjunto('a"b.pdf')).toContain('filename="ab.pdf"');
  });

  it('un nombre vacío cae a un valor por defecto', () => {
    expect(disposicionAdjunto('')).toContain('filename="adjunto"');
    expect(disposicionAdjunto(undefined)).toContain('filename="adjunto"');
  });
});
