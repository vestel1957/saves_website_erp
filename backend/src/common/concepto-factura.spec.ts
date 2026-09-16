import { conceptoFactura, conceptoMesAdelantado, esAfiliacion, esTraslado, periodoDeFactura } from './concepto-factura';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('rótulos de factura en el recibo de rollo', () => {
  it('la factura se nombra por su mes y su número de cuenta', () => {
    expect(conceptoFactura({ tid: 504100, invoiceDate: d('2026-08-01') })).toBe('agosto CTA:504100');
  });

  it('la FIJA también va por mes: en el recibo no se discrimina el servicio', () => {
    // Antes salía "100 Megas F-S CTA:438298": el plan terminaba impreso en el papel
    // del cliente.
    expect(conceptoFactura({
      tid: 438298, invoiceDate: d('2026-04-06'), items: [{ productName: '100 Megas F-S' }],
    })).toBe('abril CTA:438298');
  });

  it('la AFILIACIÓN sí se nombra por lo que es: no es un mes, es la entrada', () => {
    // El papel decía "septiembre CTA:505002 — $70.000" y el cliente se iba creyendo
    // que había pagado el mes (caso real del alta 505002, 2026-09-05).
    expect(conceptoFactura({
      tid: 505002, invoiceDate: d('2026-09-05'), items: [{ productName: 'Afiliación familiar 12 meses ' }],
    })).toBe('Afiliación familiar 12 meses CTA:505002');
  });

  it('el TRASLADO se nombra por lo que es, no como la mensualidad del mes', () => {
    // Caso real: la #505134 ($30.000) salía "septiembre CTA:505134" (2026-09-14).
    expect(conceptoFactura({
      tid: 505134, invoiceDate: d('2026-09-14'), items: [{ productName: 'Traslado' }],
    })).toBe('Traslado CTA:505134');
    expect(conceptoFactura({
      tid: 1, invoiceDate: d('2026-09-14'), items: [{ productName: 'traslado ' }],
    })).toBe('traslado CTA:1');
    expect(esTraslado('TRASLADO INTERNET')).toBe(true);
    expect(esTraslado('Traslado interno De Equipos')).toBe(true);
    expect(esTraslado('100 Megas F-S')).toBe(false);
  });

  it('reconoce la afiliación escrita sin tilde y con espacios del legacy', () => {
    expect(conceptoFactura({
      tid: 500035, invoiceDate: d('2026-08-29'), items: [{ productName: ' Afiliacion 2021' }],
    })).toBe('Afiliacion 2021 CTA:500035');
    expect(esAfiliacion('Afiliación Streaming 12 meses ')).toBe(true);
    expect(esAfiliacion('100 Megas F-S')).toBe(false);
    expect(esAfiliacion(null)).toBe(false);
  });

  it('una afiliación acompañada de otros cargos manda igual', () => {
    expect(conceptoFactura({
      tid: 505100, invoiceDate: d('2026-09-06'),
      items: [{ productName: 'Cable Modem' }, { productName: 'Afiliación Combo' }],
    })).toBe('Afiliación Combo CTA:505100');
  });

  it('el mes se lee en UTC: el día 1 no se corre al mes anterior', () => {
    expect(conceptoFactura({ tid: 1, invoiceDate: d('2026-09-01') })).toBe('septiembre CTA:1');
  });

  it('el mes adelantado se rotula igual, con el tid de la factura del recibo', () => {
    expect(conceptoMesAdelantado(d('2026-10-01'), 504100)).toBe('octubre CTA:504100');
  });

  it('el modal de recaudo NO cambia: ahí el concepto sigue acompañando al mes', () => {
    // Es la pantalla de la cajera, no el papel del cliente: le sirve para saber qué
    // está cobrando cuando la mensualidad viene re-facturada como FIJA.
    expect(periodoDeFactura({
      kind: 'FIJA', invoiceDate: d('2026-04-06'), items: [{ productName: '100 Megas F-S' }],
    })).toEqual({ mes: 'abril de 2026', concepto: '100 Megas F-S' });
  });
});
