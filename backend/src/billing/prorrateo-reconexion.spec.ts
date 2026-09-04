import { etiquetaProrrateo, valorProrrateado, ventanaProrrateo } from './prorrateo-reconexion';
import {
  esReconexionConArrastre, RECONEXIONES_CON_ARRASTRE, serviciosDeReconexion, tipoConArrastre,
  DETALLES_POR_CLASE,
} from '../support/order-types';

/** Un día concreto, en la misma forma en que lo entrega `hoyEnColombia()`. */
const dia = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('ventanaProrrateo', () => {
  it('cuenta HOY entre los días cobrados', () => {
    // 24 de agosto: quedan del 24 al 31 = 8 días. Es la cuenta del legacy para
    // internet (`$ultimodiames - $fechaActual + 1`), comprobada contra su factura
    // 474962: "100 Megas F-26" a 8 días.
    const v = ventanaProrrateo(dia('2026-08-24'));
    expect(v.dias).toBe(8);
    expect(v.diasDelMes).toBe(31);
    expect(v.hasta.toISOString().slice(0, 10)).toBe('2026-08-31');
  });

  it('el día 1 cobra el mes entero y el último día cobra uno', () => {
    expect(ventanaProrrateo(dia('2026-08-01')).dias).toBe(31);
    expect(ventanaProrrateo(dia('2026-08-31')).dias).toBe(1);
  });

  it('usa los días que tiene CADA mes, no 30 ni 31 fijos', () => {
    expect(ventanaProrrateo(dia('2026-02-10')).diasDelMes).toBe(28);
    expect(ventanaProrrateo(dia('2024-02-10')).diasDelMes).toBe(29); // bisiesto
    expect(ventanaProrrateo(dia('2026-04-10')).diasDelMes).toBe(30);
  });
});

describe('valorProrrateado', () => {
  it('da el mismo peso que el legacy en los casos reales de agosto', () => {
    // Abonado 9903, factura 474966 del legacy: "100 Megas F-26" ($50.500) el 24 de
    // agosto = $13.032. Y abonado 8451, factura 455006: "5MegasV" ($36.000) el 25 =
    // $8.129. Si esta prueba falla, las dos bases dejan de cuadrar al peso y el
    // writeback empieza a mandar totales distintos a los del legacy.
    expect(valorProrrateado(50500, ventanaProrrateo(dia('2026-08-24')))).toBe(13032);
    expect(valorProrrateado(36000, ventanaProrrateo(dia('2026-08-25')))).toBe(8129);
    expect(valorProrrateado(22269, ventanaProrrateo(dia('2026-08-25')))).toBe(5028);
  });

  it('el mes completo es la mensualidad exacta, sin pasar por la división', () => {
    // 77.000/31*31 sale redondo, pero no todos los precios lo hacen: una mensualidad
    // con un peso de más o de menos es una llamada del cliente.
    expect(valorProrrateado(77000, ventanaProrrateo(dia('2026-08-01')))).toBe(77000);
    expect(valorProrrateado(50500, ventanaProrrateo(dia('2026-02-01')))).toBe(50500);
  });

  it('nunca cobra más que la mensualidad ni menos que cero', () => {
    for (const d of ['2026-08-01', '2026-08-15', '2026-08-31', '2026-02-28']) {
      const v = valorProrrateado(50500, ventanaProrrateo(dia(d)));
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(50500);
    }
  });

  it('sin precio no inventa un cobro', () => {
    const v = ventanaProrrateo(dia('2026-08-24'));
    expect(valorProrrateado(0, v)).toBe(0);
    expect(valorProrrateado(-1000, v)).toBe(0);
    expect(valorProrrateado(NaN as unknown as number, v)).toBe(0);
  });
});

describe('etiquetaProrrateo', () => {
  it('dice al cliente qué pedazo de mes está pagando', () => {
    expect(etiquetaProrrateo(ventanaProrrateo(dia('2026-08-24')))).toBe('reconexión 24–31 ago (8 días)');
    expect(etiquetaProrrateo(ventanaProrrateo(dia('2026-08-31')))).toBe('reconexión 31–31 ago (1 día)');
  });
});

describe('tipos de orden con arrastre (el "2" del legacy)', () => {
  it('añade el sufijo sólo a los tres tipos que existen allá', () => {
    expect(tipoConArrastre('Reconexion Internet')).toBe('Reconexion Internet2');
    expect(tipoConArrastre('Reconexion Television')).toBe('Reconexion Television2');
    expect(tipoConArrastre('Reconexion Combo')).toBe('Reconexion Combo2');
    // Un tipo inventado NO se convierte en uno que el legacy no conoce: `detalle`
    // es texto libre allá y crear "Instalacion2" ensuciaría todos sus informes.
    expect(tipoConArrastre('Instalacion')).toBe('Instalacion');
    expect(tipoConArrastre('Revision de Internet')).toBe('Revision de Internet');
  });

  it('es idempotente: no acaba en "Reconexion Internet22"', () => {
    expect(tipoConArrastre('Reconexion Internet2')).toBe('Reconexion Internet2');
  });

  it('los tres tipos están en el catálogo que ofrece la web', () => {
    for (const t of RECONEXIONES_CON_ARRASTRE) {
      expect(DETALLES_POR_CLASE.servicio).toContain(t);
      expect(esReconexionConArrastre(t)).toBe(true);
    }
    expect(esReconexionConArrastre('Reconexion Internet')).toBe(false);
    expect(esReconexionConArrastre(null)).toBe(false);
  });

  it('sabe qué servicio devuelve cada tipo', () => {
    expect(serviciosDeReconexion('Reconexion Internet2')).toEqual(['INTERNET']);
    expect(serviciosDeReconexion('Reconexion Television')).toEqual(['TV']);
    expect(serviciosDeReconexion('Reconexion Combo2')).toEqual(['INTERNET', 'TV']);
    // 'Activacion' no dice qué servicio activa: se piden los dos y decide la ficha.
    expect(serviciosDeReconexion('Activacion')).toEqual(['INTERNET', 'TV']);
    // Lo que no es una reconexión no prorratea nada.
    expect(serviciosDeReconexion('Corte Internet')).toEqual([]);
    expect(serviciosDeReconexion('Instalacion')).toEqual([]);
  });
});
