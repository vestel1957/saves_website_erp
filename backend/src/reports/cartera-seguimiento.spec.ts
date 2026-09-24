import { clasificar, deudaViejaDe, primerDia, nombreMes } from './cartera-seguimiento';

describe('clasificar (seguimiento de cartera)', () => {
  it('sin plata en el mes es SIN_PAGO, aunque haya cambiado de estado', () => {
    expect(clasificar(0, 90_000, 'CARTERA')).toBe('SIN_PAGO');
    expect(clasificar(0, 0, 'DEPURADO')).toBe('SIN_PAGO');
  });
  it('pagó y se fue: RETIRADO aunque le quede saldo', () => {
    expect(clasificar(60_000, 0, 'RETIRADO')).toBe('RETIRADO');
    expect(clasificar(30_000, 40_000, 'POR_RETIRAR')).toBe('RETIRADO');
  });
  it('le queda deuda VIEJA por encima del umbral: PARCIAL, tenga o no servicio', () => {
    expect(clasificar(40_000, 50_000, 'CARTERA')).toBe('PARCIAL');
    expect(clasificar(30_000, 70_000, 'ACTIVO')).toBe('PARCIAL');
  });
  it('saldó lo viejo y sólo debe la factura del mes: no es PARCIAL', () => {
    // Debía 76.650 el día 1, pagó 136.650, debe 65.000 de la factura nueva.
    expect(clasificar(136_650, deudaViejaDe(76_650, 136_650), 'COMPROMISO')).toBe('ACTIVADO');
  });
  it('al día y con servicio: ACTIVADO (los centavos de un abono no cuentan)', () => {
    expect(clasificar(84_000, 0, 'ACTIVO')).toBe('ACTIVADO');
    expect(clasificar(84_000, 14_400, 'ACTIVO')).toBe('ACTIVADO');
  });
  it('al día pero la ficha sigue en cartera/cortado: PAGO_SIN_ACTIVAR', () => {
    expect(clasificar(96_520, 0, 'CARTERA')).toBe('PAGO_SIN_ACTIVAR');
    expect(clasificar(96_520, 0, 'CORTADO')).toBe('PAGO_SIN_ACTIVAR');
  });
});

describe('deudaViejaDe', () => {
  it('deuda del día 1 menos lo pagado, sin bajar de cero', () => {
    expect(deudaViejaDe(100_000, 40_000)).toBe(60_000);
    expect(deudaViejaDe(76_650, 136_650)).toBe(0);
    expect(deudaViejaDe(50_000, 0)).toBe(50_000);
  });
});

describe('fechas del mes', () => {
  it('primerDia normaliza a YYYY-MM-01', () => {
    expect(primerDia('2026-09')).toBe('2026-09-01');
    expect(primerDia('2026-09-23')).toBe('2026-09-01');
  });
  it('nombreMes', () => expect(nombreMes('2026-09-01')).toBe('Septiembre 2026'));
});
