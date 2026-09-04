import { diffConceptos, movimientoDeAuditoria, movimientoDeNota } from './historial-factura';

/** Fila de auditoría con la forma exacta que escribe `FacturasService.updateInvoice`. */
const logEdicion = (before: any, after: any) => ({
  id: 'log1', action: 'UPDATE', createdAt: new Date('2026-09-01T15:00:00Z'), before, after,
});

describe('diffConceptos', () => {
  it('dice qué renglón cambió de precio y en cuánto', () => {
    const frases = diffConceptos(
      [{ product: '100 Megas', description: 'Mensualidad', qty: 1, price: 45000 }],
      [{ product: '100 Megas', description: 'Mensualidad', qty: 1, price: 50000 }],
    );
    expect(frases).toEqual(['«100 Megas»: 1 × $45.000 → 1 × $50.000']);
  });

  it('nombra lo que se agregó y lo que se quitó', () => {
    const frases = diffConceptos(
      [{ product: 'Punto adicional', qty: 1, price: 5000 }],
      [{ product: 'Reconexión', qty: 1, price: 20000 }],
    );
    expect(frases).toContain('Se quitó «Punto adicional» (1 × $5.000)');
    expect(frases).toContain('Se agregó «Reconexión» (1 × $20.000)');
  });

  it('no inventa cambios cuando la edición reescribe los mismos renglones', () => {
    // La edición BORRA los ítems y los reinserta (paridad legacy): sin emparejarlos
    // por nombre, cada corrección saldría como "se quitó todo y se agregó todo".
    const items = [
      { product: '100 Megas', qty: 1, price: 45000 },
      { product: 'Punto adicional', qty: 2, price: 5000 },
    ];
    expect(diffConceptos(items, items.map((i) => ({ ...i })))).toEqual([]);
  });

  it('distingue dos renglones con el mismo nombre por su orden', () => {
    const frases = diffConceptos(
      [{ product: 'Punto adicional', qty: 1, price: 5000 }, { product: 'Punto adicional', qty: 1, price: 5000 }],
      [{ product: 'Punto adicional', qty: 1, price: 5000 }],
    );
    expect(frases).toEqual(['Se quitó «Punto adicional» (1 × $5.000)']);
  });
});

describe('movimientoDeAuditoria', () => {
  it('saca a la luz el motivo y el cambio de total de una edición', () => {
    const m = movimientoDeAuditoria(logEdicion(
      { total: 45000, status: 'DUE', items: [{ product: '100 Megas', qty: 1, price: 45000 }] },
      {
        total: 50000, status: 'DUE', reason: 'Se cobró el plan que no era', by: 'Ana Cajera',
        items: [{ product: '100 Megas', qty: 1, price: 50000 }],
      },
    ));
    expect(m.tipo).toBe('EDICION');
    expect(m.por).toBe('Ana Cajera');
    expect(m.motivo).toBe('Se cobró el plan que no era');
    expect(m.cambios).toContain('Total $45.000 → $50.000');
    expect(m.cambios).toContain('«100 Megas»: 1 × $45.000 → 1 × $50.000');
  });

  it('nunca deja una edición sin explicación en pantalla', () => {
    const m = movimientoDeAuditoria(logEdicion({ total: 45000, items: [] }, { total: 45000, items: [] }));
    expect(m.cambios.length).toBeGreaterThan(0);
  });

  it('lee la anulación por su acción, con los pagos reversados', () => {
    const m = movimientoDeAuditoria({
      id: 'log2', action: 'VOID', createdAt: new Date('2026-09-01T15:00:00Z'),
      before: { status: 'PAID', paidAmount: 50000, voidedPayments: 1 },
      after: { status: 'CANCELED', reason: 'Cobro duplicado', by: 'Ana Cajera' },
    });
    expect(m.tipo).toBe('ANULACION');
    expect(m.motivo).toBe('Cobro duplicado');
    expect(m.cambios).toContain('Se reversaron 1 pago(s) por $50.000');
  });

  it('reconoce la asignación de servicio por su contenido, no por la acción', () => {
    const m = movimientoDeAuditoria(logEdicion(
      { servicios: [{ kind: 'INTERNET', planName: '100 Megas' }] },
      { servicios: [{ kind: 'INTERNET', planName: '300 Megas' }], by: 'Ana Cajera', reason: null },
    ));
    expect(m.tipo).toBe('SERVICIO');
    expect(m.cambios).toEqual(['Servicio: 100 Megas → 300 Megas']);
  });
});

describe('movimientoDeNota', () => {
  it('toma la descripción de la nota como el motivo', () => {
    const m = movimientoDeNota({
      id: 'n1', createdAt: new Date('2026-09-01T15:00:00Z'), productName: 'Nota Credito',
      description: 'Promoción 10% septiembre', price: -5000, autor: 'Ana Cajera',
    });
    expect(m.tipo).toBe('NOTA_CREDITO');
    expect(m.motivo).toBe('Promoción 10% septiembre');
    expect(m.cambios).toEqual(['Rebaja de $5.000 sobre el total']);
  });
});
