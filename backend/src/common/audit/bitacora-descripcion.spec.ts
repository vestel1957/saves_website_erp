import { describir, desglosar, fraseSinNombres } from './bitacora-descripcion';

const d = (action: string, after?: unknown, entity = 'x', entityId: string | null = null) =>
  describir({ action, entity, entityId, after });

describe('describir', () => {
  it('cuenta el cobro de ventanilla con monto, método y a quién', () => {
    const r = d('POST /treasury/collect', { amount: 73150, method: 'Cash', invoiceIds: ['a'], subscriberId: 's1', reconectar: true });
    expect(r.frase).toBe('Recibió un pago de $ 73.150 en efectivo por 1 factura y reconectó el servicio');
    expect(r.ref).toEqual({ tipo: 'abonado', id: 's1' });
  });

  it('traduce los estados en vez de soltar el enum', () => {
    expect(d('POST /support/tickets/cmt1/status', { status: 'RESUELTO', lat: 4.8 }).frase)
      .toBe('Pasó la orden a resuelta desde el sitio');
    expect(d('PATCH /subscribers/cmt1/status', { status: 'CORTADO', note: 'no pagó' }).frase)
      .toBe('Cambió el estado del abonado a cortado: “no pagó”');
  });

  it('apunta al registro afectado tomándolo de la ruta', () => {
    expect(d('POST /support/tickets/cmtX/thread', { message: 'listo' }).ref).toEqual({ tipo: 'orden', id: 'cmtX' });
    expect(d('PATCH /billing/invoices/cmtF', {}).ref).toEqual({ tipo: 'factura', id: 'cmtF' });
  });

  it('distingue asignar de desasignar por el cuerpo', () => {
    expect(d('POST /support/tickets/c1/assign', { assigned: 'Ana Ruiz' }).frase).toBe('Asignó la orden a Ana Ruiz');
    expect(d('POST /support/tickets/c1/assign', { assigned: '' }).frase).toBe('Quitó el técnico asignado a la orden');
  });

  it('respeta las acciones que el servicio ya escribió en castellano', () => {
    const r = d('Actualizó los permisos', { activos: 34 }, 'staff-access', 'e1');
    expect(r.frase).toBe('Actualizó los permisos');
    expect(r.ref).toEqual({ tipo: 'empleado', id: 'e1' });
  });

  it('no deja ninguna fila sin frase: hay respaldo por módulo', () => {
    expect(d('POST /modulo-que-no-existe/algo', {}).frase).toBe('Registró un cambio en modulo-que-no-existe (algo)');
    expect(d('LOGIN').frase).toBe('Inició sesión');
  });
});

describe('desglosar', () => {
  it('pone etiquetas en castellano y formatea el dinero', () => {
    expect(desglosar({ amount: 5000, method: 'Cash', status: 'RESUELTO' })).toEqual([
      { etiqueta: 'Monto', valor: '$ 5.000' },
      { etiqueta: 'Método de pago', valor: 'efectivo' },
      { etiqueta: 'Estado', valor: 'resuelta' },
    ]);
  });

  it('no vuelca firmas ni fotos en base64', () => {
    const campos = desglosar({ signature: 'data:image/png;base64,AAAA', foto: 'x'.repeat(500), nota: 'hola' });
    expect(campos).toEqual([{ etiqueta: 'nota', valor: 'hola' }]);
  });
});

describe('nombres pendientes', () => {
  it('deja marcado el técnico del agendamiento para resolverlo en la lista', () => {
    const r = describir({ action: 'POST /support/agenda/mover', entity: 'support/agenda', entityId: null, after: { ticketId: 't1', staffId: 'st1', fecha: '2026-09-07' } });
    expect(r.frase).toBe('Agendó una orden a @{empleado:st1|un técnico} para el 07/09/2026');
    expect(fraseSinNombres(r.frase)).toBe('Agendó una orden a un técnico para el 07/09/2026');
  });
});
